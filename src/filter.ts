import type { Config, DiffFile, PrComment, ReviewComment, Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';
import { isAddedLine } from './diff.js';

export interface FilterOptions {
  config: Config;
  files: DiffFile[];
  existingComments: PrComment[];
  paths?: string[];
  forceSkipExisting?: boolean;
}

/**
 * Filter and dedupe review comments:
 * 1. keep comments whose file is in the diff and whose line is an added line
 * 2. drop paths ignored by config (`ignorePaths`) and non-code extensions
 * 3. drop existing GitHub comments (when skipExisting)
 * 4. drop comments below `minSeverity`
 * 5. dedupe by file+line and by normalized body text
 * 6. cap total count
 */
export function filterComments(
  comments: ReviewComment[],
  opts: FilterOptions,
): { kept: ReviewComment[]; skipped: ReviewComment[] } {
  const { config, files, existingComments, paths } = opts;
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const ignoredGlobs = compileGlobs(config.filter.ignorePaths);
  const extSet = new Set(config.filter.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  const minSeverity = config.filter.minSeverity;
  const maxComments = Math.max(0, config.filter.maxComments);
  const skipExisting = opts.forceSkipExisting ?? config.filter.skipExisting;

  const existingKeys = new Set<string>();
  const existingBodies = new Set<string>();
  for (const c of existingComments) {
    if (c.line != null && c.path) existingKeys.add(`${c.path}:${c.line}`);
    if (c.body) existingBodies.add(normalizeText(c.body));
  }

  const kept: ReviewComment[] = [];
  const skipped: ReviewComment[] = [];
  const seenKeys = new Set<string>();
  const seenBodies = new Set<string>();

  const sorted = [...comments].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  for (const c of sorted) {
    const file = fileByPath.get(c.file);
    if (!file) {
      skipped.push(c);
      continue;
    }
    if (!isAddedLine(file, c.line)) {
      skipped.push(c);
      continue;
    }
    if (ignoredGlobs.some((re) => re.test(c.file))) {
      skipped.push(c);
      continue;
    }
    if (!extSet.has(extensionOf(c.file))) {
      skipped.push(c);
      continue;
    }
    if (paths && !paths.some((p) => c.file === p || c.file.startsWith(p.replace(/[\\/]+$/, '') + '/'))) {
      skipped.push(c);
      continue;
    }
    if (SEVERITY_ORDER[c.severity] > SEVERITY_ORDER[minSeverity]) {
      skipped.push(c);
      continue;
    }
    if (skipExisting && (existingKeys.has(`${c.file}:${c.line}`) || existingBodies.has(normalizeText(c.body)))) {
      skipped.push(c);
      continue;
    }

    const key = `${c.file}:${c.line}`;
    if (seenKeys.has(key)) {
      skipped.push(c);
      continue;
    }
    const bodyKey = normalizeText(c.body);
    if (seenBodies.has(bodyKey)) {
      skipped.push(c);
      continue;
    }

    if (maxComments > 0 && kept.length >= maxComments) {
      skipped.push(c);
      continue;
    }

    seenKeys.add(key);
    seenBodies.add(bodyKey);
    kept.push(c);
  }

  return { kept, skipped };
}

function extensionOf(file: string): string {
  const base = file.split('/').pop() ?? file;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[`*_#\-\s]/g, '')
    .trim();
}

function compileGlobs(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    const p = pattern.replace(/\\/g, '/');
    const re = (body: string) =>
      new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
    out.push(re(p));
    // "**/x/**" should also match "x/..." at the repo root
    if (p.startsWith('**/')) out.push(re(p.slice(3)));
  }
  return out;
}

/** Cap the number of comments at the config limit (used before LLM merge too). */
export function capComments(comments: ReviewComment[], max: number): ReviewComment[] {
  if (max <= 0 || comments.length <= max) return comments;
  return comments.slice(0, max);
}