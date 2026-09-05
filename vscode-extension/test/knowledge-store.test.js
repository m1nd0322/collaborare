'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertKnowledgeDatabaseReady,
  atomicWriteFile,
  ensureKnowledgeDatabase,
  filesystemIdentity,
  resolveKnowledgeRoot,
  saveConversation,
  scanMarkdownFiles,
  serializeConversation,
  validateKnowledgeDirectory
} = require('../src/knowledge-store');

function conversation(overrides = {}) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    project: 'sample-project',
    account: 'octocat',
    machine: 'build-host',
    questionAt: '2026-08-30T10:00:00.000Z',
    responseAt: '2026-08-30T10:00:01.000Z',
    model: 'copilot/test',
    status: 'complete',
    question: 'How does this work?',
    response: 'It works atomically.',
    ...overrides
  };
}

test('serializeConversation safely JSON-quotes every frontmatter string', () => {
  const record = conversation({
    project: 'repo: "quoted"\nnext',
    account: '사용자',
    question: 'first\r\nsecond'
  });
  const markdown = serializeConversation(record);

  assert.match(markdown, /^---\nschema: "collaborare\/conversation\/v1"\n/);
  assert.ok(markdown.includes(`project: ${JSON.stringify(record.project)}`));
  assert.ok(markdown.includes(`account: ${JSON.stringify(record.account)}`));
  assert.ok(markdown.includes('status: "complete"'));
  assert.ok(markdown.includes('\n## User\n\nfirst\nsecond\n\n## Copilot\n\nIt works atomically.\n'));
});

test('serializeConversation rejects unsupported statuses', () => {
  assert.throws(() => serializeConversation(conversation({ status: 'partial' })), /Invalid conversation status/);
});

test('knowledge directory validation allows nested relative paths', () => {
  assert.equal(validateKnowledgeDirectory('shared/knowledge'), path.join('shared', 'knowledge'));
  assert.equal(
    resolveKnowledgeRoot('/tmp/project', 'shared/knowledge'),
    path.resolve('/tmp/project', 'shared', 'knowledge')
  );
});

test('knowledge directory validation rejects absolute and traversal paths', () => {
  for (const value of [
    '',
    '.',
    '..',
    '../knowledge',
    'shared/../knowledge',
    '/var/knowledge',
    'C:\\knowledge',
    'C:knowledge',
    '\\\\server\\knowledge'
  ]) {
    assert.throws(() => validateKnowledgeDirectory(value), /relative|traversal|non-empty/);
  }
});

test('filesystem identity fails closed when the platform provides no stable tuple', () => {
  assert.equal(filesystemIdentity({ dev: 1, ino: 2 }), '1:2');
  assert.equal(filesystemIdentity({ dev: 9007199254740993n, ino: 9007199254740995n }), '9007199254740993:9007199254740995');
  assert.throws(
    () => filesystemIdentity({ dev: 0, ino: 0 }),
    /stable filesystem identity is unavailable/,
  );
  assert.throws(
    () => filesystemIdentity({ dev: 1, ino: 0 }),
    /stable filesystem identity is unavailable/,
  );
  assert.throws(
    () => filesystemIdentity({ dev: Number.MAX_SAFE_INTEGER + 1, ino: 2 }),
    /stable filesystem identity is unavailable/,
  );
});

test('knowledge database operations reject a nested symlink that escapes the project root', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-link-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const outsideRoot = path.join(temporaryRoot, 'outside');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  await fs.mkdir(knowledgeRoot, { recursive: true });
  await fs.mkdir(outsideRoot);
  try {
    await fs.symlink(outsideRoot, path.join(knowledgeRoot, 'conversations'), 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    assertKnowledgeDatabaseReady(knowledgeRoot, projectRoot),
    /symbolic link or junction|resolves outside the project root/
  );
  await assert.rejects(
    ensureKnowledgeDatabase(knowledgeRoot, projectRoot),
    /symbolic link or junction|resolves outside the project root/
  );
});

test('knowledge database operations reject an in-project intermediate symlink', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-intermediate-link-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const actualParent = path.join(projectRoot, 'actual');
  const linkedParent = path.join(projectRoot, 'linked');
  const knowledgeRoot = path.join(linkedParent, 'knowledge-database');
  await fs.mkdir(path.join(actualParent, 'knowledge-database', 'conversations'), { recursive: true });
  try {
    await fs.symlink(actualParent, linkedParent, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    assertKnowledgeDatabaseReady(knowledgeRoot, projectRoot),
    /path cannot contain a symbolic link or junction/,
  );
  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), { projectRoot }),
    /path cannot contain a symbolic link or junction/,
  );
});

test('knowledge database preflight does not create a missing conversations directory', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-preflight-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  await fs.mkdir(knowledgeRoot);

  await assert.rejects(
    assertKnowledgeDatabaseReady(knowledgeRoot, await fs.realpath(projectRoot), {
      projectRootIsCanonical: true
    }),
    /not available/
  );
  await assert.rejects(fs.stat(conversationsRoot), { code: 'ENOENT' });
});

test('knowledge database preflight rejects an in-project conversations symlink', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-preflight-link-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const targetRoot = path.join(knowledgeRoot, 'actual-conversations');
  await fs.mkdir(targetRoot, { recursive: true });
  try {
    await fs.symlink(targetRoot, path.join(knowledgeRoot, 'conversations'), 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    assertKnowledgeDatabaseReady(knowledgeRoot, await fs.realpath(projectRoot), {
      projectRootIsCanonical: true,
    }),
    /symbolic link or junction/,
  );
});

