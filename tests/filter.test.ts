import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, loadConfig } from '../src/config.js';
import { filterComments } from '../src/filter.js';
import { mergeComments } from '../src/llm.js';
import type { Config, DiffFile, Finding, ReviewComment } from '../src/types.js';

function baseConfig(): Config {
  return {
    checks: { enabled: ['secret', 'debug', 'todo', 'dangerous', 'sql-injection', 'trailing'], disabled: [], maxPerFile: 50, customRules: [] },
    filter: {
      maxComments: 100,
      extensions: ['.ts', '.py', '.go'],
      ignorePaths: ['**/dist/**'],
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
}

function diffFile(path: string, addedLines: number[]): DiffFile {
  const start = addedLines[0] ?? 1;
  return {
    oldPath: path,
    newPath: path,
    path,
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: start,
        oldLines: 5,
        newStart: start,
        newLines: 5,
        header: '',
        lines: Array.from({ length: 5 }, (_, i) => {
          const n = start + i;
          return { kind: addedLines.includes(n) ? 'add' : 'ctx', oldNo: n, newNo: n, text: `line ${n}` };
        }),
      },
    ],
  };
}

test('mergeConfig merges nested objects', () => {
  const cfg = baseConfig();
  const merged = mergeConfig(cfg, { filter: { maxComments: 7 }, llm: { model: 'm1' }, checks: { enabled: ['secret'] } });
  assert.equal(merged.filter.maxComments, 7);
  assert.equal(merged.llm.model, 'm1');
  assert.equal(merged.filter.minSeverity, 'info');
  assert.equal(merged.push.event, 'COMMENT');
});

test('filterComments keeps added lines and drops context', () => {
  const cfg = baseConfig();
  const files = [diffFile('src/a.ts', [1, 2])];
  const comments: ReviewComment[] = [
    { file: 'src/a.ts', line: 1, severity: 'error', body: 'secret detected', rule: 'secret', source: 'security' },
    { file: 'src/a.ts', line: 3, severity: 'warning', body: 'context line comment', rule: 'demo', source: 'llm' },
  ];
  const { kept, skipped } = filterComments(comments, { config: cfg, files, existingComments: [] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.line, 1);
  assert.equal(skipped.length, 1);
});

test('filterComments drops non-code extensions and ignored paths', () => {
  const cfg = baseConfig();
  const files = [diffFile('src/a.ts', [1]), diffFile('src/a.txt', [1]), diffFile('dist/b.ts', [1])];
  const comments: ReviewComment[] = [
    { file: 'src/a.ts', line: 1, severity: 'warning', body: 'fine', rule: 'a', source: 'lint' },
    { file: 'src/a.txt', line: 1, severity: 'warning', body: 'not code', rule: 'a', source: 'lint' },
    { file: 'dist/b.ts', line: 1, severity: 'warning', body: 'ignored path', rule: 'a', source: 'lint' },
  ];
  const { kept } = filterComments(comments, { config: cfg, files, existingComments: [] });
  assert.deepEqual(kept.map((c) => c.file), ['src/a.ts']);
});

test('filterComments skips existing comments by path+line', () => {
  const cfg = baseConfig();
  const files = [diffFile('src/a.ts', [1])];
  const comments: ReviewComment[] = [
    { file: 'src/a.ts', line: 1, severity: 'error', body: 'dup', rule: 'x', source: 'lint' },
  ];
  const { kept } = filterComments(comments, {
    config: cfg,
    files,
    existingComments: [{ id: 1, path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'someone said this', user: null }],
  });
  assert.equal(kept.length, 0);
});

test('filterComments dedupes by normalized body', () => {
  const cfg = baseConfig();
  const files = [diffFile('src/a.ts', [1, 2])];
  const comments: ReviewComment[] = [
    { file: 'src/a.ts', line: 1, severity: 'warning', body: '使用 TMP', rule: 'a', source: 'llm' },
    { file: 'src/a.ts', line: 2, severity: 'warning', body: '使用 tmp', rule: 'b', source: 'llm' },
  ];
  const { kept } = filterComments(comments, { config: cfg, files, existingComments: [] });
  assert.equal(kept.length, 1);
});

test('mergeComments merges findings and llm comments, keeps both on distinct lines', () => {
  const findings: Finding[] = [
    { file: 'a.ts', line: 1, severity: 'error', rule: 'secret', message: 'hardcoded', source: 'security' },
  ];
  const llm: ReviewComment[] = [
    { file: 'a.ts', line: 1, severity: 'warning', rule: 'llm', body: '另外建议拆函数', source: 'llm' },
    { file: 'a.ts', line: 4, severity: 'info', rule: 'llm', body: '命名建议', source: 'llm' },
  ];
  const merged = mergeComments(llm, findings);
  assert.equal(merged.length, 2);
  const onLine1 = merged.find((c) => c.line === 1);
  assert.ok(onLine1!.body.includes('另外建议拆函数'));
});