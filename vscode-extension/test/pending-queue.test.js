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
    knowledgeRoot: path.join(root, 'project', 'knowledge-database'),
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

test('pending queue durably stores and flushes a conversation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);
  const saved = [];

  await enqueuePendingConversation(queueRoot, pending);
  const result = await flushPendingConversations(queueRoot, {
    knowledgeRoot: pending.knowledgeRoot,
    async save(value) {
      saved.push(value);
    },
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, pending.id);
  assert.deepEqual(result, { considered: 1, synced: 1, failed: 0, remaining: 0 });
  assert.deepEqual(await listQueueFiles(queueRoot), []);
});

test('pending queue leaves records for a different project untouched', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const pending = entry(root);

  await enqueuePendingConversation(queueRoot, pending);
  const result = await flushPendingConversations(queueRoot, {
    knowledgeRoot: path.join(root, 'other', 'knowledge-database'),
    async save() {
      throw new Error('must not run');
    },
  });

  assert.deepEqual(result, { considered: 0, synced: 0, failed: 0, remaining: 0 });
  assert.equal((await listQueueFiles(queueRoot)).length, 1);
});

test('pending queue filters by project before applying the flush limit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collaborare-pending-fair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue');
  const other = entry(root, '123e4567-e89b-42d3-a456-426614174001');
  other.knowledgeRoot = path.join(root, 'other', 'knowledge-database');
  const current = entry(root, '123e4567-e89b-42d3-a456-426614174099');
  await enqueuePendingConversation(queueRoot, other);
  await enqueuePendingConversation(queueRoot, current);
  const saved = [];

  const result = await flushPendingConversations(queueRoot, {
    knowledgeRoot: current.knowledgeRoot,
    limit: 1,
    async save(value) {
      saved.push(value.id);
    },
  });

  assert.deepEqual(saved, [current.id]);
  assert.equal(result.remaining, 0);
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
