import type { ReviewOutcome, Severity } from './types.js';

export interface ReportFile {
  content: string;
  ext: 'txt' | 'md';
}

export function renderReport(outcome: ReviewOutcome): ReportFile {
  return outcome.config?.report.format === 'markdown'
    ? { content: renderMarkdown(outcome), ext: 'md' }
    : { content: renderText(outcome), ext: 'txt' };
}

/** Machine-readable JSON for CI status checks (`--json`). */
export function renderJson(outcome: ReviewOutcome): string {
  const ok =
    !(outcome.push && !outcome.push.ok) &&
    outcome.stats.bySeverity.error === 0 &&
    !outcome.pr.draft;
  const files = outcome.files.map((f) => ({
    path: f.path,
    status: f.status,
    binary: f.binary,
    hunks: f.hunks.length,
  }));
  return JSON.stringify(
    {
      ok,
      exitCode: exitCode(outcome),
      repo: outcome.repo.full_name,
      pr: {
        number: outcome.pr.number,
        title: outcome.pr.title,
        state: outcome.pr.state,
        draft: outcome.pr.draft,
        html_url: outcome.pr.html_url,
        base: outcome.pr.base.ref,
        head: outcome.pr.head.ref,
        head_sha: outcome.pr.head.sha,
      },
      files,
      findings: outcome.findings.map((f) => ({
        file: f.file,
        line: f.line,
        severity: f.severity,
        rule: f.rule,
        message: f.message,
        source: f.source,
      })),
      comments: outcome.comments.map((c) => ({
        file: c.file,
        line: c.line,
        position: c.position ?? null,
        severity: c.severity,
        source: c.source,
        model: c.model ?? null,
        body: c.body,
      })),
      skipped: outcome.skipped.length,
      push: outcome.push
        ? {
            ok: outcome.push.ok,
            state: outcome.push.state,
            reviewId: outcome.push.reviewId ?? null,
            reviewUrl: outcome.push.reviewUrl ?? null,
            comments: outcome.push.comments,
            error: outcome.push.error ?? null,
          }
        : null,
      stats: outcome.stats,
    },
    null,
    2,
  );
}

function lineRule(s: string, n = 60): string {
  return s.repeat(Math.max(1, n));
}

export function renderText(o: ReviewOutcome): string {
  const lines: string[] = [];
  const s = o.stats;
  lines.push(lineRule('='));
  lines.push(`gitreview 审查报告 — ${o.repo.full_name} #${o.pr.number}`);
  lines.push(`「${o.pr.title}」`);
  lines.push(lineRule('='));
  lines.push('');
  lines.push(`PR:      ${o.pr.html_url}`);
  lines.push(`状态:    ${o.pr.state}${o.pr.draft ? '（draft）' : ''}  分支 ${o.pr.base.ref} -> ${o.pr.head.ref}`);
  lines.push(`变更:    ${s.filesChanged} 文件 / +${s.addedLines} -${s.removedLines} 行`);
  lines.push(`检查:    lint+安全 findings ${s.findings} 条（error:${s.bySeverity.error} warning:${s.bySeverity.warning} info:${s.bySeverity.info}）`);
  lines.push(`评论:    推送 ${s.commentsPushed} / 跳过 ${s.commentsSkipped}   LLM: ${s.llmEnabled ? '启用' : '未启用'}`);
  if (o.push) {
    lines.push(`推送:    ${o.push.ok ? (o.push.state === 'DRY_RUN' ? 'DRY-RUN（未实际推送）' : `OK review#${o.push.reviewId}`) : `失败: ${o.push.error}`}`);
    if (o.push.reviewUrl) lines.push(`链接:    ${o.push.reviewUrl}`);
  }
  lines.push('');
  lines.push(lineRule('-'));
  lines.push('审查评论');
  lines.push(lineRule('-'));
  lines.push('');

  const comments = [...o.comments].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (comments.length === 0) {
    lines.push('（无待推送评论）');
  }
  for (const c of comments) {
    const sourceTag = c.model ? `${c.source}:${c.model}` : c.source;
    lines.push(`  [${tag(c.severity)}] ${c.file}:${c.line}  (${sourceTag})`);
    lines.push(`      ${c.body.replace(/\n/g, '\n      ')}`);
    lines.push('');
  }
  lines.push(lineRule('-'));
  return lines.join('\n') + '\n';
}

function tag(sev: Severity): string {
  return sev === 'error' ? '!!' : sev === 'warning' ? '!' : 'i';
}

export function renderMarkdown(o: ReviewOutcome): string {
  const s = o.stats;
  const lines: string[] = [];
  lines.push(`# gitreview 审查报告`);
  lines.push('');
  lines.push(`**${o.repo.full_name}** · PR [**#${o.pr.number} ${o.pr.title}**](${o.pr.html_url}) · ${o.pr.base.ref} -> ${o.pr.head.ref}`);
  lines.push('');
  lines.push(`| 变更 | 检查 | 评论 | LLM |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| ${s.filesChanged} 文件 / +${s.addedLines} -${s.removedLines} | findings ${s.findings} | 推送 ${s.commentsPushed} / 跳过 ${s.commentsSkipped} | ${s.llmEnabled ? '启用' : '未启用'} |`);
  lines.push('');
  lines.push(`## 评论`);
  lines.push('');
  if (o.comments.length === 0) lines.push('（无待推送评论）');
  for (const c of [...o.comments].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const sourceTag = c.model ? `${c.source} (${c.model})` : c.source;
    lines.push(`- **${o.repo.owner}/${o.repo.repo}/blob/${o.pr.head.ref}/${c.file}#L${c.line}** — *${c.severity}* · ${sourceTag}`);
    lines.push(`  ${c.body.replace(/\n/g, '\n  ')}`);
    lines.push('');
  }
  if (o.push) {
    lines.push(`## 推送结果`);
    lines.push('');
    lines.push(`- ${o.push.ok ? (o.push.state === 'DRY_RUN' ? 'DRY-RUN（未实际推送）' : `已创建 review ${o.push.reviewId} ` + (o.push.reviewUrl ? `[链接](${o.push.reviewUrl})` : '')) : `失败：${o.push.error}`}`);
  }
  return lines.join('\n');
}

export function exitCode(outcome: ReviewOutcome): number {
  if (outcome.push && !outcome.push.ok) return 3;
  if (outcome.stats.bySeverity.error > 0) return 1;
  return 0;
}

export async function writeReport(
  outcome: ReviewOutcome,
  outPath?: string,
): Promise<string | null> {
  const report = renderReport(outcome);
  const target = outPath ?? outcome.config?.report.outPath;
  if (!target) return null;
  const resolved = target.endsWith(`.${report.ext}`) ? target : `${target}.${report.ext}`;
  await import('node:fs/promises').then((fs) => fs.writeFile(resolved, report.content, 'utf8'));
  return resolved;
}