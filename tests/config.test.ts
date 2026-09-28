import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, mergeConfig, ConfigError } from '../src/config.js';
import type { Config } from '../src/types.js';

test('loadConfig picks up project config file and merges with defaults', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gr-cfg-'));
  try {
    writeFileSync(path.join(dir, 'gitreview.config.json'), JSON.stringify({ filter: { maxComments: 3 } }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.filter.maxComments, 3);
    assert.equal(cfg.checks.maxPerFile, 50); // default kept
    assert.equal(cfg.push.event, 'COMMENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig throws for missing explicit config', () => {
  assert.throws(() => loadConfig(process.cwd(), path.join(os.tmpdir(), 'nope-123.json')), ConfigError);
});

test('mergeConfig tolerates partial/null patches', () => {
  const base = loadConfig(path.join(process.cwd(), '..'));
  const merged = mergeConfig(base, { filter: null });
  assert.equal(merged.filter.maxComments, base.filter.maxComments);
  const cfg2 = mergeConfig(base, undefined);
  assert.equal(cfg2, base);
});

test('mergeConfig keeps enabled rules when patch empties them', () => {
  const base = loadConfig(process.cwd());
  const cfg = mergeConfig(base, { checks: { enabled: [] } });
  assert.ok(cfg.checks.enabled.length > 0);
});

test('default config satisfies the shape', () => {
  const cfg = loadConfig(process.cwd());
  const expect: Config = cfg;
  assert.ok(Array.isArray(expect.checks.enabled));
  assert.ok(expect.filter.extensions.length > 0);
  assert.ok(typeof expect.llm.model === 'string');
  assert.ok(['COMMENT', 'REQUEST_CHANGES', 'APPROVE'].includes(expect.push.event));
});