test('knowledge database preflight pins identities and probes the dated write directory', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-preflight-probe-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  await fs.mkdir(conversationsRoot, { recursive: true });
  const canonicalProjectRoot = await fs.realpath(projectRoot);

  const identity = await assertKnowledgeDatabaseReady(knowledgeRoot, canonicalProjectRoot, {
    projectRootIsCanonical: true,
    probeDate: '2026-08-30T10:00:00.000Z',
  });

  assert.equal(identity.canonicalKnowledgeRoot, await fs.realpath(knowledgeRoot));
  assert.equal(identity.canonicalConversationsRoot, await fs.realpath(conversationsRoot));
  assert.equal(identity.dateRoot, path.join(conversationsRoot, '2026-08-30'));
  assert.equal(identity.canonicalDateRoot, await fs.realpath(identity.dateRoot));
  assert.match(identity.knowledgeIdentity, /^\d+:\d+$/);
  assert.match(identity.dateIdentity, /^\d+:\d+$/);
  assert.deepEqual(
    await fs.readdir(path.join(conversationsRoot, '2026-08-30')),
    [],
  );
});

test('knowledge database preflight fails when its write probe cannot be removed', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-preflight-cleanup-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const dateRoot = path.join(conversationsRoot, '2026-08-30');
  await fs.mkdir(conversationsRoot, { recursive: true });
  const originalUnlink = fs.unlink;
  let rejectedProbePath;
  fs.unlink = async (targetPath, ...arguments_) => {
    if (path.basename(targetPath).startsWith('.collaborare-write-probe-')) {
      rejectedProbePath = targetPath;
      const error = new Error('simulated write probe cleanup failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink(targetPath, ...arguments_);
  };
  t.after(() => {
    fs.unlink = originalUnlink;
  });

  try {
    await assert.rejects(
      assertKnowledgeDatabaseReady(knowledgeRoot, await fs.realpath(projectRoot), {
        projectRootIsCanonical: true,
        probeDate: '2026-08-30T10:00:00.000Z',
      }),
      (error) => error && error.code === 'EACCES',
    );
  } finally {
    fs.unlink = originalUnlink;
  }

  assert.ok(rejectedProbePath);
  assert.equal(path.dirname(rejectedProbePath), dateRoot);
  assert.deepEqual(await fs.readdir(dateRoot), [path.basename(rejectedProbePath)]);
});

test('knowledge database preflight preserves multiple write probe cleanup errors', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-preflight-cleanup-errors-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  fs.open = async (targetPath, ...arguments_) => {
    const handle = await originalOpen(targetPath, ...arguments_);
    if (!path.basename(targetPath).startsWith('.collaborare-write-probe-')) {
      return handle;
    }
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'close') {
          return async () => {
            await target.close();
            const error = new Error('simulated write probe close failure');
            error.code = 'ECLOSE';
            throw error;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  fs.unlink = async (targetPath, ...arguments_) => {
    if (path.basename(targetPath).startsWith('.collaborare-write-probe-')) {
      const error = new Error('simulated write probe unlink failure');
      error.code = 'EUNLINK';
      throw error;
    }
    return originalUnlink(targetPath, ...arguments_);
  };
  t.after(() => {
    fs.open = originalOpen;
    fs.unlink = originalUnlink;
  });

  try {
    await assert.rejects(
      assertKnowledgeDatabaseReady(knowledgeRoot, await fs.realpath(projectRoot), {
        projectRootIsCanonical: true,
        probeDate: '2026-08-30T10:00:00.000Z',
      }),
      (error) => error instanceof AggregateError
        && error.errors.map((item) => item.code).join(',') === 'ECLOSE,EUNLINK',
    );
  } finally {
    fs.open = originalOpen;
    fs.unlink = originalUnlink;
  }
});

test('knowledge database preflight rejects identities captured from different directory generations', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-preflight-generation-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const retainedConversationsRoot = path.join(knowledgeRoot, 'retained-conversations');
  const dateRoot = path.join(conversationsRoot, '2026-08-30');
  await fs.mkdir(conversationsRoot, { recursive: true });
  const originalMkdir = fs.mkdir;
  let swapped = false;
  fs.mkdir = async (directory, ...arguments_) => {
    if (!swapped && directory === dateRoot) {
      swapped = true;
      await fs.rename(conversationsRoot, retainedConversationsRoot);
      await originalMkdir(conversationsRoot);
    }
    return originalMkdir(directory, ...arguments_);
  };
  t.after(() => {
    fs.mkdir = originalMkdir;
  });

  try {
    await assert.rejects(
      assertKnowledgeDatabaseReady(knowledgeRoot, await fs.realpath(projectRoot), {
        projectRootIsCanonical: true,
        probeDate: '2026-08-30T10:00:00.000Z',
      }),
      /conversation root identity changed during publishing/,
    );
  } finally {
    fs.mkdir = originalMkdir;
  }
  assert.equal(swapped, true);
});

test('saveConversation rejects a date directory replaced after model preflight', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-date-preflight-remap-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const dateRoot = path.join(conversationsRoot, '2026-08-30');
  const retainedDateRoot = path.join(conversationsRoot, 'retained-date');
  await fs.mkdir(conversationsRoot, { recursive: true });
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const projectStat = await fs.stat(projectRoot, { bigint: true });
  const pinned = await assertKnowledgeDatabaseReady(knowledgeRoot, canonicalProjectRoot, {
    projectRootIsCanonical: true,
    probeDate: '2026-08-30T10:00:00.000Z',
  });
  await fs.rename(dateRoot, retainedDateRoot);
  await fs.mkdir(dateRoot);

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      projectRoot: canonicalProjectRoot,
      projectRootIsCanonical: true,
      requireExistingRoot: true,
      expectedProjectIdentity: `${projectStat.dev}:${projectStat.ino}`,
      expectedCanonicalKnowledgeRoot: pinned.canonicalKnowledgeRoot,
      expectedKnowledgeIdentity: pinned.knowledgeIdentity,
      expectedCanonicalConversationsRoot: pinned.canonicalConversationsRoot,
      expectedConversationsIdentity: pinned.conversationsIdentity,
      expectedCanonicalDateRoot: pinned.canonicalDateRoot,
      expectedDateIdentity: pinned.dateIdentity,
    }),
    /date root identity changed during publishing/,
  );
  assert.deepEqual(await fs.readdir(dateRoot), []);
  assert.deepEqual(await fs.readdir(retainedDateRoot), []);
});

