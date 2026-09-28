import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import type { Config, DiffFile, PrComment, PullRequest, RepoRef, Severity, ReviewOutcome } from './types.js';
import { isSeverity } from './types.js';
import { loadConfig, ConfigError } from './config.js';
import { resolveToken, storeToken, logoutToken, hasStoredToken, CONFIG_DIR } from './auth.js';
import { GitHubApi, GitHubApiError, parseRepo } from './fetch.js';
import { parseDiff, countChanges, attachDiffPositions } from './diff.js';
import { runBuiltinChecks, runCustomRules, runExternalLints, listRules } from './check.js';
import {
  SYSTEM_PROMPT,
  resolveLlmEnv,
  resolveModels,
  buildPrompt,
  callLlm,
  parseLlmComments,
  sanitizeLlmComments,
  mergeComments,
  mergeModelComments,
  LlmError,
} from './llm.js';
import { filterComments } from './filter.js';
import { pushReview } from './push.js';
import { renderText, renderJson, exitCode, writeReport } from './report.js';

const execFileAsync = promisify(execFile);

interface CliGlobals {
  repo?: string;
  pr?: number;
  token?: string;
  config?: string;
  dryRun: boolean;
  llm: boolean;
  push: boolean;
  maxComments?: number;
  minSeverity?: string;
  skipExisting?: boolean;
  path?: string[];
  reportOut?: string;
  format?: string;
  json: boolean;
  model?: string;
  models?: string;
}

async function detectRepo(cwd: string): Promise<RepoRef | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    const url = stdout.trim();
    if (!url) return null;
    const match = url.match(/(?:git@|https?:\/\/)[^:/\s]+[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    if (!match) return null;
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) return null;
    return { owner, repo, full_name: `${owner}/${repo}` };
  } catch {
    return null;
  }
}

async function detectPrNumber(cwd: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
    const branch = stdout.trim();
    if (!branch) return undefined;
    const m = branch.match(/^(?:pr\/)?(\d+)$/) ?? branch.match(/\/pr\/(\d+)/);
    if (m) return Number(m[1]);
  } catch {
    return undefined;
  }
  return undefined;
}

