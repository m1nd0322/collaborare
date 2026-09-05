'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  enqueuePendingConversation,
  flushPendingConversations,
  listQueueFiles,
} = require('../src/pending-queue');

function entry(root, id = '123e4567-e89b-42d3-a456-426614174010') {
  return {
    id,
    projectRoot: path.join(root, 'project'),
    canonicalProjectRoot: path.join(root, 'canonical-project'),
    projectIdentity: '1:100',
    knowledgeRoot: path.join(root, 'project', 'knowledge-database'),
    canonicalKnowledgeRoot: path.join(root, 'canonical-project', 'knowledge-database'),
    knowledgeIdentity: '1:101',
    canonicalConversationsRoot: path.join(root, 'canonical-project', 'knowledge-database', 'conversations'),
    conversationsIdentity: '1:102',
    canonicalDateRoot: path.join(root, 'canonical-project', 'knowledge-database', 'conversations', '2026-08-30'),
    dateIdentity: '1:103',
    conversation: {
      project: 'project',
      account: 'account',
      machine: 'machine',
      questionAt: '2026-08-30T10:00:00.000Z',
      responseAt: '2026-08-30T10:00:01.000Z',
      model: 'model',
      status: 'complete',
      question: 'question',
      response: 'response',
    },
  };
}

function flushOptions(pending, overrides = {}) {
  return {
    projectRoot: pending.projectRoot,
    knowledgeRoot: pending.knowledgeRoot,
    canonicalProjectRoot: pending.canonicalProjectRoot,
    projectIdentity: pending.projectIdentity,
    canonicalKnowledgeRoot: pending.canonicalKnowledgeRoot,
    knowledgeIdentity: pending.knowledgeIdentity,
    canonicalConversationsRoot: pending.canonicalConversationsRoot,
    conversationsIdentity: pending.conversationsIdentity,
    async pinDate() {
      return {
        canonicalDateRoot: pending.canonicalDateRoot,
        dateIdentity: pending.dateIdentity,
      };
    },
    ...overrides,
  };
}

test('pending queue durably stores and flushes a conversation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const saved = [];

  await enqueuePendingConversation(queueRoot, pending);
  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save(value) {
      saved.push(value);
    },
  }));

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, pending.id);
  assert.deepEqual(result, { considered: 1, synced: 1, failed: 0, remaining: 0, unmatched: 0, legacy: 0 });
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue preserves a new record when post-rename verification fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-verify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const queuePath = path.join(queueRoot, `${pending.id}.json`);
  const originalReadFile = fs.readFile;
  let queueReads = 0;
  fs.readFile = async (...arguments_) => {
    if (arguments_[0] === queuePath) {
      queueReads += 1;
      if (queueReads === 2) {
        const error = new Error('transient post-rename read failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalReadFile(...arguments_);
  };
  t.after(() => {
    fs.readFile = originalReadFile;
  });

  try {
    await assert.rejects(
      enqueuePendingConversation(queueRoot, pending),
      /transient post-rename read failure/,
    );
  } finally {
    fs.readFile = originalReadFile;
  }
  assert.equal(queueReads, 2);
  assert.equal(JSON.parse(await fs.readFile(queuePath, 'utf8')).id, pending.id);

  let saved = 0;
  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save() {
      saved += 1;
    },
  }));
  assert.equal(saved, 1);
  assert.deepEqual(result, { considered: 1, synced: 1, failed: 0, remaining: 0, unmatched: 0, legacy: 0 });
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue treats the same UUID and payload as an idempotent enqueue', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-idempotent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);

  const first = await enqueuePendingConversation(queueRoot, pending);
  const second = await enqueuePendingConversation(queueRoot, pending);

  assert.equal(first.alreadyExisted, false);
  assert.equal(second.alreadyExisted, true);
  assert.deepEqual(await listQueueFiles(queueRoot), [first.filePath]);
});

test('pending queue treats a changed date identity as a UUID collision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-date-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  await enqueuePendingConversation(queueRoot, pending);

  await assert.rejects(
    enqueuePendingConversation(queueRoot, { ...pending, dateIdentity: '9:903' }),
    /Pending conversation UUID collision/,
  );
  assert.equal(JSON.parse(await fs.readFile(
    path.join(queueRoot, `${pending.id}.json`),
    'utf8',
  )).dateIdentity, pending.dateIdentity);
});