test('saveConversation requires an expected date root and identity together', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-date-pair-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      expectedCanonicalDateRoot: path.join(knowledgeRoot, 'conversations', '2026-08-30'),
    }),
    /expected date root and identity must be provided together/,
  );
});

test('saveConversation rejects a conversations root replaced after it was pinned', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-conversations-remap-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const retainedConversationsRoot = path.join(knowledgeRoot, 'retained-conversations');
  await fs.mkdir(conversationsRoot, { recursive: true });
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const projectStat = await fs.stat(projectRoot);
  const pinned = await assertKnowledgeDatabaseReady(knowledgeRoot, canonicalProjectRoot, {
    projectRootIsCanonical: true,
  });
  await fs.rename(conversationsRoot, retainedConversationsRoot);
  await fs.mkdir(conversationsRoot);

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      projectRoot: canonicalProjectRoot,
      projectRootIsCanonical: true,
      requireExistingRoot: true,
      expectedProjectIdentity: `${projectStat.dev || 0}:${projectStat.ino || 0}`,
      expectedCanonicalKnowledgeRoot: pinned.canonicalKnowledgeRoot,
      expectedKnowledgeIdentity: pinned.knowledgeIdentity,
      expectedCanonicalConversationsRoot: pinned.canonicalConversationsRoot,
      expectedConversationsIdentity: pinned.conversationsIdentity,
    }),
    /conversation root identity changed during publishing/,
  );
  assert.deepEqual(await fs.readdir(conversationsRoot), []);
});

test('saveConversation rejects a date directory symlink that escapes the project root', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-date-link-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const outsideRoot = path.join(temporaryRoot, 'outside');
  await fs.mkdir(conversationsRoot, { recursive: true });
  await fs.mkdir(outsideRoot);
  try {
    await fs.symlink(outsideRoot, path.join(conversationsRoot, '2026-08-30'), 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), { projectRoot }),
    /symbolic link or junction|resolves outside the project root/
  );
});

test('saveConversation detects a date directory moved outside during publish', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-date-race-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const dateRoot = path.join(conversationsRoot, '2026-08-30');
  const movedDateRoot = path.join(temporaryRoot, 'moved-date');
  await fs.mkdir(dateRoot, { recursive: true });

  const symlinkProbe = path.join(temporaryRoot, 'symlink-probe');
  try {
    await fs.symlink(dateRoot, symlinkProbe, 'dir');
    await fs.unlink(symlinkProbe);
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  const originalOpen = fs.open;
  let swapped = false;
  fs.open = async (filePath, ...arguments_) => {
    if (!swapped && path.dirname(filePath) === dateRoot && String(filePath).endsWith('.tmp')) {
      swapped = true;
      await fs.rename(dateRoot, movedDateRoot);
      await fs.symlink(movedDateRoot, dateRoot, 'dir');
    }
    return originalOpen(filePath, ...arguments_);
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      projectRoot: await fs.realpath(projectRoot),
      projectRootIsCanonical: true,
      requireExistingRoot: true,
    }),
    /symbolic link|outside the project root|changed during publishing/,
  );
  assert.equal(swapped, true);
  const leftovers = await fs.readdir(movedDateRoot);
  assert.equal(leftovers.length, 1);
  assert.equal((await fs.stat(path.join(movedDateRoot, leftovers[0]))).size, 0);
});

test('saveConversation scrubs an open temporary file when its directory moves before publish', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-date-leak-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const dateRoot = path.join(knowledgeRoot, 'conversations', '2026-08-30');
  const movedDateRoot = path.join(temporaryRoot, 'moved-date');
  await fs.mkdir(dateRoot, { recursive: true });

  const originalLink = fs.link;
  const originalRename = fs.rename;
  let swapped = false;
  async function moveBeforePublish(action, source) {
    if (!swapped && path.dirname(source) === dateRoot && String(source).endsWith('.tmp')) {
      swapped = true;
      await originalRename(dateRoot, movedDateRoot);
      await fs.mkdir(dateRoot);
    }
    return action();
  }
  fs.link = async (source, destination) => {
    return moveBeforePublish(() => originalLink(source, destination), source);
  };
  fs.rename = async (source, destination) => {
    return moveBeforePublish(() => originalRename(source, destination), source);
  };
  t.after(() => {
    fs.link = originalLink;
    fs.rename = originalRename;
  });

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation({
      question: 'sensitive question',
      response: 'sensitive response',
    }), {
      projectRoot: await fs.realpath(projectRoot),
      projectRootIsCanonical: true,
      requireExistingRoot: true,
    }),
  );
  assert.equal(swapped, true);
  const leftovers = await fs.readdir(movedDateRoot);
  assert.equal(leftovers.length, 1);
  assert.equal((await fs.stat(path.join(movedDateRoot, leftovers[0]))).size, 0);
});