async function runReview(g: CliGlobals): Promise<number> {
  const cwd = process.cwd();
  const config: Config = loadConfig(cwd, g.config);
  if (g.format === 'markdown' || g.format === 'text') config.report.format = g.format;

  const repo = g.repo ? parseRepo(g.repo) : ((await detectRepo(cwd)) ?? undefined);
  if (!repo) throw new Error('无法确定目标仓库：请用 --repo owner/repo，或让当前目录属于 git 仓库且具有 origin remote');

  let pr = g.pr;
  if (!pr) {
    const fromBranch = await detectPrNumber(cwd);
    if (fromBranch) {
      pr = fromBranch;
    } else if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_REF) {
      const m = /refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF);
      if (m) pr = Number(m[1]);
    }
  }
  if (!pr) throw new Error('无法确定 PR 编号：请用 --pr <number>，或将当前分支命名为 "123" / "pr/123"，或提供 GITHUB_REF 环境变量');

  const token = await resolveToken(g.token);
  const api = new GitHubApi({ repo, token });
  await api.checkRepo();

  process.stderr.write(`🔄 拉取 PR #${pr}（${repo.full_name}）...\n`);
  const pull: PullRequest = await api.getPullRequest(pr);
  const rawDiff = await api.getDiff(pr);
  const files: DiffFile[] = parseDiff(rawDiff);
  if (files.length === 0) throw new Error('该 PR 没有可解析的变更（或 diff 为空）');

  const { added, removed } = countChanges(files);
  process.stderr.write(`   变更 ${files.length} 个文件（+${added} -${removed} 行）\n`);

  const paths = g.path && g.path.length > 0 ? g.path : undefined;

  process.stderr.write(`🔍 本地 lint/安全检查...\n`);
  const builtin = runBuiltinChecks({ config, files, cwd, paths });
  const custom = runCustomRules({ config, files, cwd, paths });
  const external = await runExternalLints({ config, files, cwd, paths });
  const findings = [...builtin, ...custom, ...external];
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;
  process.stderr.write(`   检查结果 ${findings.length} 条（error:${bySeverity.error} warning:${bySeverity.warning} info:${bySeverity.info}）\n`);

  let comments: ReviewOutcome['comments'] = findings.map((f) => ({
    file: f.file,
    line: f.line,
    severity: f.severity,
    body: f.message,
    rule: f.rule,
    source: f.source,
  }));

  let llmEnabled = false;
  let llmModelsRun: string[] = [];
  if (config.llm.enabled && g.llm) {
    const env = resolveLlmEnv(config);
    if (env) {
      const models = resolveModels(config, g.model, g.models);
      process.stderr.write(`🧠 LLM 生成审查评论（${models.join(', ')}）...\n`);
      const modelSets: Array<Array<{ file: string; line: number; severity: Severity; body: string; model: string }>> = [];
      for (const model of models) {
        try {
          const userPrompt = buildPrompt(pull, files, findings, config);
          const result = await callLlm({ ...env, model }, config.llm.systemPrompt ?? SYSTEM_PROMPT, userPrompt);
          const parsed = parseLlmComments(result.content, new Map(files.map((f) => [f.path, f])));
          const sanitized = sanitizeLlmComments(parsed, files, config.checks.maxPerFile);
          modelSets.push(sanitized.map((c) => ({ ...c, model })));
          llmEnabled = llmEnabled || result.content.length > 0;
          llmModelsRun.push(model);
          process.stderr.write(`   ${model}: 评论 ${sanitized.length} 条\n`);
        } catch (err) {
          process.stderr.write(`   ⚠️ ${model} 调用失败，跳过该模型: ${(err as Error).message}\n`);
        }
      }
      const llmComments = models.length > 1 ? mergeModelComments(modelSets) : (modelSets[0] ?? []);
      comments = mergeComments(llmComments, findings);
    } else {
      process.stderr.write(`   ⚠️ 未配置 ${config.llm.apiKeyEnv}，跳过 LLM（仅本地 lint 评论）\n`);
    }
  }

  const existing: PrComment[] = [];
  const effectiveSkipExisting =
    g.skipExisting === true ? true : g.skipExisting === false ? false : config.filter.skipExisting;
  const filterConfig: Config = {
    ...config,
    filter: {
      ...config.filter,
      minSeverity: g.minSeverity && isSeverity(g.minSeverity) ? g.minSeverity : config.filter.minSeverity,
      skipExisting: effectiveSkipExisting,
    },
  };
  if (effectiveSkipExisting) {
    try {
      existing.push(...(await api.getExistingComments(pr)));
    } catch {
      // 非致命：拉取已有评论失败则继续
    }
  }

  const { kept, skipped } = filterComments(comments, {
    config: filterConfig,
    files,
    existingComments: existing,
    paths,
    forceSkipExisting: g.skipExisting === true ? true : undefined,
  });

  const maxComments = g.maxComments ?? config.filter.maxComments;
  if (maxComments > 0 && kept.length > maxComments) kept.length = maxComments;

  const withPositions = attachDiffPositions(kept, files);

  const dryRun = g.dryRun || !g.push;
  process.stderr.write(`➡️ ${dryRun ? '预览' : '推送'}审查评论（${withPositions.length} 条，另有 ${skipped.length} 条被过滤）\n`);
  if (dryRun) {
    for (const c of withPositions) {
      process.stderr.write(`   ${c.file}:${c.line} [${c.severity}] ${c.body.split('\n')[0]}\n`);
    }
  }

  const outcome: ReviewOutcome = {
    repo,
    pr: pull,
    files,
    findings,
    comments: withPositions,
    skipped,
    config,
    stats: {
      filesChanged: files.length,
      addedLines: added,
      removedLines: removed,
      findings: findings.length,
      bySeverity,
      commentsPushed: 0,
      commentsSkipped: skipped.length,
      llmEnabled,
      llmModels: llmModelsRun,
    },
  };

  if (!dryRun && withPositions.length > 0) {
    const push = await pushReview({
      api,
      prNumber: pr,
      commitId: pull.head.sha,
      comments: withPositions,
      config,
      dryRun,
    });
    outcome.push = push;
    outcome.stats.commentsPushed = push.comments;
    if (push.ok) {
      process.stderr.write(`✅ 已推送 review${push.reviewId ? ` #${push.reviewId}` : ''}（${withPositions.length} 条 inline 评论）\n`);
    } else {
      process.stderr.write(`❌ 推送失败: ${push.error}\n`);
    }
  } else {
    outcome.push = { ok: true, comments: 0, state: 'DRY_RUN' };
  }

  const reportPath = g.reportOut ?? config.report.outPath;
  const written = reportPath ? await writeReport(outcome, reportPath) : null;
  if (written) process.stderr.write(`📄 报告已写入: ${written}\n`);

  process.stdout.write(g.json ? renderJson(outcome) + '\n' : renderText(outcome));
  return exitCode(outcome);
}

