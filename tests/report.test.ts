import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderText, renderMarkdown, renderJson, exitCode } from '../src/report.js';
import { parseRepo } from '../src/fetch.js';
import type { Config, PullRequest, ReviewOutcome } from '../src/types.js';

const config: Config = {
  checks: { enabled: [], disabled: [], maxPerFile: 50, customRules: [] },
  filter: { maxComments: 10, extensions: ['.ts'], ignorePaths: [], minSeverity: 'info', skipExisting: true },
  lints: [],
  llm: { enabled: false, baseUrl: '', model: 'm', apiKeyEnv: 'K', maxFindingsInPrompt: 10 },
  push: { event: 'COMMENT', body: 'bot' },
  report: { format: 'text' },
};

const pr: PullRequest = {
  number: 7,
  title: 'Demo PR',
  body: null,
  state: 'open',
  draft: false,
  html_url: 'https://github.com/o/r/pull/7',
  user: { login: 'u' },
  base: { sha: 'aaa', ref: 'main' },
  head: { sha: 'bbb', ref: 'feat' },
};

function outcome(overrides?: Partial<ReviewOutcome>): ReviewOutcome {
  return {
    repo: { owner: 'o', repo: 'r', full_name: 'o/r' },
    pr,
    files: [],
    findings: [],
    comments: [],
    skipped: [],
    config,
    stats: {
      filesChanged: 2,
      addedLines: 10,
      removedLines: 3,
      findings: 1,
      bySeverity: { error: 0, warning: 1, info: 0 },
      commentsPushed: 0,
      commentsSkipped: 0,
      llmEnabled: false,
    },
    ...overrides,
  };
}

test('renderText includes summary and comments', () => {
  const text = renderText(outcome({
    comments: [{ file: 'src/a.ts', line: 3, severity: 'error', body: 'bug', rule: 'r', source: 'llm' }],
  }));
  assert.ok(text.includes('o/r #7'));
  assert.ok(text.includes('src/a.ts:3'));
  assert.ok(text.includes('bug'));
  assert.ok(text.includes('+10 -3'));
});

test('renderMarkdown produces links with head ref', () => {
  const md = renderMarkdown(outcome({
    comments: [{ file: 'src/a.ts', line: 3, severity: 'warning', body: 'idea', rule: 'r', source: 'llm' }],
  }));
  assert.ok(md.includes('blob/feat/src/a.ts#L3'));
  assert.ok(md.includes('idea'));
});

test('exitCode reflects error findings and push failure', () => {
  assert.equal(exitCode(outcome()), 0);
  assert.equal(
    exitCode(outcome({ stats: { ...outcome().stats, bySeverity: { error: 1, warning: 0, info: 0 } } })),
    1,
  );
  assert.equal(exitCode(outcome({ push: { ok: false, comments: 0, error: 'boom' } })), 3);
});

test('parseRepo accepts owner/repo and https/git urls', () => {
  assert.equal(parseRepo('a/b').full_name, 'a/b');
  assert.equal(parseRepo('https://github.com/a/b.git').full_name, 'a/b');
  assert.throws(() => parseRepo('not-a-repo'));
});

test('renderJson is parseable and reflects comments/push/stats', () => {
  const json = JSON.parse(
    renderJson(
      outcome({
        comments: [
          { file: 'src/a.ts', line: 3, position: 4, severity: 'error', body: 'bug', rule: 'r', source: 'llm', model: 'gpt-x' },
        ],
        stats: { ...outcome().stats, bySeverity: { error: 1, warning: 0, info: 0 } },
        push: { ok: true, comments: 1, state: 'COMMENT', reviewId: 12, reviewUrl: 'https://github.com/o/r/pull/7#pullrequestreview-12' },
      }),
    ),
  );
  assert.equal(json.ok, false); // error finding present
  assert.equal(json.exitCode, 1);
  assert.equal(json.repo, 'o/r');
  assert.equal(json.pr.number, 7);
  assert.equal(json.comments.length, 1);
  assert.equal(json.comments[0].position, 4);
  assert.equal(json.comments[0].model, 'gpt-x');
  assert.equal(json.push.reviewId, 12);
  assert.equal(json.stats.addedLines, 10);
});