test('new publish revalidates pinned roots after reading the final UUID', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-final-read-race-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const retainedKnowledgeRoot = path.join(projectRoot, 'retained-knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174015';
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const canonicalKnowledgeRoot = await fs.realpath(knowledgeRoot);
  const projectStat = await fs.stat(projectRoot);
  const knowledgeStat = await fs.stat(knowledgeRoot);

  const originalReadFile = fs.readFile;
  let swapped = false;
  fs.readFile = async (...arguments_) => {
    const contents = await originalReadFile(...arguments_);
    if (!swapped && String(arguments_[0]).endsWith(`${id}.md`)) {
      swapped = true;
      await fs.rename(knowledgeRoot, retainedKnowledgeRoot);
      await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
    }
    return contents;
  };
  t.after(() => {
    fs.readFile = originalReadFile;
  });

  try {
    await assert.rejects(
      saveConversation(knowledgeRoot, conversation(), {
        id,
        projectRoot: canonicalProjectRoot,
        projectRootIsCanonical: true,
        requireExistingRoot: true,
        expectedProjectIdentity: `${projectStat.dev || 0}:${projectStat.ino || 0}`,
        expectedCanonicalKnowledgeRoot: canonicalKnowledgeRoot,
        expectedKnowledgeIdentity: `${knowledgeStat.dev || 0}:${knowledgeStat.ino || 0}`,
      }),
      /identity changed during publishing/,
    );
  } finally {
    fs.readFile = originalReadFile;
  }

  assert.equal(swapped, true);
});

test('saveConversation atomically publishes one UUID Markdown file in the UTC date directory', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-store-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');

  const saved = await saveConversation(knowledgeRoot, conversation());
  const expectedDirectory = path.join(knowledgeRoot, 'conversations', '2026-08-30');
  const names = await fs.readdir(expectedDirectory);
  const contents = await fs.readFile(saved.filePath, 'utf8');

  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(path.dirname(saved.filePath), expectedDirectory);
  assert.deepEqual(names, [`${saved.id}.md`]);
  assert.ok(contents.includes(`id: ${JSON.stringify(saved.id)}`));
  assert.equal(names.some((name) => name.endsWith('.tmp')), false);
});

test('saveConversation is idempotent when a fixed UUID is retried', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-idempotent-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174001';

  const first = await saveConversation(knowledgeRoot, conversation(), { id });
  const second = await saveConversation(knowledgeRoot, conversation(), { id });

  assert.equal(first.filePath, second.filePath);
  assert.equal(second.alreadyExisted, true);
  assert.deepEqual(await fs.readdir(path.dirname(first.filePath)), [`${id}.md`]);
});

test('idempotent publish does not follow a transient symlink while opening the existing UUID', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-idempotent-link-race-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174016';
  const first = await saveConversation(knowledgeRoot, conversation(), { id });
  const retainedPath = `${first.filePath}.retained`;
  const outsidePath = path.join(temporaryRoot, 'outside.md');
  await fs.writeFile(outsidePath, await fs.readFile(first.filePath));

  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;
  let attacked = false;
  async function replaceDuringRead(action) {
    attacked = true;
    await fs.rename(first.filePath, retainedPath);
    await fs.symlink(outsidePath, first.filePath, 'file');
    try {
      return await action();
    } finally {
      await fs.unlink(first.filePath).catch(() => {});
      await fs.rename(retainedPath, first.filePath).catch(() => {});
    }
  }
  fs.open = async (filePath, ...arguments_) => {
    if (!attacked && filePath === first.filePath) {
      return replaceDuringRead(() => originalOpen(filePath, ...arguments_));
    }
    return originalOpen(filePath, ...arguments_);
  };
  fs.readFile = async (filePath, ...arguments_) => {
    if (!attacked && filePath === first.filePath) {
      return replaceDuringRead(() => originalReadFile(filePath, ...arguments_));
    }
    return originalReadFile(filePath, ...arguments_);
  };
  t.after(() => {
    fs.open = originalOpen;
    fs.readFile = originalReadFile;
  });

  try {
    await assert.rejects(saveConversation(knowledgeRoot, conversation(), { id }));
  } finally {
    fs.open = originalOpen;
    fs.readFile = originalReadFile;
  }
  assert.equal(attacked, true);
  assert.equal((await fs.lstat(first.filePath)).isSymbolicLink(), false);
});

