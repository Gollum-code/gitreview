import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const CONFIG_DIR = path.join(os.homedir(), '.gitreview');

export function configFilePath(): string {
  return path.join(CONFIG_DIR, 'config.json');
}

export interface StoredAuth {
  token?: string;
  username?: string;
  host?: string;
}

/** Stored token on disk (never logged to console). */
export function readStoredToken(): string | undefined {
  try {
    const file = configFilePath();
    if (!existsSync(file)) return undefined;
    const data = JSON.parse(readFileSync(file, 'utf8')) as StoredAuth;
    return typeof data.token === 'string' && data.token.length > 0 ? data.token : undefined;
  } catch {
    return undefined;
  }
}

/** Token resolution order: flag > env (GITHUB_TOKEN / GH_TOKEN) > stored file > `gh auth token`. */
export async function resolveToken(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  const stored = readStoredToken();
  if (stored) return stored;
  return ghAuthToken();
}

function ghAuthToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 5000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const token = out.trim();
      resolve(code === 0 && token.length > 0 && err.length === 0 ? token : undefined);
    });
  });
}

/** `gitreview auth login` — persist the token locally with owner-only permissions. */
export function storeToken(token: string, meta?: Partial<StoredAuth>): string {
  if (!/^[A-Za-z0-9_]{20,}$/.test(token)) {
    throw new Error('token 看起来不像有效的 GitHub token（长度 >= 20 的字母数字串）');
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current: StoredAuth = readStoredJson();
  const next: StoredAuth = { ...current, ...(meta ?? {}), token };
  const file = configFilePath();
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function logoutToken(): void {
  if (!existsSync(configFilePath())) return;
  const current: StoredAuth = readStoredJson();
  delete current.token;
  writeFileSync(configFilePath(), JSON.stringify(current, null, 2) + '\n');
}

export function hasStoredToken(): boolean {
  return readStoredToken() !== undefined;
}

function readStoredJson(): StoredAuth {
  try {
    const file = configFilePath();
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) as StoredAuth;
  } catch {
    return {};
  }
}