function makeProgram(): Command {
  const program = new Command();
  program
    .name('gitreview')
    .description('GitHub 代码审查辅助 CLI：拉取 PR 变更 → 本地 lint/安全检查 → LLM 生成审查评论 → 推送回 GitHub')
    .version('0.1.0');

  program
    .option('-r, --repo <owner/repo>', '目标仓库（默认从 git remote origin 检测）')
    .option('-p, --pr <number>', 'PR 编号（默认从分支名 "123"/"pr/123" 或 CI GITHUB_REF 检测）', parseInt)
    .option('-t, --token <token>', 'GitHub token（默认依次查 GITHUB_TOKEN / ~/.gitreview/config.json / gh auth token）')
    .option('-c, --config <path>', '配置文件路径（默认 gitreview.config.json）')
    .option('--path <path>', '只审查指定路径，可多次使用', collect, [])
    .option('-d, --dry-run', '生成评论并打印，不推送 GitHub')
    .option('--no-llm', '跳过 LLM 评论，仅本地 lint/安全检查')
    .option('--no-push', '别名：--dry-run，只预览不推送')
    .option('--skip-existing', '忽略 GitHub 上已存在的评论（覆盖配置）')
    .option('--no-skip-existing', '不忽略已有评论')
    .option('--max-comments <n>', '最多推送的评论条数（默认读配置 filter.maxComments）', parseInt)
    .option('--min-severity <level>', '最低严重级别：error | warning | info（默认读配置）')
    .option('--report-out <path>', '报告写出路径（默认读配置 report.outPath）')
    .option('--format <text|markdown>', '报告格式（默认 text）')
    .option('--json', '以 JSON 输出机器可读结果（便于 CI 状态检查）')
    .option('--model <name>', 'LLM 模型（覆盖配置 llm.model）')
    .option('--models <a,b,...>', '多模型对比模式：用多个模型各生成一套评论并合并去重')
    .action(async () => {
      const g = program.opts<CliGlobals>();
      try {
        process.exitCode = await runReview(g);
      } catch (err) {
        handleFatal(err);
        process.exitCode = process.exitCode || 2;
      }
    });

  const auth = program.command('auth').description('管理本地 GitHub token（存储在 ~/.gitreview/config.json）');
  auth
    .argument('[token]', '要保存的 token，省略则读取 GITHUB_TOKEN 环境变量')
    .action(async (token?: string) => {
      const value = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!value) {
        process.stderr.write('用法：gitreview auth <token>  （或用 GITHUB_TOKEN 环境变量）\n');
        process.exitCode = 1;
        return;
      }
      try {
        const file = storeToken(value);
        process.stderr.write(`✅ token 已保存到 ${file}（权限 600）\n`);
      } catch (err) {
        handleFatal(err);
        process.exitCode = 2;
      }
    });

  program
    .command('auth-status')
    .description('显示本地 token 配置状态（不泄露 token 内容）')
    .action(() => {
      const stored = hasStoredToken();
      const env = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
      process.stdout.write(`本地存储: ${stored ? '已配置' : '未配置'}（${CONFIG_DIR}\\config.json）\n`);
      process.stdout.write(`环境变量: ${env ? 'GITHUB_TOKEN / GH_TOKEN 已设置' : '未设置'}\n`);
      process.stdout.write('remote:   git@github.com:owner/repo（--repo 未指定时用于推断）\n');
    });

  program
    .command('auth-logout')
    .description('删除本地存储的 token')
    .action(() => {
      logoutToken();
      process.stdout.write('✅ 已删除本地 token\n');
    });

  program
    .command('rules')
    .description('列出内置 lint/安全检查规则')
    .action(() => {
      const rules = listRules();
      process.stdout.write('ID'.padEnd(22) + '严重级别' + ' '.repeat(6) + '说明\n');
      process.stdout.write('─'.repeat(64) + '\n');
      for (const r of rules) {
        process.stdout.write(`${r.id.padEnd(22)}${r.severity.padEnd(11)}${r.describe}\n`);
      }
    });

  return program;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function handleFatal(err: unknown): void {
  if (err instanceof ConfigError) {
    process.stderr.write(`配置错误: ${err.message}\n`);
  } else if (err instanceof GitHubApiError) {
    process.stderr.write(`GitHub 错误: ${err.message}\n`);
  } else if (err instanceof LlmError) {
    process.stderr.write(`LLM 错误: ${err.message}\n`);
  } else {
    process.stderr.write(`错误: ${(err as Error).message}\n`);
  }
  if ((err as Error).stack && process.env.GITREVIEW_DEBUG) process.stderr.write((err as Error).stack + '\n');
}

const program = makeProgram();
await program.parseAsync(process.argv);