test('idempotent publish revalidates pinned roots after reading the existing UUID', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-idempotent-root-race-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const retainedKnowledgeRoot = path.join(projectRoot, 'retained-knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174014';
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  const first = await saveConversation(knowledgeRoot, conversation(), { id });
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const canonicalKnowledgeRoot = await fs.realpath(knowledgeRoot);
  const projectStat = await fs.stat(projectRoot);
  const knowledgeStat = await fs.stat(knowledgeRoot);

  const originalOpen = fs.open;
  let swapped = false;
  fs.open = async (filePath, ...arguments_) => {
    const handle = await originalOpen(filePath, ...arguments_);
    if (filePath !== first.filePath) {
      return handle;
    }
    return {
      close: (...closeArguments) => handle.close(...closeArguments),
      stat: (...statArguments) => handle.stat(...statArguments),
      async readFile(...readArguments) {
        const contents = await handle.readFile(...readArguments);
        if (!swapped) {
          swapped = true;
          await fs.rename(knowledgeRoot, retainedKnowledgeRoot);
          await fs.mkdir(path.dirname(first.filePath), { recursive: true });
          await fs.writeFile(first.filePath, contents);
        }
        return contents;
      },
    };
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  try {
    await assert.rejects(
      saveConversation(knowledgeRoot, conversation(), {
        id,
        projectRoot: canonicalProjectRoot,
        projectRootIsCanonical: true,
        requireExistingRoot: true,
        expectedProjectIdentity: `${projectStat.dev || 0}:${projectStat.ino || 0}`,
        expectedCanonicalKnowledgeRoot: canonicalKnowledgeRoot,
        expectedKnowledgeIdentity: `${knowledgeStat.dev || 0}:${knowledgeStat.ino || 0}`,
      }),
      /identity changed during publishing/,
    );
  } finally {
    fs.open = originalOpen;
  }

  assert.equal(swapped, true);
});

test('concurrent fixed UUID publishes cannot overwrite a different conversation', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-collision-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174002';

  const results = await Promise.allSettled([
    saveConversation(knowledgeRoot, conversation({ question: 'first' }), { id }),
    saveConversation(knowledgeRoot, conversation({ question: 'second' }), { id }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const stored = await fs.readFile(path.join(
    knowledgeRoot,
    'conversations',
    '2026-08-30',
    `${id}.md`,
  ), 'utf8');
  assert.equal(stored.includes('first') || stored.includes('second'), true);
  assert.equal(stored.includes('first') && stored.includes('second'), false);
});

test('an in-progress hard-link publication is not accepted as idempotently complete', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-publish-progress-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174016';
  const record = conversation();
  const dateRoot = path.join(knowledgeRoot, 'conversations', '2026-08-30');
  const originalUnlink = fs.unlink;
  let releaseCommit;
  const commitReleased = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  let publicationLinked;
  const linked = new Promise((resolve) => {
    publicationLinked = resolve;
  });
  let blocked = false;
  fs.unlink = async (targetPath, ...arguments_) => {
    if (!blocked
      && typeof targetPath === 'string'
      && path.dirname(targetPath) === dateRoot
      && path.basename(targetPath).startsWith(`.${id}.md.`)
      && targetPath.endsWith('.tmp')) {
      blocked = true;
      publicationLinked();
      await commitReleased;
    }
    return originalUnlink(targetPath, ...arguments_);
  };
  t.after(() => {
    releaseCommit();
    fs.unlink = originalUnlink;
  });

  const firstPublish = saveConversation(knowledgeRoot, record, { id });
  await linked;
  try {
    await assert.rejects(
      saveConversation(knowledgeRoot, record, { id }),
      /Conversation UUID collision/,
    );
  } finally {
    releaseCommit();
  }
  const saved = await firstPublish;
  fs.unlink = originalUnlink;
  assert.equal(blocked, true);
  assert.equal(saved.id, id);
  assert.equal(String((await fs.stat(saved.filePath, { bigint: true })).nlink), '1');
});

test('conversation publish never replaces a target created immediately before publication', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-no-clobber-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174017';
  const filePath = path.join(knowledgeRoot, 'conversations', '2026-08-30', `${id}.md`);
  const originalLink = fs.link;
  const originalRename = fs.rename;
  let attacked = false;
  async function plantIncumbent(action) {
    attacked = true;
    await fs.writeFile(filePath, 'incumbent audit');
    return action();
  }
  fs.link = async (source, destination) => {
    if (!attacked && destination === filePath) {
      return plantIncumbent(() => originalLink(source, destination));
    }
    return originalLink(source, destination);
  };
  fs.rename = async (source, destination) => {
    if (!attacked && destination === filePath) {
      return plantIncumbent(() => originalRename(source, destination));
    }
    return originalRename(source, destination);
  };
  t.after(() => {
    fs.link = originalLink;
    fs.rename = originalRename;
  });

  try {
    await assert.rejects(saveConversation(knowledgeRoot, conversation(), { id }));
  } finally {
    fs.link = originalLink;
    fs.rename = originalRename;
  }
  assert.equal(attacked, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'incumbent audit');
});

test('atomic publication leaves a scrubbed entry instead of unlinking after publication fails', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-published-cleanup-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'published.md');

  let publishError;
  try {
    await atomicWriteFile(filePath, 'sensitive audit', {
      noClobber: true,
      async validateTarget(_targetPath, stage) {
        if (stage === 'published') {
          throw new Error('simulated post-publication validation failure');
        }
      },
    });
  } catch (error) {
    publishError = error;
  }
  assert.match(publishError.message, /simulated post-publication validation failure/);
  assert.match(publishError.recoveryIdentity, /^\d+:\d+$/);
  assert.equal((await fs.stat(filePath)).size, 0);
});

