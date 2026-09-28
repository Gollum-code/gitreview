export type Severity = 'error' | 'warning' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function isSeverity(value: unknown): value is Severity {
  return value === 'error' || value === 'warning' || value === 'info';
}

export interface RepoRef {
  owner: string;
  repo: string;
  full_name: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  html_url: string;
  user: { login: string } | null;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
}

export interface PrFileStat {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface PrComment {
  id: number;
  path: string;
  line: number | null;
  side: string | null;
  body: string;
  user: { login: string } | null;
  in_reply_to_id?: number;
}

export interface PrReview {
  id: number;
  state: string;
  body: string;
  user: { login: string } | null;
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unknown';

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  path: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  rule: string;
  message: string;
  source: 'lint' | 'security' | 'llm';
  detail?: string;
}

export interface ReviewComment {
  file: string;
  line: number;
  severity: Severity;
  body: string;
  rule: string;
  source: Finding['source'];
  /** optional: 1-based offset of the line within the file's unified diff */
  position?: number;
  /** optional: generating LLM model (multi-model/compare mode) */
  model?: string;
}

export interface PushResult {
  ok: boolean;
  reviewId?: number;
  reviewUrl?: string;
  state?: string;
  comments: number;
  error?: string;
  retries?: number;
}

/** Custom regex rule defined in config — no code changes required. */
export interface CustomRule {
  id: string;
  severity: Severity;
  /** JS regular expression source, tested against each added line */
  pattern: string;
  message: string;
  /** regex flags, e.g. "i" */
  flags?: string;
  /** restrict to these extensions; empty means all code files */
  extensions?: string[];
}

export interface LintTask {
  /** glob-like match on the file path, e.g. "src/**\/*.ts" */
  match?: string;
  /** file extensions handled by this task, e.g. [".ts", ".tsx"] */
  extensions?: string[];
  /** command to execute; "{files}" placeholder is replaced by the matched files */
  command: string;
  /** fail the whole check when the command exits non-zero */
  required?: boolean;
  /** how many ms to wait before killing the command */
  timeoutMs?: number;
}

export interface Config {
  checks: {
    enabled: string[];
    disabled: string[];
    maxPerFile: number;
    customRules: CustomRule[];
  };
  filter: {
    maxComments: number;
    extensions: string[];
    ignorePaths: string[];
    minSeverity: Severity;
    skipExisting: boolean;
  };
  lints: LintTask[];
  llm: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    maxFindingsInPrompt: number;
    systemPrompt?: string;
    /** multiple models for compare mode; empty = single model */
    models?: string[];
  };
  push: {
    event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
    body: string;
    /** when true, post legacy diff `position` instead of `line`+`side` */
    position?: boolean;
  };
  report: {
    format: 'text' | 'markdown';
    outPath?: string;
  };
}

export interface ReviewOptions {
  repo?: string;
  pr: number;
  token?: string;
  dryRun: boolean;
  maxComments?: number;
  noLlm: boolean;
  noPush: boolean;
  skipExisting?: boolean;
  paths?: string[];
  reportOut?: string;
  format?: 'text' | 'markdown';
  cwd: string;
}

export interface ReviewOutcome {
  repo: RepoRef;
  pr: PullRequest;
  files: DiffFile[];
  findings: Finding[];
  comments: ReviewComment[];
  skipped: ReviewComment[];
  push?: PushResult;
  config: Config;
  stats: {
    filesChanged: number;
    addedLines: number;
    removedLines: number;
    findings: number;
    bySeverity: Record<Severity, number>;
    commentsPushed: number;
    commentsSkipped: number;
    llmEnabled: boolean;
    llmModels?: string[];
  };
}