test('pending queue treats a changed recovery identity as a UUID collision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-recovery-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = { ...entry(root), recoveryIdentity: '1:104' };
  await enqueuePendingConversation(queueRoot, pending);

  await assert.rejects(
    enqueuePendingConversation(queueRoot, { ...pending, recoveryIdentity: '1:105' }),
    /Pending conversation UUID collision/,
  );
  assert.equal(JSON.parse(await fs.readFile(
    path.join(queueRoot, `${pending.id}.json`),
    'utf8',
  )).recoveryIdentity, pending.recoveryIdentity);
});

test('pending queue persists a recovery identity emitted by a failed save', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-recovery-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const queuePath = path.join(queueRoot, `${pending.id}.json`);
  await enqueuePendingConversation(queueRoot, pending);

  const first = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save(value) {
      assert.equal(value.recoveryIdentity, undefined);
      const error = new Error('post-publication failure');
      error.recoveryIdentity = '1:104';
      error.recoveryId = '123e4567-e89b-42d3-a456-426614174011';
      throw error;
    },
  }));

  assert.deepEqual(first, {
    considered: 1,
    synced: 0,
    failed: 1,
    remaining: 1,
    unmatched: 0,
    legacy: 0,
  });
  assert.equal(JSON.parse(await fs.readFile(queuePath, 'utf8')).recoveryIdentity, '1:104');
  assert.equal(
    JSON.parse(await fs.readFile(queuePath, 'utf8')).recoveryId,
    '123e4567-e89b-42d3-a456-426614174011',
  );

  let receivedRecoveryIdentity;
  let receivedRecoveryId;
  const second = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save(value) {
      receivedRecoveryIdentity = value.recoveryIdentity;
      receivedRecoveryId = value.recoveryId;
    },
  }));
  assert.equal(receivedRecoveryIdentity, '1:104');
  assert.equal(receivedRecoveryId, '123e4567-e89b-42d3-a456-426614174011');
  assert.equal(second.synced, 1);
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue isolates a malformed recovery identity to the corrupt record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-recovery-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  await fs.mkdir(queueRoot);
  await fs.writeFile(
    path.join(queueRoot, `${pending.id}.json`),
    `${JSON.stringify({ ...pending, version: 2, recoveryIdentity: '0:1' })}\n`,
    'utf8',
  );

  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save() {
      throw new Error('must not publish a malformed queue record');
    },
  }));

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 1, remaining: 1, unmatched: 0, legacy: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue rejects new records without a pinned knowledge identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  delete pending.canonicalKnowledgeRoot;
  delete pending.knowledgeIdentity;

  await assert.rejects(
    enqueuePendingConversation(queueRoot, pending),
    /knowledge identity is incomplete/,
  );
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue rejects new records without a pinned conversations identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-conversations-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  delete pending.canonicalConversationsRoot;
  delete pending.conversationsIdentity;

  await assert.rejects(
    enqueuePendingConversation(queueRoot, pending),
    /conversation identity is incomplete/,
  );
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue rejects new records without a pinned date identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-date-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  delete pending.canonicalDateRoot;
  delete pending.dateIdentity;

  await assert.rejects(
    enqueuePendingConversation(queueRoot, pending),
    /date identity is incomplete/,
  );
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue migrates a legacy v1 record only after explicit approval', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-v1-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const filePath = path.join(queueRoot, `${pending.id}.json`);
  const legacy = {
    version: 1,
    queuedAt: '2026-08-30T10:00:02.000Z',
    id: pending.id,
    projectRoot: pending.projectRoot,
    knowledgeRoot: pending.knowledgeRoot,
    recoveryIdentity: '9:999',
    recoveryId: '123e4567-e89b-42d3-a456-426614174011',
    conversation: pending.conversation,
  };
  await fs.mkdir(queueRoot);
  await fs.writeFile(filePath, `${JSON.stringify(legacy)}\n`, 'utf8');

  let saveCalls = 0;
  const unapproved = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save() {
      saveCalls += 1;
    },
  }));
  const unchanged = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(unapproved, {
    considered: 0,
    synced: 0,
    failed: 0,
    remaining: 0,
    unmatched: 0,
    legacy: 1,
  });
  assert.equal(saveCalls, 0);
  assert.equal(unchanged.version, 1);

  const first = await flushPendingConversations(queueRoot, flushOptions(pending, {
    approvedLegacyEntries: [legacy],
    async save() {
      throw new Error('share unavailable');
    },
  }));
  const migrated = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(first, {
    considered: 1,
    synced: 0,
    failed: 1,
    remaining: 1,
    unmatched: 0,
    legacy: 0,
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.canonicalProjectRoot, pending.canonicalProjectRoot);
  assert.equal(migrated.projectIdentity, pending.projectIdentity);
  assert.equal(migrated.canonicalKnowledgeRoot, pending.canonicalKnowledgeRoot);
  assert.equal(migrated.knowledgeIdentity, pending.knowledgeIdentity);
  assert.equal(migrated.canonicalConversationsRoot, pending.canonicalConversationsRoot);
  assert.equal(migrated.conversationsIdentity, pending.conversationsIdentity);
  assert.equal(migrated.canonicalDateRoot, pending.canonicalDateRoot);
  assert.equal(migrated.dateIdentity, pending.dateIdentity);
  assert.equal(Object.hasOwn(migrated, 'recoveryIdentity'), false);
  assert.equal(Object.hasOwn(migrated, 'recoveryId'), false);

  const saved = [];
  const second = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save(value) {
      saved.push(value);
    },
  }));

  assert.deepEqual(second, {
    considered: 1,
    synced: 1,
    failed: 0,
    remaining: 0,
    unmatched: 0,
    legacy: 0,
  });
  assert.equal(saved[0].version, 2);
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue preserves a migrated v1 record when post-replace verification fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-v1-verify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const filePath = path.join(queueRoot, `${pending.id}.json`);
  const legacy = {
    version: 1,
    queuedAt: '2026-08-30T10:00:02.000Z',
    id: pending.id,
    projectRoot: pending.projectRoot,
    knowledgeRoot: pending.knowledgeRoot,
    conversation: pending.conversation,
  };
  await fs.mkdir(queueRoot);
  await fs.writeFile(filePath, `${JSON.stringify(legacy)}\n`, 'utf8');

  const originalReadFile = fs.readFile;
  let queueReads = 0;
  fs.readFile = async (...arguments_) => {
    if (arguments_[0] === filePath) {
      queueReads += 1;
      if (queueReads === 3) {
        const error = new Error('transient post-replace read failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalReadFile(...arguments_);
  };
  t.after(() => {
    fs.readFile = originalReadFile;
  });

  let result;
  try {
    result = await flushPendingConversations(queueRoot, flushOptions(pending, {
      approvedLegacyEntries: [legacy],
      async save() {
        throw new Error('must not publish after migration verification fails');
      },
    }));
  } finally {
    fs.readFile = originalReadFile;
  }
  const migrated = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(result, { considered: 1, synced: 0, failed: 1, remaining: 1, unmatched: 0, legacy: 0 });
  assert.equal(queueReads, 3);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.knowledgeIdentity, pending.knowledgeIdentity);
});

