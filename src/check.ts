import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Config, CustomRule, DiffFile, Finding, LintTask, Severity } from './types.js';
import { newFileContentLines, addedNewLines } from './diff.js';

export interface CheckOptions {
  config: Config;
  files: DiffFile[];
  cwd: string;
  /** keep only findings on added lines */
  onlyAdded?: boolean;
  /** additional paths filter (e.g. --path src/lib) */
  paths?: string[];
}

export type RuleFn = (text: string, line: number, source: string) => Finding[];

interface Rule {
  id: string;
  severity: Severity;
  describe: string;
  test: (source: string, lineNo: number, text: string, filePath: string) => string | null;
}

const RULES: Rule[] = [
  {
    id: 'secret',
    severity: 'error',
    describe: '疑似密钥/凭据硬编码',
    test: (source, lineNo, text, filePath) => {
      void source;
      void filePath;
      const t = text.trim();
      if (/['"](sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})['"]/.test(t)) {
        return '检测到疑似 API 密钥/令牌格式';
      }
      if (/(password|passwd|pwd|secret|token|api[-_]?key|api_key|access[-_]?key)['"]?\s*[:=]\s*['"][^'"]{10,}['"]/i.test(t)) {
        return '疑似在代码中硬编码凭据，应从环境变量/密钥管理读取';
      }
      if (/-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/.test(t)) {
        return '检测到私钥内容，严禁提交到代码库';
      }
      return null;
    },
  },
  {
    id: 'debug',
    severity: 'warning',
    describe: '调试输出残留',
    test: (source, lineNo, text, filePath) => {
      const ext = path.extname(filePath);
      const inCode = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'].includes(ext);
      if (!inCode) return null;
      void source;
      void lineNo;
      const t = text.trim();
      if (/^console\.(log|debug|info|dir)\s*\(/.test(t)) return '调试输出（console.log/debug/info）不应留在变更里';
      if (ext === '.py' && (/^print\s*\(/.test(t) || /^pprint\./.test(t))) return '调试输出（print）不应留在变更里';
      if (ext === '.go' && /^fmt\.Print/.test(t)) return '调试输出（fmt.Print）不应留在变更里';
      if (ext === '.rs' && /^println!|^dbg!|^eprintln!/.test(t)) return '调试输出（println!/dbg!）不应留在变更里';
      return null;
    },
  },
  {
    id: 'todo',
    severity: 'info',
    describe: '遗留 TODO/FIXME',
    test: (source, lineNo, text, filePath) => {
      void source;
      void lineNo;
      void filePath;
      const m = /(TODO|FIXME|XXX|HACK)\b[:\-]?\s*(.*)$/.exec(text);
      if (!m) return null;
      const rest = m[2]?.trim();
      return `遗留标记 ${m[1]}${rest ? `：${rest}` : ''}，发布前请确认`;
    },
  },
  {
    id: 'dangerous',
    severity: 'error',
    describe: '危险执行/注入',
    test: (source, lineNo, text, filePath) => {
      const ext = path.extname(filePath);
      const inCode = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java'].includes(ext);
      if (!inCode) return null;
      void source;
      void lineNo;
      const t = text.trim();
      if (/\beval\s*\(/.test(t)) return 'eval() 有代码注入风险，应避免';
      if (/new\s+Function\s*\(/.test(t)) return 'new Function() 有代码注入风险，应避免';
      if (/child_process\.(exec|execSync|spawn|spawnSync)\s*\([^)]*\$\{/.test(t)) return 'shell 命令拼接了外部输入，有命令注入风险';
      if (/innerHTML\s*=\s*[^'"`\d]|document\.write\s*\(/.test(t)) return 'innerHTML/document.write 拼接不可信输入有 XSS 风险';
      if (/\.exec(ute)?\s*\([^)]*\$\{/.test(t) && /sql|query/.test(t.toLowerCase())) return 'SQL 字符串拼接外部输入，有注入风险';
      return null;
    },
  },
  {
    id: 'sql-injection',
    severity: 'error',
    describe: 'SQL 拼接',
    test: (source, lineNo, text, filePath) => {
      void source;
      void lineNo;
      void filePath;
      const t = text.toUpperCase();
      if (/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(t) && (/\$\{/.test(text) || /["'`]\s*\+/.test(text) || /%\s*\(/.test(text))) {
        return '检测到 SQL 语句拼接外部值，请改用参数化查询';
      }
      return null;
    },
  },
  {
    id: 'trailing',
    severity: 'info',
    describe: '行尾空白',
    test: (source, lineNo, text, filePath) => {
      void source;
      void lineNo;
      void filePath;
      if (/[ \t]+$/.test(text)) return '行尾存在多余空白';
      return null;
    },
  },
];

export function listRules(): Array<{ id: string; severity: Severity; describe: string }> {
  return RULES.map(({ id, severity, describe }) => ({ id, severity, describe }));
}

/** Run all enabled built-in rules over the changed files' added lines. */
export function runBuiltinChecks(opts: CheckOptions): Finding[] {
  const { config, files, paths } = opts;
  const enabled = new Set(config.checks.enabled);
  const disabled = new Set(config.checks.disabled);
  const findings: Finding[] = [];

  for (const file of files) {
    if (file.binary || file.status === 'deleted') continue;
    if (paths && !paths.some((p) => file.path === p || file.path.startsWith(p.replace(/[\\/]+$/, '') + '/'))) continue;

    const content = newFileContentLines(file);
    const added = addedNewLines(file);
    const perFile: Finding[] = [];
    let ruleHits = 0;

    for (const rule of RULES) {
      if (!enabled.has(rule.id) || disabled.has(rule.id)) continue;
      const lines = added.size > 0 ? [...added].sort((a, b) => a - b) : [];
      for (const lineNo of lines) {
        if (ruleHits >= config.checks.maxPerFile) break;
        const text = lineNo <= content.length ? content[lineNo - 1] ?? '' : '';
        if (!text) continue;
        const message = rule.test('', lineNo, text, file.path);
        if (message) {
          perFile.push({
            file: file.path,
            line: lineNo,
            severity: rule.severity,
            rule: rule.id,
            message,
            source: rule.id === 'secret' ? 'security' : 'lint',
          });
          ruleHits += 1;
        }
      }
    }

    findings.push(...perFile);
  }
  return findings;
}

export interface ExternalLintResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/**
 * Run user-defined regex rules from config (`checks.customRules`) against the
 * added lines of each changed file. No code changes required to add a rule.
 */
export function runCustomRules(opts: CheckOptions): Finding[] {
  const { config, files, paths } = opts;
  const rules = config.checks.customRules ?? [];
  if (rules.length === 0) return [];
  const findings: Finding[] = [];

  for (const file of files) {
    if (file.binary || file.status === 'deleted') continue;
    if (paths && !paths.some((p) => file.path === p || file.path.startsWith(p.replace(/[\\/]+$/, '') + '/'))) continue;

    const content = newFileContentLines(file);
    const added = [...addedNewLines(file)].sort((a, b) => a - b);
    let hits = 0;

    for (const rule of rules) {
      if (hits >= config.checks.maxPerFile) break;
      const re = compileCustomRule(rule);
      if (!re) continue;
      if (rule.extensions && rule.extensions.length > 0 && !rule.extensions.includes(path.extname(file.path))) continue;

      for (const lineNo of added) {
        if (hits >= config.checks.maxPerFile) break;
        const text = lineNo <= content.length ? content[lineNo - 1] ?? '' : '';
        if (!text) continue;
        if (!re.test(text)) continue;
        findings.push({
          file: file.path,
          line: lineNo,
          severity: rule.severity,
          rule: rule.id,
          message: rule.message,
          source: 'lint',
        });
        hits += 1;
      }
    }
  }
  return findings;
}

function compileCustomRule(rule: CustomRule): RegExp | null {
  try {
    return new RegExp(rule.pattern, rule.flags ?? '');
  } catch {
    return null;
  }
}

export function runCommand(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<ExternalLintResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout, stderr, code: -1, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: 127, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut: false });
    });
  });
}

const ESLINT_RE = /^(.+?):(\d+):(\d+):\s+(.+)$/;
const SIMPLE_RE = /^(.+?):(\d+):\s+(.+)$/;

/**
 * Run external lint hooks from config (`lints`). The command receives the matched
 * changed files (placeholder `{files}` or appended args). Output lines matching
 * `path:line:col: message` (eslint) or `path:line: message` become findings.
 */
export async function runExternalLints(opts: CheckOptions): Promise<Finding[]> {
  const { config, files, cwd, paths } = opts;
  const tasks = (config.lints ?? []).filter((t) => isTaskConfigured(t));
  const findings: Finding[] = [];

  for (const task of tasks) {
    const matched = files
      .filter((f) => f.status !== 'deleted' && matchesTask(f.path, task))
      .filter((f) => !paths || paths.some((p) => f.path === p || f.path.startsWith(p.replace(/[\\/]+$/, '') + '/')))
      .map((f) => f.path);

    if (matched.length === 0) continue;

    const [cmd, ...rest] = tokenizeCommand(task.command);
    if (!cmd) continue;
    const args = rest.map((a) => (a === '{files}' ? matched.join(' ') : a));
    const hasFilesPlaceholder = rest.includes('{files}') || args.includes(matched.join(' '));
    const finalArgs = hasFilesPlaceholder ? args : [...args, ...matched];

    const res = await runCommand(cmd, finalArgs, cwd, task.timeoutMs ?? 60_000);
    const output = `${res.stdout}\n${res.stderr}`;
    for (const line of output.split(/\r?\n/)) {
      const f = parseLintLine(line, matched);
      if (!f) continue;
      findings.push(f);
    }
    if (task.required && res.code !== 0 && !res.timedOut) {
      for (const f of findings.filter((x) => x.source === 'lint')) {
        // surfaced as-is; required lint failure is also reported at CLI level
      }
    }
  }
  return findings;
}

function isTaskConfigured(task: LintTask): boolean {
  return typeof task.command === 'string' && task.command.trim().length > 0;
}

function matchesTask(filePath: string, task: LintTask): boolean {
  const ext = path.extname(filePath);
  if (task.extensions && task.extensions.length > 0 && !task.extensions.includes(ext)) return false;
  if (task.match) {
    const glob = task.match.replace(/\*\*/g, '(?:.*)').replace(/\*/g, '[^/]*');
    const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`);
    // eslint-disable-next-line no-useless-escape
    if (!re.test(filePath.replace(/\\/g, '/'))) return false;
  }
  return true;
}

function parseLintLine(line: string, matchedFiles: string[]): Finding | null {
  const eslint = ESLINT_RE.exec(line);
  if (eslint) {
    const [, file, lineNo, , message] = eslint;
    return {
      file: file!.replace(/\\/g, '/').replace(/^\.\//, ''),
      line: Number(lineNo),
      severity: severityFromMessage(message ?? ''),
      rule: 'external-lint',
      message: message ?? '',
      source: 'lint',
    };
  }
  const simple = SIMPLE_RE.exec(line);
  if (simple) {
    const [, file, lineNo, message] = simple;
    const cleanFile = file!.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!matchedFiles.some((m) => m === cleanFile || m.endsWith('/' + cleanFile))) return null;
    return {
      file: cleanFile,
      line: Number(lineNo),
      severity: severityFromMessage(message ?? ''),
      rule: 'external-lint',
      message: message ?? '',
      source: 'lint',
    };
  }
  return null;
}

function severityFromMessage(message: string): Severity {
  if (/error/i.test(message)) return 'error';
  if (/warn|warning/i.test(message)) return 'warning';
  return 'info';
}

function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}