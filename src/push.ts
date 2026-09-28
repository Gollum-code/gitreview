import type { Config, PushResult, ReviewComment } from './types.js';
import { GitHubApi, GitHubApiError } from './fetch.js';

export interface PushInput {
  api: GitHubApi;
  prNumber: number;
  commitId: string;
  comments: ReviewComment[];
  config: Config;
  dryRun: boolean;
}

/**
 * Submit all comments as one GitHub review with inline comments.
 * - side: RIGHT (comments on the new file)
 * - subject_type: line (ignored by server when unsupported)
 * - secondary-rate-limit (403 + Retry-After) handled inside GitHubApi.
 */
export async function pushReview(input: PushInput): Promise<PushResult> {
  const { api, prNumber, commitId, comments, config, dryRun } = input;

  if (comments.length === 0) {
    return { ok: true, comments: 0, state: 'COMMENT' };
  }

  const payload = {
    commit_id: commitId,
    event: config.push.event,
    body: config.push.body,
    comments: buildCommentPayload(comments, config.push.position === true),
  };

  if (dryRun) {
    return { ok: true, comments: comments.length, state: 'DRY_RUN' };
  }  if (!api.token) {
    throw new GitHubApiError('未提供 GitHub token，无法推送评论（可用 --dry-run 仅预览，或用 --token / GITHUB_TOKEN）', 401);
  }

  try {
    const review = await api.submitReview(prNumber, payload);
    return {
      ok: true,
      reviewId: review.id,
      reviewUrl: review.html_url,
      state: review.state ?? config.push.event,
      comments: comments.length,
    };
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return { ok: false, comments: 0, error: err.message, state: config.push.event };
    }
    return { ok: false, comments: 0, error: (err as Error).message, state: config.push.event };
  }
}

/** Build the per-comment GitHub payload: `line`+`side` (modern) or legacy `position`. */
function buildCommentPayload(
  comments: ReviewComment[],
  usePosition: boolean,
): Array<{ path: string; line?: number; side?: string; position?: number; body: string }> {
  return comments.map((c) => {
    if (usePosition && c.position != null) {
      return { path: c.file, position: c.position, body: c.body };
    }
    return { path: c.file, line: c.line, side: 'RIGHT', body: c.body };
  });
}