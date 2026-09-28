import type { PrComment, PrFileStat, PrReview, PullRequest, RepoRef } from './types.js';

const API_BASE = 'https://api.github.com';
const UA = 'gitreview/0.1';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean = false,
  ) {
    super(message);
  }
}

interface Options {
  repo: RepoRef;
  token?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class GitHubApi {
  readonly repo: RepoRef;
  readonly token?: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: Options) {
    this.repo = opts.repo;
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? process.env.GITHUB_API_URL ?? API_BASE).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private headers(accept: string, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': UA,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
    attempts = 3,
  ): Promise<{ data: T; rateRemaining: number; rateLimit: number }> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(accept, ...(body !== undefined ? [{ 'Content-Type': 'application/json' }] : [])),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });

      const rateRemaining = Number(res.headers.get('x-ratelimit-remaining') ?? -1);
      const rateLimit = Number(res.headers.get('x-ratelimit-limit') ?? 0);

      if (res.status === 403 && rateRemaining === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000 - Date.now();
        const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000;
        const wait = Math.max(0, Math.min(retryAfter || 60_000, reset > 0 ? reset : 60_000));
        throw new GitHubApiError(`GitHub 限流（剩余 0 请求），请在 ${Math.round(wait / 1000)} 秒后重试`, 403, true);
      }

      const text = await res.text();
      if (!res.ok) {
        if ((res.status === 429 || res.status === 403) && attempts > 1) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 1) * 1000;
          await sleep(Math.max(1000, retryAfter));
          return this.request<T>(method, path, body, accept, attempts - 1);
        }
        throw new GitHubApiError(`GitHub API ${res.status}: ${method} ${path}\n${text.slice(0, 500)}`, res.status);
      }

      if (text.length === 0) {
        return { data: undefined as T, rateRemaining, rateLimit };
      }

      try {
        return { data: JSON.parse(text) as T, rateRemaining, rateLimit };
      } catch {
        return { data: text as unknown as T, rateRemaining, rateLimit };
      }
    } catch (err) {
      if (err instanceof GitHubApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new GitHubApiError(`请求超时（${this.timeoutMs}ms）: ${method} ${path}`, 0);
      }
      throw new GitHubApiError(`网络请求失败: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /repos/{owner}/{repo}/pulls/{n} */
  async getPullRequest(number: number): Promise<PullRequest> {
    const raw = await this.request<Record<string, unknown>>('GET', `/repos/${this.repo.full_name}/pulls/${number}`);
    return normalizePr(raw.data);
  }

  /** GET /repos/{owner}/{repo}/pulls/{n}.diff  (raw unified diff) */
  async getDiff(number: number): Promise<string> {
    const res = await this.request<string>(
      'GET',
      `/repos/${this.repo.full_name}/pulls/${number}`,
      undefined,
      'application/vnd.github.v3.diff',
    );
    return String(res.data ?? '');
  }

  /** GET /repos/{owner}/{repo}/pulls/{n}/files  (paginated) */
  async getChangedFiles(number: number): Promise<PrFileStat[]> {
    const files: PrFileStat[] = [];
    let page = 1;
    for (;;) {
      const res = await this.request<PrFileStat[]>(
        'GET',
        `/repos/${this.repo.full_name}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      files.push(...res.data);
      if (res.data.length < 100) break;
      page += 1;
    }
    return files;
  }

  /** GET /repos/{owner}/{repo}/pulls/{n}/comments  (existing inline comments, to dedupe) */
  async getExistingComments(number: number): Promise<PrComment[]> {
    const out: PrComment[] = [];
    let page = 1;
    for (;;) {
      const res = await this.request<PrComment[]>(
        'GET',
        `/repos/${this.repo.full_name}/pulls/${number}/comments?per_page=100&page=${page}`,
      );
      out.push(...res.data);
      if (res.data.length < 100) break;
      page += 1;
    }
    return out;
  }

  /** GET /repos/{owner}/{repo}/pulls/{n}/reviews */
  async getReviews(number: number): Promise<PrReview[]> {
    const res = await this.request<PrReview[]>(
      'GET',
      `/repos/${this.repo.full_name}/pulls/${number}/reviews?per_page=100`,
    );
    return res.data;
  }

  /** POST /repos/{owner}/{repo}/pulls/{n}/reviews — one review with inline comments */
  async submitReview(
    number: number,
    payload: {
      commit_id: string;
      event: string;
      body: string;
      comments: Array<{ path: string; line?: number; side?: string; position?: number; body: string }>;
    },
  ): Promise<{ id: number; html_url?: string; state?: string }> {
    const res = await this.request<{ id: number; html_url?: string; state?: string }>(
      'POST',
      `/repos/${this.repo.full_name}/pulls/${number}/reviews`,
      payload,
      'application/vnd.github+json',
      4,
    );
    return res.data;
  }

  /** GET /repos/{owner}/{repo} — validate the repo exists / is reachable */
  async checkRepo(): Promise<void> {
    await this.request<unknown>('GET', `/repos/${this.repo.full_name}`);
  }
}

function normalizePr(raw: Record<string, unknown>): PullRequest {
  const head = (raw.head ?? {}) as Record<string, unknown>;
  const base = (raw.base ?? {}) as Record<string, unknown>;
  return {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ''),
    body: typeof raw.body === 'string' ? raw.body : null,
    state: String(raw.state ?? ''),
    draft: Boolean(raw.draft),
    html_url: String(raw.html_url ?? ''),
    user: (raw.user as PullRequest['user']) ?? null,
    base: { sha: String(base.sha ?? ''), ref: String(base.ref ?? '') },
    head: { sha: String(head.sha ?? ''), ref: String(head.ref ?? '') },
    additions: typeof raw.additions === 'number' ? raw.additions : undefined,
    deletions: typeof raw.deletions === 'number' ? raw.deletions : undefined,
    changed_files: typeof raw.changed_files === 'number' ? raw.changed_files : undefined,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRepo(repoInput: string): RepoRef {
  const clean = repoInput.trim().replace(/\.git$/, '').replace(/[\/\\]+$/, '');
  const match = clean.match(/([^\/:]+)\/([^\/:]+)$/);
  if (!match) throw new Error(`无法解析 repo: "${repoInput}"，应为 owner/repo 形式`);
  const owner = match[1]!;
  const repo = match[2]!;
  return { owner, repo, full_name: `${owner}/${repo}` };
}