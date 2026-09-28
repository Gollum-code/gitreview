import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config, CustomRule, LintTask, Severity } from './types.js';

const DEFAULTS: Config = {
  checks: {
    enabled: ['secret', 'debug', 'todo', 'dangerous', 'sql-injection', 'trailing'],
    disabled: [],
    maxPerFile: 50,
    customRules: [],
  },
  filter: {
    maxComments: 50,
    extensions: [
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
      '.rb', '.php', '.sh', '.kt', '.swift', '.cs', '.vue', '.svelte',
    ],
    ignorePaths: [
      '**/dist/**', '**/build/**', '**/vendor/**', '**/node_modules/**',
      '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
      '**/*.min.js', '**/*.min.css', '**/*.map',
    ],
    minSeverity: 'info',
    skipExisting: true,
  },
  lints: [],
  llm: {
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    maxFindingsInPrompt: 60,
    systemPrompt: undefined,
  },
  push: {
    event: 'COMMENT',
    body: '🤖 gitreview 自动审查结果',
    position: false,
  },
  report: {
    format: 'text',
    outPath: undefined,
  },
};

export const CONFIG_FILES = ['gitreview.config.json', '.gitreview.json', 'gitreview.config.jsonc'];

export class ConfigError extends Error {}

export function parseSeverity(value: unknown, fallback: Severity): Severity {
  if (value === 'error' || value === 'warning' || value === 'info') return value;
  return fallback;
}

function parseConfigText(text: string, file: string): Partial<Config> {
  if (file.endsWith('.jsonc')) {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    return JSON.parse(stripped) as Partial<Config>;
  }
  return JSON.parse(text) as Partial<Config>;
}

export function mergeConfig(base: Config, patch: unknown): Config {
  if (patch === null || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;

  const checks = { ...base.checks };
  const filter = { ...base.filter };
  const lints = Array.isArray(p.lints) ? (p.lints as LintTask[]) : base.lints;
  const llm = { ...base.llm };
  const push = { ...base.push };
  const report = { ...base.report };

  const obj = <T>(v: unknown, fallback: T): T => (v !== null && typeof v === 'object' ? (v as T) : fallback);

  Object.assign(checks, obj(p.checks, {}));
  Object.assign(filter, obj(p.filter, {}));
  Object.assign(llm, obj(p.llm, {}));
  Object.assign(push, obj(p.push, {}));
  Object.assign(report, obj(p.report, {}));

  if (!Array.isArray(checks.enabled) || checks.enabled.length === 0) checks.enabled = [...DEFAULTS.checks.enabled];
  if (!Array.isArray(filter.extensions) || filter.extensions.length === 0) filter.extensions = [...DEFAULTS.filter.extensions];
  if (!Array.isArray(filter.ignorePaths)) filter.ignorePaths = [...DEFAULTS.filter.ignorePaths];
  if (typeof filter.maxComments !== 'number') filter.maxComments = DEFAULTS.filter.maxComments;
  filter.minSeverity = parseSeverity(filter.minSeverity, DEFAULTS.filter.minSeverity);
  if (typeof checks.maxPerFile !== 'number') checks.maxPerFile = DEFAULTS.checks.maxPerFile;
  if (typeof llm.maxFindingsInPrompt !== 'number') llm.maxFindingsInPrompt = DEFAULTS.llm.maxFindingsInPrompt;
  if (typeof llm.enabled !== 'boolean') llm.enabled = DEFAULTS.llm.enabled;
  if (typeof push.position !== 'boolean') push.position = DEFAULTS.push.position;

  const pChecks = p.checks as Record<string, unknown> | undefined;
  if (Array.isArray(pChecks?.customRules)) checks.customRules = normalizeCustomRules(pChecks.customRules);
  const pLlm = p.llm as Record<string, unknown> | undefined;
  if (Array.isArray(pLlm?.models) && pLlm.models.length > 0) llm.models = [...pLlm.models];

  return { checks, filter, lints, llm, push, report };
}

function normalizeCustomRules(raw: unknown[]): CustomRule[] {
  const out: CustomRule[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue;
    const rule = r as Record<string, unknown>;
    const id = typeof rule.id === 'string' && rule.id.trim() ? rule.id.trim() : undefined;
    const pattern = typeof rule.pattern === 'string' && rule.pattern.trim() ? rule.pattern : undefined;
    const message = typeof rule.message === 'string' ? rule.message : undefined;
    if (!id || !pattern || !message) continue;
    out.push({
      id,
      severity: parseSeverity(rule.severity, 'warning'),
      pattern,
      message,
      flags: typeof rule.flags === 'string' ? rule.flags : undefined,
      extensions: Array.isArray(rule.extensions) ? rule.extensions.map(String) : undefined,
    });
  }
  return out;
}

/**
 * Load config by merging (later wins):
 * 1. built-in defaults
 * 2. user config: ~/.gitreview/config.json
 * 3. project config: <cwd>/gitreview.config.json (or .gitreview.json / .jsonc)
 * 4. an explicit config file passed by the caller
 */
export function loadConfig(cwd: string, explicitPath?: string): Config {
  let cfg = DEFAULTS;

  const userPath = path.join(os.homedir(), '.gitreview', 'config.json');
  if (existsSync(userPath)) {
    cfg = mergeConfig(cfg, readJsonOrThrow(userPath));
  }

  const candidates = explicitPath
    ? [explicitPath]
    : CONFIG_FILES.map((f) => path.join(cwd, f)).filter((f) => existsSync(f));

  for (const file of candidates) {
    if (!existsSync(file)) throw new ConfigError(`配置文件不存在: ${file}`);
    const text = readFileSync(file, 'utf8');
    cfg = mergeConfig(cfg, parseConfigText(text, file));
  }

  return cfg;
}

function readJsonOrThrow(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`无法解析配置文件 ${file}: ${(err as Error).message}`);
  }
}
