import type { Config, DiffFile, Finding, PullRequest, ReviewComment, Severity } from './types.js';
import { isSeverity } from './types.js';

export class LlmError extends Error {}

export interface LlmEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Resolve LLM credentials from config + environment. */
export function resolveLlmEnv(config: Config): LlmEnv | null {
  const key = process.env[config.llm.apiKeyEnv] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return { apiKey: key, baseUrl: config.llm.baseUrl, model: config.llm.model };
}

/**
 * Resolve the list of models to run, in order of precedence:
 * CLI `--models a,b` > CLI `--model x` > config `llm.models` > config `llm.model`.
 */
export function resolveModels(config: Config, cliModel?: string, cliModels?: string): string[] {
  if (cliModels) {
    const list = cliModels
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  if (cliModel) return [cliModel];
  if (config.llm.models && config.llm.models.length > 0) return [...config.llm.models];
  return [config.llm.model];
}

export const SYSTEM_PROMPT = `你是一名资深代码审查工程师。根据 PR 变更（diff）与本地 lint/安全检查结果，输出精准、可执行的审查评论。
要求：
1. 只针对"新增/变更行"，不要评论未变更的历史代码。
2. 每条评论：一句话指出问题 + 具体可执行建议；错误（bug/安全）比风格建议优先。
3. 严重级别：error（bug/安全/阻塞合并）、warning（潜在问题/强建议）、info（风格/可读性）。
4. 去重：同一文件同一行同类问题只留一条；明显重复的 lint 发现不再复述。
5. 不要回复已有评论，不要输出空话、客套话。
6. 若某个 lint 发现站不住脚，可以舍弃，不要照抄。

输出为 JSON，不要 markdown 代码块，严格按以下结构：
{
  "comments": [
    {
      "file": "src/foo.ts",
      "line": 42,
      "severity": "error | warning | info",
      "body": "评论正文（中文，一句话问题 + 建议）"
    }
  ]
}`;

export interface LlmComment extends ReviewComment {
  source: 'llm';
}

/** Assemble the user message from PR metadata + per-file diffs + findings. */
export function buildPrompt(
  pr: PullRequest,
  files: DiffFile[],
  findings: Finding[],
  config: Config,
): string {
  const cap = config.llm.maxFindingsInPrompt;
  const findingsByFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = findingsByFile.get(f.file) ?? [];
    list.push(f);
    findingsByFile.set(f.file, list);
  }

  const lines: string[] = [];
  lines.push(`PR #${pr.number}（${pr.base.ref} -> ${pr.head.ref}）标题：${pr.title}`);
  if (pr.body?.trim()) lines.push(`描述：${pr.body.trim().slice(0, 400)}`);

  lines.push(`\n变更文件共 ${files.length} 个：`);
  for (const file of files) {
    lines.push(`- ${file.path} [${file.status}]`);
  }

  lines.push('\n===== DIFF（变更行）=====');
  for (const file of files) {
    if (file.binary || file.hunks.length === 0) continue;
    lines.push(`--- ${file.path} ---`);
    for (const hunk of file.hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const l of hunk.lines) {
        if (l.kind === 'add') lines.push(`+${l.newNo}| ${l.text}`);
        else if (l.kind === 'del') lines.push(`-${l.oldNo}| ${l.text}`);
        else lines.push(` ${l.newNo ?? l.oldNo}| ${l.text}`);
      }
    }
  }

  if (findings.length > 0) {
    lines.push('\n===== 本地 lint/安全检查结果 =====');
    let shown = 0;
    for (const f of findings) {
      if (shown >= cap) {
        lines.push(`...（其余 ${findings.length - shown} 条省略）`);
        break;
      }
      lines.push(`[${f.severity}] ${f.file}:${f.line} ${f.message}`);
      shown += 1;
    }
  }

  return lines.join('\n');
}

export interface LlmCallResult {
  content: string;
  raw: string;
  model: string;
  tokens?: { prompt: number; completion: number };
}

/** Call an OpenAI-compatible /chat/completions endpoint (stream off). */
export async function callLlm(
  env: LlmEnv,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const url = `${env.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({
        model: env.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        max_tokens: 3000,
      }),
      signal,
    });
  } catch (err) {
    throw new LlmError(`LLM 请求失败: ${(err as Error).message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`LLM API ${res.status}: ${text.slice(0, 400)}`);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LlmError('LLM 返回了无法解析的内容');
  }

  const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
  const content = (choice?.message as Record<string, unknown>)?.content;
  const usage = json.usage as Record<string, number> | undefined;
  return {
    content: typeof content === 'string' ? content : '',
    raw: text,
    model: typeof json.model === 'string' ? json.model : env.model,
    tokens: usage ? { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 } : undefined,
  };
}