test('pending recovery accepts but never deletes a scrubbed publication temp hard link', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-published-unlink-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const dateRoot = path.join(knowledgeRoot, 'conversations', '2026-08-30');
  const id = '123e4567-e89b-42d3-a456-426614174020';
  const filePath = path.join(dateRoot, `${id}.md`);
  const record = conversation();
  const originalUnlink = fs.unlink;
  let tempUnlinkFailures = 0;
  fs.unlink = async (targetPath, ...arguments_) => {
    if (tempUnlinkFailures < 1
      && typeof targetPath === 'string'
      && path.dirname(targetPath) === dateRoot
      && path.basename(targetPath).startsWith(`.${id}.md.`)
      && targetPath.endsWith('.tmp')) {
      tempUnlinkFailures += 1;
      const error = new Error('simulated publication temp unlink failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlink(targetPath, ...arguments_);
  };
  t.after(() => {
    fs.unlink = originalUnlink;
  });

  let publishError;
  try {
    await atomicWriteFile(filePath, serializeConversation({ ...record, id }), { noClobber: true });
  } catch (error) {
    publishError = error;
  } finally {
    fs.unlink = originalUnlink;
  }

  assert.equal(tempUnlinkFailures, 1);
  assert.match(publishError.recoveryIdentity, /^\d+:\d+$/);
  assert.equal((await fs.stat(filePath)).size, 0);
  assert.equal(String((await fs.stat(filePath, { bigint: true })).nlink), '2');
  await assert.rejects(saveConversation(knowledgeRoot, record, { id }), /UUID collision/);
  assert.equal(String((await fs.stat(filePath, { bigint: true })).nlink), '2');
  const scrubbedStats = await fs.stat(filePath, { bigint: true });
  await assert.rejects(
    saveConversation(knowledgeRoot, record, {
      id,
      recoveryIdentity: `${scrubbedStats.dev}:${scrubbedStats.ino + 1n}`,
      allowUnidentifiedRecovery: true,
    }),
    /UUID collision/,
  );
  assert.equal(String((await fs.stat(filePath, { bigint: true })).nlink), '2');

  const saved = await saveConversation(knowledgeRoot, record, {
    id,
    allowUnidentifiedRecovery: true,
  });
  assert.equal(saved.recovered, true);
  assert.notEqual(saved.id, id);
  assert.equal(String((await fs.stat(filePath, { bigint: true })).nlink), '2');
  assert.equal(await fs.readFile(saved.filePath, 'utf8'), serializeConversation({ ...record, id: saved.id }));
  const [retainedTemp] = (await fs.readdir(dateRoot)).filter((name) => name.endsWith('.tmp'));
  assert.ok(retainedTemp);
  const retainedTempStats = await fs.stat(path.join(dateRoot, retainedTemp), { bigint: true });
  assert.equal(`${retainedTempStats.dev}:${retainedTempStats.ino}`, `${scrubbedStats.dev}:${scrubbedStats.ino}`);
  assert.equal(tempUnlinkFailures, 1);
});

test('saveConversation republishes a scrubbed UUID under a fresh no-clobber ID', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-published-recovery-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const dateRoot = path.join(knowledgeRoot, 'conversations', '2026-08-30');
  const id = '123e4567-e89b-42d3-a456-426614174018';
  const filePath = path.join(dateRoot, `${id}.md`);
  const record = conversation();
  const markdown = serializeConversation({ ...record, id });
  await fs.mkdir(dateRoot, { recursive: true });
  let publishError;
  try {
    await atomicWriteFile(filePath, markdown, {
      noClobber: true,
      async validateTarget(_targetPath, stage) {
        if (stage === 'published') {
          throw new Error('simulated post-publication validation failure');
        }
      },
    });
  } catch (error) {
    publishError = error;
  }

  const saved = await saveConversation(knowledgeRoot, record, {
    id,
    recoveryIdentity: publishError.recoveryIdentity,
  });

  assert.equal(saved.recovered, true);
  assert.equal(saved.recoveredFrom, id);
  assert.notEqual(saved.id, id);
  assert.equal((await fs.stat(filePath)).size, 0);
  assert.equal(await fs.readFile(saved.filePath, 'utf8'), serializeConversation({ ...record, id: saved.id }));

  const repeated = await saveConversation(knowledgeRoot, record, {
    id,
    recoveryIdentity: publishError.recoveryIdentity,
  });
  assert.equal(repeated.id, saved.id);
  assert.equal(repeated.alreadyExisted, true);
  assert.equal((await fs.readdir(dateRoot)).filter((name) => name.endsWith('.md')).length, 2);
});

test('saveConversation does not recover a scrubbed UUID with a different identity', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-recovery-mismatch-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174019';
  const filePath = path.join(knowledgeRoot, 'conversations', '2026-08-30', `${id}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '');
  const stat = await fs.stat(filePath, { bigint: true });

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      id,
      recoveryIdentity: `${stat.dev}:${stat.ino + 1n}`,
      allowUnidentifiedRecovery: true,
    }),
    /Conversation UUID collision/,
  );
  assert.equal((await fs.stat(filePath)).size, 0);
});

test('saveConversation never uses a matching identity to overwrite non-empty content', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-recovery-content-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174020';
  const filePath = path.join(knowledgeRoot, 'conversations', '2026-08-30', `${id}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'incumbent audit');
  const stat = await fs.stat(filePath, { bigint: true });

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      id,
      recoveryIdentity: `${stat.dev}:${stat.ino}`,
      allowUnidentifiedRecovery: true,
    }),
    /Conversation UUID collision/,
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), 'incumbent audit');
});

