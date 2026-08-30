'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { atomicWriteFile } = require('./knowledge-store');

const QUEUE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUEUE_LOCK_NAME = '.enqueue-lock';

function normalizePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Pending conversation entry must be an object.');
  }
  if (!UUID_PATTERN.test(String(entry.id || ''))) {
    throw new Error('Pending conversation entry must have a UUID.');
  }
  if (!entry.knowledgeRoot || !entry.projectRoot || !entry.conversation) {
    throw new Error('Pending conversation entry is incomplete.');
  }
  return entry;
}

async function listQueueFiles(queueRoot) {
  try {
    const entries = await fs.readdir(queueRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => path.join(queueRoot, entry.name))
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireQueueLock(queueRoot) {
  const lockPath = path.join(queueRoot, QUEUE_LOCK_NAME);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
      try {
        const lockStats = await fs.stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > 60_000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!statError || statError.code !== 'ENOENT') {
          throw statError;
        }
      }
      await wait(25);
    }
  }
  throw new Error('Timed out waiting for the local pending queue lock.');
}

async function enqueuePendingConversation(queueRoot, entry, options = {}) {
  const validated = validateEntry(entry);
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0
    ? options.maxFiles
    : 500;
  const maxTotalBytes = Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes > 0
    ? options.maxTotalBytes
    : 33554432;
  await fs.mkdir(queueRoot, { recursive: true });
  const releaseLock = await acquireQueueLock(queueRoot);
  try {
    const filePath = path.join(queueRoot, `${validated.id}.json`);
    const payload = `${JSON.stringify({
      version: QUEUE_VERSION,
      queuedAt: new Date().toISOString(),
      ...validated,
    })}\n`;

    try {
      const existing = await fs.readFile(filePath, 'utf8');
      const existingEntry = JSON.parse(existing);
      const sameEntry = existingEntry.id === validated.id
        && existingEntry.projectRoot === validated.projectRoot
        && existingEntry.knowledgeRoot === validated.knowledgeRoot
        && JSON.stringify(existingEntry.conversation) === JSON.stringify(validated.conversation);
      if (sameEntry) {
        return { filePath, alreadyExisted: true };
      }
      throw new Error(`Pending conversation UUID collision: ${validated.id}`);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }

    const queueFiles = await listQueueFiles(queueRoot);
    if (queueFiles.length >= maxFiles) {
      throw new Error(`Local pending queue file limit reached (${maxFiles}).`);
    }
    let currentBytes = 0;
    for (const queueFile of queueFiles) {
      currentBytes += (await fs.stat(queueFile)).size;
      if (currentBytes + Buffer.byteLength(payload) > maxTotalBytes) {
        throw new Error(`Local pending queue byte limit reached (${maxTotalBytes}).`);
      }
    }
    if (currentBytes + Buffer.byteLength(payload) > maxTotalBytes) {
      throw new Error(`Local pending queue byte limit reached (${maxTotalBytes}).`);
    }

    await atomicWriteFile(filePath, payload);
    return { filePath, alreadyExisted: false };
  } finally {
    await releaseLock();
  }
}

async function flushPendingConversations(queueRoot, options) {
  if (!options || typeof options.save !== 'function') {
    throw new TypeError('A save callback is required to flush pending conversations.');
  }

  const targetRoot = normalizePath(options.knowledgeRoot);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const files = await listQueueFiles(queueRoot);
  const stats = { considered: 0, synced: 0, failed: 0, remaining: 0 };
  const matching = [];

  for (const filePath of files) {
    let entry;
    try {
      entry = validateEntry(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (_error) {
      stats.failed += 1;
      continue;
    }
    if (normalizePath(entry.knowledgeRoot) !== targetRoot) {
      continue;
    }

    matching.push({ entry, filePath });
  }

  for (const { entry, filePath } of matching.slice(0, limit)) {
    stats.considered += 1;
    try {
      await options.save(entry);
      await fs.unlink(filePath);
      stats.synced += 1;
    } catch (_error) {
      stats.failed += 1;
    }
  }

  stats.remaining = Math.max(0, matching.length - stats.synced);
  return stats;
}

module.exports = {
  QUEUE_VERSION,
  enqueuePendingConversation,
  flushPendingConversations,
  listQueueFiles,
  validateEntry,
};
