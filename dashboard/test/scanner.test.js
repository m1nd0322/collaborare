'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { scanKnowledgeDirectory } = require('../lib/scanner');
const {
  conversationMarkdown,
  createTestDirectory,
  removeTestDirectory,
} = require('../test-support/helpers');

test('scanner reports add, update, and delete while ignoring temporary files', async (t) => {
  const rootPath = await createTestDirectory('scanner-diff');
  t.after(() => removeTestDirectory(rootPath));

  const dayPath = path.join(rootPath, 'conversations', '2026-08-30');
  await fs.mkdir(dayPath, { recursive: true });
  await fs.writeFile(path.join(dayPath, 'one.md'), conversationMarkdown('one'));
  await fs.writeFile(path.join(dayPath, '~draft.md'), conversationMarkdown('draft'));
  await fs.writeFile(path.join(dayPath, '.autosave.md'), conversationMarkdown('autosave'));
  await fs.writeFile(path.join(dayPath, 'scratch.tmp.md'), conversationMarkdown('tmp'));
  await fs.writeFile(path.join(dayPath, 'notes.txt'), 'not markdown');

  const first = await scanKnowledgeDirectory({
    rootPath,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });

  assert.deepEqual([...first.snapshot.keys()], ['conversations/2026-08-30/one.md']);
  assert.deepEqual(first.changes.deletes, []);
  assert.equal(first.changes.upserts.length, 1);
  assert.equal(first.changes.upserts[0].id, 'one');

  await fs.writeFile(
    path.join(dayPath, 'one.md'),
    conversationMarkdown('one', { response: 'A longer updated response' }),
  );
  await fs.writeFile(path.join(dayPath, 'two.md'), conversationMarkdown('two'));

  const second = await scanKnowledgeDirectory({
    rootPath,
    previousSnapshot: first.snapshot,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });

  assert.deepEqual(
    second.changes.upserts.map((item) => item.id).sort(),
    ['one', 'two'],
  );
  assert.deepEqual(second.changes.deletes, []);

  await fs.unlink(path.join(dayPath, 'one.md'));

  const third = await scanKnowledgeDirectory({
    rootPath,
    previousSnapshot: second.snapshot,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });

  assert.deepEqual(third.changes.upserts, []);
  assert.deepEqual(third.changes.deletes, ['conversations/2026-08-30/one.md']);
  assert.deepEqual([...third.snapshot.keys()], ['conversations/2026-08-30/two.md']);
});

test('scanner enforces per-file size and total Markdown file limits', async (t) => {
  const rootPath = await createTestDirectory('scanner-limits');
  t.after(() => removeTestDirectory(rootPath));

  await fs.writeFile(path.join(rootPath, 'large.md'), 'x'.repeat(128));
  const limitedBySize = await scanKnowledgeDirectory({
    rootPath,
    maxFileBytes: 64,
    maxFiles: 10,
  });

  assert.equal(limitedBySize.snapshot.size, 0);
  assert.equal(limitedBySize.warnings[0].code, 'FILE_TOO_LARGE');

  await fs.writeFile(path.join(rootPath, 'one.md'), conversationMarkdown('one'));
  await fs.writeFile(path.join(rootPath, 'two.md'), conversationMarkdown('two'));

  await assert.rejects(
    scanKnowledgeDirectory({
      rootPath,
      maxFileBytes: 1024 * 1024,
      maxFiles: 1,
    }),
    (error) => error && error.code === 'SCAN_LIMIT_EXCEEDED',
  );

  await assert.rejects(
    scanKnowledgeDirectory({
      rootPath,
      maxFileBytes: 1024 * 1024,
      maxFiles: 10,
      maxTotalBytes: 1,
    }),
    (error) => error && error.code === 'SCAN_BYTE_LIMIT_EXCEEDED',
  );
});

test('scanner detects a same-size rewrite even when mtime is restored', async (t) => {
  const rootPath = await createTestDirectory('scanner-fingerprint');
  t.after(() => removeTestDirectory(rootPath));
  const filePath = path.join(rootPath, 'same.md');
  const original = conversationMarkdown('same', { response: 'Response AAAA' });
  const changed = conversationMarkdown('same', { response: 'Response BBBB' });
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(changed));
  await fs.writeFile(filePath, original);

  const first = await scanKnowledgeDirectory({
    rootPath,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  const originalStats = await fs.stat(filePath);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(filePath, changed);
  await fs.utimes(filePath, originalStats.atime, originalStats.mtime);

  const second = await scanKnowledgeDirectory({
    rootPath,
    previousSnapshot: first.snapshot,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });

  assert.equal(second.changes.upserts.length, 1);
  assert.equal(second.changes.upserts[0].response, 'Response BBBB');
});

test('scanner rejects a knowledge root replaced by an escaping symlink', async (t) => {
  const temporaryRoot = await createTestDirectory('scanner-boundary');
  t.after(() => removeTestDirectory(temporaryRoot));
  const projectPath = path.join(temporaryRoot, 'project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  const outsidePath = path.join(temporaryRoot, 'outside');
  await fs.mkdir(knowledgePath, { recursive: true });
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(knowledgePath, 'inside.md'), conversationMarkdown('inside'));

  const first = await scanKnowledgeDirectory({
    rootPath: knowledgePath,
    boundaryRoot: projectPath,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  await fs.rename(knowledgePath, path.join(projectPath, 'retained-knowledge'));
  try {
    await fs.symlink(outsidePath, knowledgePath, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    scanKnowledgeDirectory({
      rootPath: knowledgePath,
      boundaryRoot: projectPath,
      previousSnapshot: first.snapshot,
      maxFileBytes: 1024 * 1024,
      maxFiles: 10,
    }),
    (error) => error && error.code === 'PATH_OUTSIDE_BOUNDARY',
  );
});

test('scanner keeps a pinned boundary when the project path itself is replaced', async (t) => {
  const temporaryRoot = await createTestDirectory('scanner-pinned-boundary');
  t.after(() => removeTestDirectory(temporaryRoot));
  const projectPath = path.join(temporaryRoot, 'project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  const outsideProject = path.join(temporaryRoot, 'outside-project');
  await fs.mkdir(knowledgePath, { recursive: true });
  await fs.mkdir(path.join(outsideProject, 'knowledge-database'), { recursive: true });
  await fs.writeFile(path.join(knowledgePath, 'inside.md'), conversationMarkdown('inside'));
  await fs.writeFile(
    path.join(outsideProject, 'knowledge-database', 'outside.md'),
    conversationMarkdown('outside'),
  );
  const canonicalBoundaryRoot = await fs.realpath(projectPath);
  const first = await scanKnowledgeDirectory({
    rootPath: knowledgePath,
    canonicalBoundaryRoot,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  await fs.rename(projectPath, path.join(temporaryRoot, 'retained-project'));
  try {
    await fs.symlink(outsideProject, projectPath, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    scanKnowledgeDirectory({
      rootPath: knowledgePath,
      canonicalBoundaryRoot,
      previousSnapshot: first.snapshot,
      maxFileBytes: 1024 * 1024,
      maxFiles: 10,
    }),
    (error) => error && error.code === 'PATH_OUTSIDE_BOUNDARY',
  );
});