test('pending queue isolates malformed v2 path fields to the corrupt record', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-malformed-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const malformed = {
    ...pending,
    version: 2,
    canonicalProjectRoot: { toString: null },
  };
  await fs.mkdir(queueRoot);
  await fs.writeFile(
    path.join(queueRoot, `${pending.id}.json`),
    `${JSON.stringify(malformed)}\n`,
    'utf8',
  );

  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save() {
      throw new Error('must not publish a malformed queue record');
    },
  }));

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 1, remaining: 1, unmatched: 0, legacy: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue leaves records for a different project untouched', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);

  await enqueuePendingConversation(queueRoot, pending);
  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    knowledgeRoot: path.join(root, 'other', 'knowledge-database'),
    canonicalKnowledgeRoot: path.join(root, 'other-canonical', 'knowledge-database'),
    knowledgeIdentity: '2:201',
    async save() {
      throw new Error('must not run');
    },
  }));

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 0, remaining: 0, unmatched: 1, legacy: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue counts corrupt JSON as failed and remaining', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  await fs.mkdir(queueRoot);
  await fs.writeFile(path.join(queueRoot, 'corrupt.json'), '{not-json', 'utf8');

  const pending = entry(root);
  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    async save() {
      throw new Error('must not run');
    },
  }));

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 1, remaining: 1, unmatched: 0, legacy: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue filters by project before applying the flush limit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-fair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const other = entry(root, '123e4567-e89b-42d3-a456-426614174001');
  other.knowledgeRoot = path.join(root, 'other', 'knowledge-database');
  other.canonicalProjectRoot = path.join(root, 'other-canonical-project');
  other.projectIdentity = '2:200';
  other.canonicalKnowledgeRoot = path.join(root, 'other-canonical-project', 'knowledge-database');
  other.knowledgeIdentity = '2:201';
  const current = entry(root, '123e4567-e89b-42d3-a456-426614174099');
  await enqueuePendingConversation(queueRoot, other);
  await enqueuePendingConversation(queueRoot, current);
  const saved = [];

  const result = await flushPendingConversations(queueRoot, flushOptions(current, {
    limit: 1,
    async save(value) {
      saved.push(value.id);
    },
  }));

  assert.deepEqual(saved, [current.id]);
  assert.equal(result.remaining, 0);
  assert.equal(result.unmatched, 1);
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue enforces local file and aggregate byte limits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  await enqueuePendingConversation(queueRoot, entry(root), { maxFiles: 1, maxTotalBytes: 1024 * 1024 });

  await assert.rejects(
    enqueuePendingConversation(
      queueRoot,
      entry(root, '123e4567-e89b-42d3-a456-426614174011'),
      { maxFiles: 1, maxTotalBytes: 1024 * 1024 },
    ),
    /file limit reached/,
  );
  await assert.rejects(
    enqueuePendingConversation(
      path.join(root, 'byte-queue'),
      entry(root),
      { maxFiles: 10, maxTotalBytes: 1 },
    ),
    /byte limit reached/,
  );
});