test('saveConversation does not recover a scrubbed UUID with another hard link', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-recovery-link-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const knowledgeRoot = path.join(temporaryRoot, 'knowledge-database');
  const id = '123e4567-e89b-42d3-a456-426614174021';
  const filePath = path.join(knowledgeRoot, 'conversations', '2026-08-30', `${id}.md`);
  const aliasPath = path.join(temporaryRoot, 'alias.md');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '');
  await fs.link(filePath, aliasPath);
  const stat = await fs.stat(filePath, { bigint: true });

  await assert.rejects(
    saveConversation(knowledgeRoot, conversation(), {
      id,
      recoveryIdentity: `${stat.dev}:${stat.ino}`,
      allowUnidentifiedRecovery: true,
    }),
    /Conversation UUID collision/,
  );
  assert.equal((await fs.stat(filePath)).size, 0);
  assert.equal((await fs.stat(aliasPath)).size, 0);
});

test('recursive scan excludes temp files, oversized files, and files beyond its cap', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const nested = path.join(temporaryRoot, 'conversations', '2026-08-30');
  await fs.mkdir(nested, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(nested, 'a.md'), 'small-a', 'utf8'),
    fs.writeFile(path.join(nested, 'b.md'), 'small-b', 'utf8'),
    fs.writeFile(path.join(nested, 'draft.tmp.md'), 'temporary', 'utf8'),
    fs.writeFile(path.join(nested, 'large.md'), 'x'.repeat(200), 'utf8')
  ]);

  const scan = await scanMarkdownFiles(temporaryRoot, { maxFiles: 2, maxFileBytes: 100 });

  assert.equal(scan.stats.consideredFiles, 2);
  assert.ok(scan.documents.length <= 2);
  assert.equal(scan.documents.some((document) => document.path.endsWith('draft.tmp.md')), false);
  assert.equal(scan.stats.limitReached, true);
});

test('recursive scan exposes a conversation only after its publication temp link is removed', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-publish-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'conversation.md');
  const tempPath = path.join(
    temporaryRoot,
    `.conversation.md.123.${crypto.randomUUID()}.tmp`,
  );
  const contents = 'committed conversation';

  await fs.writeFile(filePath, contents, 'utf8');
  await fs.link(filePath, tempPath);

  const inProgress = await scanMarkdownFiles(temporaryRoot);
  assert.equal(inProgress.stats.failedFiles, 1);
  assert.deepEqual(inProgress.documents, []);

  await fs.truncate(filePath, 0);
  const failed = await scanMarkdownFiles(temporaryRoot);
  assert.equal(failed.stats.failedFiles, 1);
  assert.deepEqual(failed.documents, []);

  await fs.unlink(tempPath);
  await fs.unlink(filePath);
  await fs.writeFile(filePath, contents, 'utf8');
  await fs.link(filePath, tempPath);
  await fs.unlink(tempPath);

  const committed = await scanMarkdownFiles(temporaryRoot);
  assert.equal(committed.stats.failedFiles, 0);
  assert.equal(committed.stats.loadedFiles, 1);
  assert.equal(committed.documents[0].content, contents);
});

test('recursive scan does not report its limit for exactly max files plus an empty directory', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-exact-limit-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporaryRoot, 'a-empty'));
  await fs.writeFile(path.join(temporaryRoot, 'z.md'), 'one file');

  const scan = await scanMarkdownFiles(temporaryRoot, { maxFiles: 1 });

  assert.equal(scan.stats.loadedFiles, 1);
  assert.equal(scan.stats.limitReached, false);
});

test('recursive scan still reports a Markdown file beyond the cap in a deferred directory', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-deferred-limit-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporaryRoot, 'a-deferred'));
  await fs.writeFile(path.join(temporaryRoot, 'z.md'), 'first file');
  await fs.writeFile(path.join(temporaryRoot, 'a-deferred', 'extra.md'), 'extra file');

  const scan = await scanMarkdownFiles(temporaryRoot, { maxFiles: 1 });

  assert.equal(scan.stats.loadedFiles, 1);
  assert.equal(scan.stats.limitReached, true);
});

test('recursive scan stops before exceeding its aggregate byte limit', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-byte-limit-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporaryRoot, 'a.md'), 'a'.repeat(60), 'utf8');
  await fs.writeFile(path.join(temporaryRoot, 'b.md'), 'b'.repeat(60), 'utf8');

  const scan = await scanMarkdownFiles(temporaryRoot, {
    maxFiles: 10,
    maxFileBytes: 100,
    maxTotalBytes: 100
  });

  assert.equal(scan.stats.byteLimitReached, true);
  assert.equal(scan.stats.loadedFiles, 1);
  assert.equal(scan.stats.loadedBytes, 60);
});

test('recursive scan reports a missing knowledge root as a read failure', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-missing-root-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const scan = await scanMarkdownFiles(path.join(temporaryRoot, 'missing'));

  assert.equal(scan.stats.failedFiles, 1);
  assert.equal(scan.documents.length, 0);
});

test('recursive scan rejects a project path replaced after its boundary is pinned', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-boundary-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const outsideProject = path.join(temporaryRoot, 'outside');
  await fs.mkdir(knowledgeRoot, { recursive: true });
  await fs.mkdir(path.join(outsideProject, 'knowledge-database'), { recursive: true });
  await fs.writeFile(path.join(outsideProject, 'knowledge-database', 'outside.md'), 'outside');
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  await fs.rename(projectRoot, path.join(temporaryRoot, 'retained-project'));
  try {
    await fs.symlink(outsideProject, projectRoot, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      return;
    }
    throw error;
  }

  const scan = await scanMarkdownFiles(knowledgeRoot, { canonicalProjectRoot });

  assert.equal(scan.stats.failedFiles, 1);
  assert.equal(scan.documents.length, 0);
});

