import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBuiltinChecks, runCustomRules, listRules } from '../src/check.js';
import { parseLlmComments, sanitizeLlmComments, mergeComments, mergeModelComments, resolveModels } from '../src/llm.js';
import { mergeConfig } from '../src/config.js';
import type { Config, DiffFile } from '../src/types.js';

function cfg(overrides?: Partial<Config>): Config {
  const base: Config = {
    checks: { enabled: ['secret', 'debug', 'todo', 'dangerous', 'sql-injection', 'trailing'], disabled: [], maxPerFile: 50, customRules: [] },
    filter: {
      maxComments: 100,
      extensions: ['.ts', '.py'],
      ignorePaths: [],
      minSeverity: 'info',
      skipExisting: true,
    },
    lints: [],
    llm: {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKeyEnv: 'OPENAI_API_KEY',
      maxFindingsInPrompt: 60,
    },
    push: { event: 'COMMENT', body: 'bot' },
    report: { format: 'text' },
  };
  return overrides ? mergeConfig(base, overrides) : base;
}

function file(path: string, contents: Array<[number, string, ('add' | 'ctx')?]>): DiffFile {
  return {
    oldPath: path,
    newPath: path,
    path,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: contents.length,
        newStart: 1,
        newLines: contents.length,
        header: '',
        lines: contents.map(([n, text, kind]) => ({
          kind: kind ?? 'add',
          oldNo: kind === 'ctx' ? n : null,
          newNo: n,
          text,
        })),
      },
    ],
  };
}

test('builtin rules catch secret, debug, todo', () => {
  const files = [
    file('src/a.ts', [
      [1, 'const apiKey = "sk-1234567890abcdefghijklmnop";'],
      [2, 'console.log(apiKey);'],
      [3, '// TODO: fix this'],
    ]),
  ];
  const findings = runBuiltinChecks({ config: cfg(), files, cwd: process.cwd() });
  const rules = new Set(findings.map((f) => f.rule));
  assert.ok(rules.has('secret'));
  assert.ok(rules.has('debug'));
  assert.ok(rules.has('todo'));
  assert.ok(findings.some((f) => f.severity === 'error'));
});

test('builtin rules detect dangerous eval / sql concat', () => {
  const files = [
    file('src/a.ts', [
      [1, 'eval(userInput);'],
      [2, `db.query("SELECT * FROM t WHERE id = " + req.params.id);`],
    ]),
  ];
  const findings = runBuiltinChecks({ config: cfg(), files, cwd: process.cwd() });
  assert.ok(findings.some((f) => f.rule === 'dangerous'));
  assert.ok(findings.some((f) => f.rule === 'sql-injection'));
});

test('disabled rules are skipped', () => {
  const files = [file('src/a.ts', [[1, 'console.log("x");']])];
  const config = cfg();
  config.checks.disabled = ['debug'];
  const findings = runBuiltinChecks({ config, files, cwd: process.cwd() });
  assert.equal(findings.length, 0);
});

test('rules list is non-empty and well-formed', () => {
  const rules = listRules();
  assert.ok(rules.length > 0);
  for (const r of rules) {
    assert.ok(r.id.length > 0);
    assert.ok(['error', 'warning', 'info'].includes(r.severity));
  }
});

test('parseLlmComments tolerates markdown fences', () => {
  const content = '```json\n{"comments":[{"file":"src/a.ts","line":3,"severity":"warning","body":"建议改法"}]}\n```';
  const diff = new Map([['src/a.ts', file('src/a.ts', [[3, 'x']])]]);
  const comments = parseLlmComments(content, diff);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.file, 'src/a.ts');
  assert.equal(comments[0]!.line, 3);
});

test('parseLlmComments drops unknown files and bad lines', () => {
  const content = '{"comments":[' +
    '{"file":"nope.ts","line":1,"severity":"error","body":"x"},' +
    '{"file":"src/a.ts","line":0,"severity":"error","body":"x"},' +
    '{"file":"src/a.ts","line":3,"severity":"error","body":"ok"}]}';
  const diff = new Map([['src/a.ts', file('src/a.ts', [[3, 'x']])]]);
  const comments = parseLlmComments(content, diff);
  assert.equal(comments.length, 1);
});

test('sanitizeLlmComments keeps only added lines', () => {
  const f = file('src/a.ts', [[3, 'added', 'add'], [4, 'context', 'ctx']]);
  const files = [f];
  const raw = [
    { file: 'src/a.ts', line: 3, severity: 'warning' as const, body: 'good' },
    { file: 'src/a.ts', line: 4, severity: 'warning' as const, body: 'bad context' },
  ];
  const out = sanitizeLlmComments(raw, files, 50);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.line, 3);
});

test('custom rules fire on added lines and respect extensions', () => {
  const config = cfg();
  config.checks.customRules = [
    { id: 'no-broad-catch', severity: 'warning', pattern: 'catch\\s*\\(\\s*\\)', message: '空 catch', extensions: ['.ts'] },
  ];
  const files = [
    file('src/a.ts', [[1, 'try {} catch () { /* ignore */ }']]),
    file('src/b.py', [[1, 'try:\n']]),
  ];
  const findings = runCustomRules({ config, files, cwd: process.cwd() });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.file, 'src/a.ts');
  assert.equal(findings[0]!.rule, 'no-broad-catch');
});

test('custom rules skip bad regex silently', () => {
  const config = cfg();
  config.checks.customRules = [{ id: 'broken', severity: 'error', pattern: '([unclosed', message: 'x' }];
  const files = [file('src/a.ts', [[1, 'abc']])];
  const findings = runCustomRules({ config, files, cwd: process.cwd() });
  assert.equal(findings.length, 0);
});

test('resolveModels precedence: cli models > cli model > config models > config model', () => {
  const c = cfg();
  c.llm.models = ['m1', 'm2'];
  assert.deepEqual(resolveModels(c), ['m1', 'm2']);
  assert.deepEqual(resolveModels(c, 'single'), ['single']);
  assert.deepEqual(resolveModels(c, 'single', 'a, b'), ['a', 'b']);
});

test('mergeModelComments merges same line across models with attribution', () => {
  const setA = [
    { file: 'a.ts', line: 1, severity: 'warning' as const, body: '问题', model: 'gpt-x' },
    { file: 'a.ts', line: 5, severity: 'error' as const, body: 'only in A', model: 'gpt-x' },
  ];
  const setB = [
    { file: 'a.ts', line: 1, severity: 'warning' as const, body: '另一个角度', model: 'claude-y' },
    { file: 'a.ts', line: 5, severity: 'error' as const, body: 'only in A', model: 'claude-y' },
  ];
  const merged = mergeModelComments([setA, setB]);
  assert.equal(merged.length, 2);
  const line1 = merged.find((c) => c.line === 1)!;
  assert.ok(line1.body.includes('问题'));
  assert.ok(line1.body.includes('另一个角度'));
  assert.equal(line1.model, 'gpt-x');
  const line5 = merged.find((c) => c.line === 5)!;
  assert.equal(line5.body, 'only in A');
});