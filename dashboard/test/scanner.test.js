'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { filesystemIdentity, scanKnowledgeDirectory } = require('../lib/scanner');
const {
  conversationMarkdown,
  createTestDirectory,
  removeTestDirectory,
} = require('../test-support/helpers');

test('scanner identity fails closed when the platform provides no stable tuple', () => {
  assert.equal(filesystemIdentity({ dev: 1, ino: 2 }), '1:2');
  assert.equal(filesystemIdentity({ dev: 9007199254740993n, ino: 9007199254740995n }), '9007199254740993:9007199254740995');
  assert.throws(
    () => filesystemIdentity({ dev: 0, ino: 0 }),
    /stable filesystem identity is unavailable/,
  );
  assert.throws(
    () => filesystemIdentity({ dev: 0, ino: 2 }),
    /stable filesystem identity is unavailable/,
  );
  assert.throws(
    () => filesystemIdentity({ dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 }),
    /stable filesystem identity is unavailable/,
  );
});

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

test('scanner exposes a conversation only after its publication temp link is removed', async (t) => {
  const rootPath = await createTestDirectory('scanner-publish-boundary');
  t.after(() => removeTestDirectory(rootPath));
  const filePath = path.join(rootPath, 'conversation.md');
  const tempPath = path.join(
    rootPath,
    `.conversation.md.123.123e4567-e89b-42d3-a456-426614174001.tmp`,
  );
  const contents = conversationMarkdown('publish-boundary');
  const scan = () => scanKnowledgeDirectory({
    rootPath,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });

  await fs.writeFile(filePath, contents);
  await fs.link(filePath, tempPath);

  await assert.rejects(scan(), (error) => error && error.code === 'SCAN_NAMESPACE_CHANGED');

  await fs.truncate(filePath, 0);
  await assert.rejects(scan(), (error) => error && error.code === 'SCAN_NAMESPACE_CHANGED');

  await fs.unlink(tempPath);
  await fs.unlink(filePath);
  await fs.writeFile(filePath, contents);
  await fs.link(filePath, tempPath);
  await fs.unlink(tempPath);

  const committed = await scan();
  assert.equal(committed.snapshot.size, 1);
  assert.equal(committed.changes.upserts[0].id, 'publish-boundary');
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

test('scanner does not create a missing knowledge directory', async (t) => {
  const parentPath = await createTestDirectory('scanner-missing-root');
  const rootPath = path.join(parentPath, 'missing', 'knowledge-database');
  t.after(() => removeTestDirectory(parentPath));

  await assert.rejects(
    scanKnowledgeDirectory({
      rootPath,
      maxFileBytes: 1024 * 1024,
      maxFiles: 10,
    }),
    (error) => error && error.code === 'ENOENT',
  );
  await assert.rejects(
    fs.stat(rootPath),
    (error) => error && error.code === 'ENOENT',
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

test('scanner rejects a standalone knowledge root replaced after its identity is pinned', async (t) => {
  const temporaryRoot = await createTestDirectory('scanner-pinned-root');
  t.after(() => removeTestDirectory(temporaryRoot));
  const knowledgePath = path.join(temporaryRoot, 'knowledge');
  const retainedPath = path.join(temporaryRoot, 'retained-knowledge');
  const outsidePath = path.join(temporaryRoot, 'outside');
  await fs.mkdir(knowledgePath);
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(knowledgePath, 'inside.md'), conversationMarkdown('inside'));
  await fs.writeFile(path.join(outsidePath, 'outside.md'), conversationMarkdown('outside'));
  const canonicalRootPath = await fs.realpath(knowledgePath);
  const first = await scanKnowledgeDirectory({
    rootPath: knowledgePath,
    canonicalRootPath,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  await fs.rename(knowledgePath, retainedPath);
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
      canonicalRootPath,
      previousSnapshot: first.snapshot,
      maxFileBytes: 1024 * 1024,
      maxFiles: 10,
    }),
    (error) => error && error.code === 'SCAN_NAMESPACE_CHANGED',
  );
});

test('scanner rejects a transient empty project replacement during enumeration', async (t) => {
  const temporaryRoot = await createTestDirectory('scanner-transient-project');
  t.after(() => removeTestDirectory(temporaryRoot));
  const projectPath = path.join(temporaryRoot, 'project');
  const retainedProjectPath = path.join(temporaryRoot, 'retained-project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  await fs.mkdir(knowledgePath, { recursive: true });
  await fs.writeFile(path.join(knowledgePath, 'one.md'), conversationMarkdown('one'));
  const canonicalBoundaryRoot = await fs.realpath(projectPath);
  const canonicalRootPath = await fs.realpath(knowledgePath);
  const projectStat = await fs.stat(projectPath, { bigint: true });
  const knowledgeStat = await fs.stat(knowledgePath, { bigint: true });
  const first = await scanKnowledgeDirectory({
    rootPath: knowledgePath,
    canonicalBoundaryRoot,
    boundaryIdentity: filesystemIdentity(projectStat),
    canonicalRootPath,
    rootIdentity: filesystemIdentity(knowledgeStat),
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  const originalOpendir = fs.opendir;
  let swapped = false;
  fs.opendir = async (directory, ...arguments_) => {
    if (!swapped && directory === knowledgePath) {
      swapped = true;
      await fs.rename(projectPath, retainedProjectPath);
      await fs.mkdir(knowledgePath, { recursive: true });
      const handle = await originalOpendir(directory, ...arguments_);
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.rename(retainedProjectPath, projectPath);
      return handle;
    }
    return originalOpendir(directory, ...arguments_);
  };
  t.after(() => {
    fs.opendir = originalOpendir;
  });

  try {
    await assert.rejects(
      scanKnowledgeDirectory({
        rootPath: knowledgePath,
        previousSnapshot: first.snapshot,
        canonicalBoundaryRoot,
        boundaryIdentity: filesystemIdentity(projectStat),
        canonicalRootPath,
        rootIdentity: filesystemIdentity(knowledgeStat),
        maxFileBytes: 1024 * 1024,
        maxFiles: 10,
      }),
      (error) => error && error.code === 'SCAN_NAMESPACE_CHANGED',
    );
  } finally {
    fs.opendir = originalOpendir;
  }
  assert.equal(swapped, true);
});

test('scanner rejects a transient oversized replacement of the same Markdown path', async (t) => {
  const temporaryRoot = await createTestDirectory('scanner-oversized-replacement');
  t.after(() => removeTestDirectory(temporaryRoot));
  const projectPath = path.join(temporaryRoot, 'project');
  const retainedProjectPath = path.join(temporaryRoot, 'retained-project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  const filePath = path.join(knowledgePath, 'one.md');
  await fs.mkdir(knowledgePath, { recursive: true });
  await fs.writeFile(filePath, conversationMarkdown('one'));
  const canonicalBoundaryRoot = await fs.realpath(projectPath);
  const canonicalRootPath = await fs.realpath(knowledgePath);
  const projectStat = await fs.stat(projectPath, { bigint: true });
  const knowledgeStat = await fs.stat(knowledgePath, { bigint: true });
  const first = await scanKnowledgeDirectory({
    rootPath: knowledgePath,
    canonicalBoundaryRoot,
    boundaryIdentity: filesystemIdentity(projectStat),
    canonicalRootPath,
    rootIdentity: filesystemIdentity(knowledgeStat),
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  const originalLstat = fs.lstat;
  let swapped = false;
  fs.lstat = async (targetPath, ...arguments_) => {
    if (!swapped && targetPath === filePath && arguments_[0] === undefined) {
      swapped = true;
      await fs.rename(projectPath, retainedProjectPath);
      await fs.mkdir(knowledgePath, { recursive: true });
      await fs.writeFile(filePath, 'x'.repeat(256));
      const replacementStat = await originalLstat(targetPath, ...arguments_);
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.rename(retainedProjectPath, projectPath);
      return replacementStat;
    }
    return originalLstat(targetPath, ...arguments_);
  };
  t.after(() => {
    fs.lstat = originalLstat;
  });

  try {
    await assert.rejects(
      scanKnowledgeDirectory({
        rootPath: knowledgePath,
        previousSnapshot: first.snapshot,
        canonicalBoundaryRoot,
        boundaryIdentity: filesystemIdentity(projectStat),
        canonicalRootPath,
        rootIdentity: filesystemIdentity(knowledgeStat),
        maxFileBytes: 64,
        maxFiles: 10,
      }),
      (error) => error && error.code === 'SCAN_NAMESPACE_CHANGED',
    );
  } finally {
    fs.lstat = originalLstat;
  }
  assert.equal(swapped, true);
});

test('scanner rejects a transient read failure from a same-path replacement', async (t) => {
  const temporaryRoot = await createTestDirectory('scanner-read-replacement');
  t.after(() => removeTestDirectory(temporaryRoot));
  const projectPath = path.join(temporaryRoot, 'project');
  const retainedProjectPath = path.join(temporaryRoot, 'retained-project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  const filePath = path.join(knowledgePath, 'one.md');
  await fs.mkdir(knowledgePath, { recursive: true });
  await fs.writeFile(filePath, conversationMarkdown('one'));
  const canonicalBoundaryRoot = await fs.realpath(projectPath);
  const canonicalRootPath = await fs.realpath(knowledgePath);
  const projectStat = await fs.stat(projectPath, { bigint: true });
  const knowledgeStat = await fs.stat(knowledgePath, { bigint: true });
  const first = await scanKnowledgeDirectory({
    rootPath: knowledgePath,
    canonicalBoundaryRoot,
    boundaryIdentity: filesystemIdentity(projectStat),
    canonicalRootPath,
    rootIdentity: filesystemIdentity(knowledgeStat),
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  });
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  let swapped = false;
  let restored = false;
  fs.lstat = async (targetPath, ...arguments_) => {
    if (!swapped && targetPath === filePath && arguments_[0] === undefined) {
      swapped = true;
      await fs.rename(projectPath, retainedProjectPath);
      await fs.mkdir(knowledgePath, { recursive: true });
      await fs.writeFile(filePath, conversationMarkdown('replacement'));
    }
    return originalLstat(targetPath, ...arguments_);
  };
  fs.open = async (targetPath, ...arguments_) => {
    const handle = await originalOpen(targetPath, ...arguments_);
    if (swapped && !restored && targetPath === filePath) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async () => {
              const error = new Error('simulated read failure');
              error.code = 'EIO';
              throw error;
            };
          }
          if (property === 'close') {
            return async () => {
              await target.close();
              if (!restored) {
                restored = true;
                await fs.rm(projectPath, { recursive: true, force: true });
                await fs.rename(retainedProjectPath, projectPath);
              }
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    return handle;
  };
  t.after(() => {
    fs.lstat = originalLstat;
    fs.open = originalOpen;
  });

  try {
    await assert.rejects(
      scanKnowledgeDirectory({
        rootPath: knowledgePath,
        previousSnapshot: first.snapshot,
        canonicalBoundaryRoot,
        boundaryIdentity: filesystemIdentity(projectStat),
        canonicalRootPath,
        rootIdentity: filesystemIdentity(knowledgeStat),
        maxFileBytes: 1024 * 1024,
        maxFiles: 10,
      }),
      (error) => error && error.code === 'SCAN_NAMESPACE_CHANGED',
    );
  } finally {
    fs.lstat = originalLstat;
    fs.open = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(restored, true);
});
