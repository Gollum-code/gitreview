import type { DiffFile, DiffHunk, DiffLine, DiffFileStatus } from './types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (as returned by GET /pulls/{n} with .diff accept header)
 * into structured files/hunks/lines with mapped old/new line numbers.
 */
export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const pendingRenamed = new Set<string>();

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line);
      const oldPath = paths ? (paths[1] ?? null) : null;
      current = {
        oldPath,
        newPath: oldPath,
        path: oldPath ?? 'unknown',
        status: oldPath ? pendingRenamed.has(oldPath) ? 'renamed' : 'modified' : 'unknown',
        binary: false,
        hunks: [],
      };
      hunk = null;
      files.push(current);
      pendingRenamed.delete(oldPath ?? '');
      continue;
    }

    if (!current) continue;

    if (line === '\\ No newline at end of file') continue;
    if (line === 'Binary files differ' || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      current.oldPath = parseHeaderPath(line.slice(4));
      // '--- /dev/null' => added file
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.newPath = parseHeaderPath(line.slice(4));
      const np = current.newPath;
      if (np === '/dev/null') {
        // deletion: right side is empty; keep the old path and status
        current.path = current.oldPath ?? current.path;
        current.status = 'deleted';
      } else if (np) {
        current.path = np;
        if (current.oldPath == null || current.oldPath === '/dev/null') current.status = 'added';
        else if (current.oldPath !== np) current.status = 'renamed';
      }
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      pendingRenamed.add(current.oldPath);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length);
      current.path = current.newPath;
      continue;
    }
    if (line.startsWith('similarity index')) continue;
    if (line.startsWith('index ')) continue;
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      const oldLines = hunkMatch[2] ? Number(hunkMatch[2]) : 1;
      const newLines = hunkMatch[4] ? Number(hunkMatch[4]) : 1;
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines,
        newStart: Number(hunkMatch[3]),
        newLines,
        header: line,
        lines: [],
      };
      current.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }

    if (!hunk) continue;

    const pfx = line.charAt(0);
    let kind: DiffLine['kind'] = 'ctx';
    if (pfx === '+') kind = 'add';
    else if (pfx === '-') kind = 'del';

    if (kind === 'del') {
      hunk.lines.push({ kind, oldNo, newNo: null, text: line.slice(1) });
      oldNo += 1;
    } else if (kind === 'add') {
      hunk.lines.push({ kind, oldNo: null, newNo, text: line.slice(1) });
      newNo += 1;
    } else {
      hunk.lines.push({ kind, oldNo, newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
  }

  return files.filter((f) => !f.binary && f.hunks.length > 0);
}

function parseHeaderPath(value: string): string | null {
  const v = value.trim();
  if (v === '/dev/null') return '/dev/null';
  // strip optional leading "a/" / "b/" and quotes
  return v.replace(/^"?(?:a|b)\/"?/, '').replace(/\t.*$/, '').replace(/^"|"$/g, '');
}

/** All new-file line numbers touched by a file's hunks (added + context lines on the right side). */
export function changedNewLines(file: DiffFile): Set<number> {
  const out = new Set<number>();
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add' && l.newNo != null) out.add(l.newNo);
    }
  }
  return out;
}

/** New-file line numbers that are added lines only (not context). */
export function addedNewLines(file: DiffFile): Set<number> {
  const out = new Set<number>();
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add' && l.newNo != null) out.add(l.newNo);
    }
  }
  return out;
}

/** Map a new-file line number to the diff position (offset within hunk, 1-based) if it exists. */
export function newLineToDiffPosition(file: DiffFile, newLine: number): number | null {
  for (const hunk of file.hunks) {
    const first = hunk.lines.findIndex((l) => l.newNo != null);
    if (first === -1) {
      // purely deletion hunk
      continue;
    }
    const newPart = hunk.lines
      .map((l, i) => ({ l, i }))
      .filter((x) => x.l.newNo != null);
    for (const x of newPart) {
      if (x.l.newNo === newLine) return x.i + 1;
    }
  }
  return null;
}

/**
 * 1-based offset of `newLine` within the file's unified diff — the legacy
 * `position` GitHub accepts for review comments. Counts ALL patch lines
 * (context + added + deleted) cumulatively across hunks (hunk headers excluded),
 * mirroring GitHub's position semantics. `null` when the line isn't in the diff.
 */
export function diffPositionOfLine(file: DiffFile, newLine: number): number | null {
  let position = 1;
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add' && l.newNo === newLine) return position;
      if (l.kind === 'ctx' && l.newNo === newLine) return position;
      position += 1;
    }
  }
  return null;
}

/** Position of every added line in the diff, keyed by new-file line number. */
export function addedLinePositions(file: DiffFile): Map<number, number> {
  const out = new Map<number, number>();
  let position = 1;
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add' && l.newNo != null) out.set(l.newNo, position);
      position += 1;
    }
  }
  return out;
}

/** Attach the legacy diff `position` to every comment (null when line not in diff). */
export function attachDiffPositions<T extends { file: string; line: number }>(
  comments: T[],
  files: DiffFile[],
): Array<T & { position?: number }> {
  const posByFile = new Map<string, Map<number, number>>();
  for (const f of files) posByFile.set(f.path, addedLinePositions(f));
  return comments.map((c) => {
    const pos = posByFile.get(c.file)?.get(c.line);
    return pos != null ? { ...c, position: pos } : c;
  });
}

/** True when `newLine` is inside the right-side line range and is an added line. */
export function isAddedLine(file: DiffFile, newLine: number): boolean {
  for (const hunk of file.hunks) {
    if (newLine >= hunk.newStart && newLine < hunk.newStart + hunk.newLines) {
      for (const l of hunk.lines) {
        if (l.kind === 'add' && l.newNo === newLine) return true;
      }
      return false;
    }
  }
  return false;
}

/** Total added/removed line counts across all files. */
export function countChanges(files: DiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (l.kind === 'add') added += 1;
        else if (l.kind === 'del') removed += 1;
      }
    }
  }
  return { added, removed };
}

/** Right-side file content reconstructed from the diff (blank for lines not present). */
export function newFileContentLines(file: DiffFile): string[] {
  const map: Map<number, string> = new Map();
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.newNo != null) map.set(l.newNo, l.text);
    }
  }
  const max = Math.max(0, ...map.keys());
  const out: string[] = new Array(max).fill('');
  for (const [n, text] of map) out[n - 1] = text;
  return out;
}

export function fileKind(file: DiffFile): DiffFileStatus {
  return file.status;
}