/** Extract a JSON array of comments from the LLM content (tolerates fences). */
export function parseLlmComments(
  content: string,
  validFiles: Map<string, DiffFile>,
): Array<{ file: string; line: number; severity: Severity; body: string }> {
  let text = content.trim();
  const fence = /^```(?:json)?\s*/i.exec(text);
  if (fence) text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const arr = (parsed as Record<string, unknown>)?.comments;
  if (!Array.isArray(arr)) return [];

  const out: Array<{ file: string; line: number; severity: Severity; body: string }> = [];
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const file = typeof it.file === 'string' ? it.file : '';
    const line = typeof it.line === 'number' ? Math.floor(it.line) : NaN;
    const body = typeof it.body === 'string' ? it.body.trim() : '';
    if (!file || !Number.isFinite(line) || line <= 0 || body.length === 0) continue;
    const diffFile = validFiles.get(file) ?? findFileByPath(validFiles, file);
    if (!diffFile) continue;
    const severity = isSeverity(it.severity) ? it.severity : 'warning';
    out.push({ file: diffFile.path, line, severity, body });
  }
  return out;
}

function findFileByPath(map: Map<string, DiffFile>, file: string): DiffFile | undefined {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return map.get(normalized);
}

/** Filter LLM comments to added lines only, then normalize against the diff. */
export function sanitizeLlmComments(
  comments: Array<{ file: string; line: number; severity: Severity; body: string }>,
  files: DiffFile[],
  maxPerFile: number,
): LlmComment[] {
  const byPath = new Map<string, DiffFile>(files.map((f) => [f.path, f]));
  const perFileCount = new Map<string, number>();
  const out: LlmComment[] = [];

  for (const c of comments) {
    const file = byPath.get(c.file);
    if (!file) continue;
    if (file.status === 'deleted' || file.binary) continue;
    const added = new Set<number>();
    for (const hunk of file.hunks) for (const l of hunk.lines) if (l.kind === 'add' && l.newNo != null) added.add(l.newNo);
    if (!added.has(c.line)) continue;
    const count = perFileCount.get(c.file) ?? 0;
    if (count >= maxPerFile) continue;
    perFileCount.set(c.file, count + 1);
    out.push({ file: c.file, line: c.line, severity: c.severity, body: c.body, rule: 'llm', source: 'llm' });
  }
  return out;
}

/**
 * Merge lint/security findings with LLM comments. When an LLM comment shares a
 * file+line with a lint finding, the LLM insight is appended as context instead
 * of posting two comments on the same line; other lines keep both.
 */
export function mergeComments(
  llmComments: Array<{ file: string; line: number; severity: Severity; body: string }>,
  findings: Finding[],
): ReviewComment[] {
  const merged: ReviewComment[] = [];
  const byKey = new Map<string, ReviewComment[]>();

  for (const f of findings) {
    const c: ReviewComment = {
      file: f.file,
      line: f.line,
      severity: f.severity,
      body: f.message,
      rule: f.rule,
      source: f.source,
    };
    merged.push(c);
    pushByKey(byKey, keyOf(c.file, c.line), c);
  }

  for (const l of llmComments) {
    const key = keyOf(l.file, l.line);
    const existing = byKey.get(key);
    if (existing && existing.length > 0) {
      const primary = existing[0]!;
      if (primary.source !== 'llm' && !primary.body.includes(l.body)) {
        primary.body = `${primary.body}\n\n> LLM：${l.body}`;
      }
      continue;
    }
    const c: ReviewComment = { ...l, rule: 'llm', source: 'llm' };
    merged.push(c);
    pushByKey(byKey, key, c);
  }

  return merged;
}

function pushByKey(map: Map<string, ReviewComment[]>, key: string, c: ReviewComment): void {
  const list = map.get(key) ?? [];
  list.push(c);
  map.set(key, list);
}

function keyOf(file: string, line: number): string {
  return `${file}:${line}`;
}

/**
 * Merge comment sets from multiple LLM models (compare mode):
 * - same file+line from several models → one comment, other models' bodies
 *   appended as `> [model]: ...` paragraphs;
 * - identical (file+line+body) across models → kept once.
 * Each comment gets `model` attribution.
 */
export function mergeModelComments(
  sets: Array<Array<{ file: string; line: number; severity: Severity; body: string; model?: string }>>,
): ReviewComment[] {
  const byKey = new Map<string, ReviewComment[]>();
  const byBody = new Map<string, ReviewComment[]>();
  const out: ReviewComment[] = [];

  const emit = (c: ReviewComment) => {
    out.push(c);
    const key = keyOf(c.file, c.line);
    const bodyKey = normalizeKey(c.body);
    (byKey.get(key) ?? pushMap(byKey, key, [])).push(c);
    (byBody.get(bodyKey) ?? pushMap(byBody, bodyKey, [])).push(c);
  };

  for (const set of sets) {
    for (const raw of set) {
      const key = keyOf(raw.file, raw.line);
      const bodyKey = normalizeKey(raw.body);
      const sameLine = byKey.get(key);
      const sameBody = byBody.get(bodyKey);

      if (sameLine && sameLine.length > 0) {
        const primary = sameLine[0]!;
        const modelTag = raw.model ?? '';
        if (primary.body !== raw.body) {
          primary.body = `${primary.body}\n\n> [${modelTag || 'other'}]: ${raw.body}`;
        }
        continue;
      }
      if (sameBody && sameBody.length > 0 && sameBody[0]!.model !== raw.model) {
        // identical body from another model on a different line — skip as duplicate
        continue;
      }
      emit({
        file: raw.file,
        line: raw.line,
        severity: raw.severity,
        body: raw.body,
        rule: 'llm',
        source: 'llm',
        model: raw.model ?? undefined,
      });
    }
  }

  return out;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[`*_#\-\s]/g, '').trim();
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V[]): V[] {
  map.set(key, value);
  return value;
}