test('pending queue enforces its file limit across concurrent enqueue attempts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-concurrent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');

  const results = await Promise.allSettled([
    enqueuePendingConversation(queueRoot, entry(root), { maxFiles: 1 }),
    enqueuePendingConversation(
      queueRoot,
      entry(root, '123e4567-e89b-42d3-a456-426614174012'),
      { maxFiles: 1 },
    ),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('flush deletion cannot race an enqueue size scan', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-flush-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const existing = entry(root);
  const incoming = entry(root, '123e4567-e89b-42d3-a456-426614174013');
  await enqueuePendingConversation(queueRoot, existing);

  const existingPath = path.join(queueRoot, `${existing.id}.json`);
  const originalStat = fs.stat;
  let releaseStat;
  let statReached;
  const statWasReached = new Promise((resolve) => {
    statReached = resolve;
  });
  const allowStat = new Promise((resolve) => {
    releaseStat = resolve;
  });
  fs.stat = async (...arguments_) => {
    if (arguments_[0] === existingPath) {
      statReached();
      await allowStat;
    }
    return originalStat(...arguments_);
  };
  t.after(() => {
    fs.stat = originalStat;
  });

  const enqueuePromise = enqueuePendingConversation(queueRoot, incoming);
  await statWasReached;
  const flushPromise = flushPendingConversations(queueRoot, flushOptions(existing, {
    async save() {},
  }));
  releaseStat();

  await Promise.all([enqueuePromise, flushPromise]);
  assert.deepEqual(
    (await listQueueFiles(queueRoot)).map((filePath) => path.basename(filePath)),
    [`${incoming.id}.json`],
  );
});

test('pending queue refuses a lexical path remapped to a different project identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-remap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  await enqueuePendingConversation(queueRoot, pending);

  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    canonicalProjectRoot: path.join(root, 'replacement-project'),
    projectIdentity: '9:900',
    canonicalKnowledgeRoot: path.join(root, 'replacement-project', 'knowledge-database'),
    knowledgeIdentity: '9:901',
    async save() {
      throw new Error('must not publish into a remapped project');
    },
  }));

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 0, remaining: 0, unmatched: 1, legacy: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue refuses a replaced conversations root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-conversations-remap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  await enqueuePendingConversation(queueRoot, pending);

  const result = await flushPendingConversations(queueRoot, flushOptions(pending, {
    conversationsIdentity: '9:902',
    async save() {
      throw new Error('must not publish into a replaced conversations root');
    },
  }));

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 0, remaining: 0, unmatched: 1, legacy: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue does not steal an old lock without proving ownership', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const lockRoot = path.join(queueRoot, '.enqueue-lock');
  await fs.mkdir(lockRoot, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lockRoot, old, old);

  await assert.rejects(
    enqueuePendingConversation(queueRoot, entry(root), {
      lockAttempts: 2,
      lockDelayMs: 1,
    }),
    /Timed out waiting for the local pending queue lock/,
  );
  assert.equal((await listQueueFiles(queueRoot)).length, 0);
  assert.equal((await fs.stat(lockRoot)).isDirectory(), true);
});
