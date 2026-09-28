import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, isAddedLine, changedNewLines, countChanges, newFileContentLines, diffPositionOfLine, addedLinePositions, attachDiffPositions } from '../src/diff.js';

const SAMPLE = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcde 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,6 +1,7 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
+const d = 5;
 function hi() {
   return a + b;
 }

diff --git a/src/util.py b/src/util.py
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/util.py
@@ -0,0 +1,3 @@
+import os
+
+TOKEN = os.environ["X"]
`;

test('parseDiff extracts two files', () => {
  const files = parseDiff(SAMPLE);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, 'src/index.ts');
  assert.equal(files[0]!.status, 'modified');
  assert.equal(files[1]!.path, 'src/util.py');
  assert.equal(files[1]!.status, 'added');
});

test('parseDiff maps new line numbers', () => {
  const [f] = parseDiff(SAMPLE);
  const added = [...changedNewLines(f!)].sort((a, b) => a - b);
  assert.deepEqual(added, [2, 4]);
  assert.equal(isAddedLine(f!, 2), true);
  assert.equal(isAddedLine(f!, 3), false); // context
  assert.equal(isAddedLine(f!, 1), false);
});

test('countChanges counts added/removed', () => {
  const files = parseDiff(SAMPLE);
  const { added, removed } = countChanges(files);
  assert.equal(added, 5);
  assert.equal(removed, 1);
});

test('newFileContentLines reconstructs right side', () => {
  const [f] = parseDiff(SAMPLE);
  const lines = newFileContentLines(f!);
  assert.equal(lines[0], 'const a = 1;');
  assert.equal(lines[1], 'const b = 3;');
  assert.equal(lines[3], 'const d = 5;');
});

test('parseDiff ignores binary files without hunks', () => {
  const raw = `diff --git a/logo.png b/logo.png
index 0000000..1111111
Binary files differ
`;
  const files = parseDiff(raw);
  assert.equal(files.length, 0);
});

test('parseDiff marks deleted files with old path', () => {
  const raw = `diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
index 123..456 100644
--- a/src/gone.js
+++ /dev/null
@@ -1,3 +0,0 @@
-const gone = 1;
-const away = 2;
-const bye = 3;
`;
  const [f] = parseDiff(raw);
  assert.equal(f!.status, 'deleted');
  assert.equal(f!.path, 'src/gone.js');
  assert.equal(f!.oldPath, 'src/gone.js');
});

test('parseDiff marks added files from /dev/null', () => {
  const raw = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..123
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+import x from 'y';
+export default x;
`;
  const [f] = parseDiff(raw);
  assert.equal(f!.status, 'added');
  assert.equal(f!.path, 'src/new.ts');
});

test('diffPositionOfLine returns cumulative 1-based diff offset', () => {
  const raw = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
ctx1
-del1
+add2
ctx3
+add4
ctx5
`;
  const [f] = parseDiff(raw);
  assert.equal(diffPositionOfLine(f!, 2), 3); // ctx1=1, del1=2, add2=3
  assert.equal(diffPositionOfLine(f!, 4), 5); // ...ctx3=4, add4=5
  assert.equal(diffPositionOfLine(f!, 3), 4); // context line
  assert.equal(diffPositionOfLine(f!, 99), null);
  const positions = addedLinePositions(f!);
  assert.equal(positions.get(2), 3);
  assert.equal(positions.get(4), 5);
});

test('attachDiffPositions annotates comments with position', () => {
  const raw = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
+new line
 ctx
 ctx
`;
  const files = parseDiff(raw);
  const comments = [{ file: 'src/a.ts', line: 1, severity: 'warning' as const, body: 'x' }];
  const withPos = attachDiffPositions(comments, files);
  assert.equal(withPos[0]!.position, 1);
});