test('recursive scan rejects a transient empty project replacement during enumeration', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-transient-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const retainedProjectRoot = path.join(temporaryRoot, 'retained-project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  await fs.writeFile(path.join(knowledgeRoot, 'required.md'), 'required knowledge');
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const projectStat = await fs.stat(projectRoot, { bigint: true });
  const pinned = await assertKnowledgeDatabaseReady(knowledgeRoot, canonicalProjectRoot, {
    projectRootIsCanonical: true,
  });
  const originalReaddir = fs.readdir;
  let swapped = false;
  fs.readdir = async (directory, ...arguments_) => {
    if (!swapped && directory === knowledgeRoot) {
      swapped = true;
      await fs.rename(projectRoot, retainedProjectRoot);
      await fs.mkdir(knowledgeRoot, { recursive: true });
      const entries = await originalReaddir(directory, ...arguments_);
      await fs.rm(projectRoot, { recursive: true, force: true });
      await fs.rename(retainedProjectRoot, projectRoot);
      return entries;
    }
    return originalReaddir(directory, ...arguments_);
  };
  t.after(() => {
    fs.readdir = originalReaddir;
  });

  let scan;
  try {
    scan = await scanMarkdownFiles(knowledgeRoot, {
      canonicalProjectRoot,
      expectedProjectIdentity: `${projectStat.dev}:${projectStat.ino}`,
      expectedCanonicalKnowledgeRoot: pinned.canonicalKnowledgeRoot,
      expectedKnowledgeIdentity: pinned.knowledgeIdentity,
    });
  } finally {
    fs.readdir = originalReaddir;
  }
  assert.equal(swapped, true);
  assert.equal(scan.stats.failedFiles, 1);
  assert.deepEqual(scan.documents, []);
});

test('recursive scan rejects a transient oversized replacement of the same Markdown path', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-oversized-remap-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const retainedProjectRoot = path.join(temporaryRoot, 'retained-project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const filePath = path.join(knowledgeRoot, 'required.md');
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  await fs.writeFile(filePath, 'required knowledge');
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const projectStat = await fs.stat(projectRoot, { bigint: true });
  const pinned = await assertKnowledgeDatabaseReady(knowledgeRoot, canonicalProjectRoot, {
    projectRootIsCanonical: true,
  });
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  let swapped = false;
  let restored = false;
  fs.lstat = async (targetPath, ...arguments_) => {
    if (!swapped && targetPath === filePath && arguments_[0] === undefined) {
      swapped = true;
      await fs.rename(projectRoot, retainedProjectRoot);
      await fs.mkdir(knowledgeRoot, { recursive: true });
      await fs.writeFile(filePath, 'x'.repeat(256));
    }
    return originalLstat(targetPath, ...arguments_);
  };
  fs.open = async (targetPath, ...arguments_) => {
    const handle = await originalOpen(targetPath, ...arguments_);
    if (swapped && !restored && targetPath === filePath) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              await target.close();
              if (!restored) {
                restored = true;
                await fs.rm(projectRoot, { recursive: true, force: true });
                await fs.rename(retainedProjectRoot, projectRoot);
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

  let scan;
  try {
    scan = await scanMarkdownFiles(knowledgeRoot, {
      canonicalProjectRoot,
      expectedProjectIdentity: `${projectStat.dev}:${projectStat.ino}`,
      expectedCanonicalKnowledgeRoot: pinned.canonicalKnowledgeRoot,
      expectedKnowledgeIdentity: pinned.knowledgeIdentity,
      maxFileBytes: 64,
    });
  } finally {
    fs.lstat = originalLstat;
    fs.open = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(restored, true);
  assert.equal(scan.stats.oversizedFiles, 1);
  assert.equal(scan.stats.failedFiles, 1);
  assert.deepEqual(scan.documents, []);
});

test('recursive scan rejects a transient read failure from a same-path replacement', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-scan-read-remap-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  const retainedProjectRoot = path.join(temporaryRoot, 'retained-project');
  const knowledgeRoot = path.join(projectRoot, 'knowledge-database');
  const filePath = path.join(knowledgeRoot, 'required.md');
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  await fs.writeFile(filePath, 'required knowledge');
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const projectStat = await fs.stat(projectRoot, { bigint: true });
  const pinned = await assertKnowledgeDatabaseReady(knowledgeRoot, canonicalProjectRoot, {
    projectRootIsCanonical: true,
  });
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  let swapped = false;
  let restored = false;
  fs.lstat = async (targetPath, ...arguments_) => {
    if (!swapped && targetPath === filePath && arguments_[0] === undefined) {
      swapped = true;
      await fs.rename(projectRoot, retainedProjectRoot);
      await fs.mkdir(knowledgeRoot, { recursive: true });
      await fs.writeFile(filePath, 'replacement knowledge');
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
                await fs.rm(projectRoot, { recursive: true, force: true });
                await fs.rename(retainedProjectRoot, projectRoot);
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

  let scan;
  try {
    scan = await scanMarkdownFiles(knowledgeRoot, {
      canonicalProjectRoot,
      expectedProjectIdentity: `${projectStat.dev}:${projectStat.ino}`,
      expectedCanonicalKnowledgeRoot: pinned.canonicalKnowledgeRoot,
      expectedKnowledgeIdentity: pinned.knowledgeIdentity,
    });
  } finally {
    fs.lstat = originalLstat;
    fs.open = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(restored, true);
  assert.ok(scan.stats.failedFiles > 0);
  assert.deepEqual(scan.documents, []);
});
