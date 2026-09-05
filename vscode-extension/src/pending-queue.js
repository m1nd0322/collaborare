'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { atomicWriteFile, isValidFilesystemIdentity } = require('./knowledge-store');

const QUEUE_VERSION = 2;
const LEGACY_QUEUE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUEUE_LOCK_NAME = '.enqueue-lock';

function normalizePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Pending conversation entry must be an object.');
  }
  if (entry.version !== QUEUE_VERSION && entry.version !== LEGACY_QUEUE_VERSION) {
    throw new Error(`Unsupported pending conversation version: ${entry.version}`);
  }
  if (!isNonEmptyString(entry.id) || !UUID_PATTERN.test(entry.id)) {
    throw new Error('Pending conversation entry must have a UUID.');
  }
  if (!isNonEmptyString(entry.knowledgeRoot)
    || !isNonEmptyString(entry.projectRoot)
    || !entry.conversation
    || typeof entry.conversation !== 'object'
    || Array.isArray(entry.conversation)) {
    throw new Error('Pending conversation entry is incomplete.');
  }
  if (entry.version === QUEUE_VERSION
    && (!isNonEmptyString(entry.canonicalProjectRoot)
      || !isNonEmptyString(entry.projectIdentity))) {
    throw new Error('Pending conversation project identity is incomplete.');
  }
  if (entry.version === QUEUE_VERSION
    && (!isNonEmptyString(entry.canonicalKnowledgeRoot)
      || !isNonEmptyString(entry.knowledgeIdentity))) {
    throw new Error('Pending conversation knowledge identity is incomplete.');
  }
  if (entry.version === QUEUE_VERSION
    && (!isNonEmptyString(entry.canonicalConversationsRoot)
      || !isNonEmptyString(entry.conversationsIdentity))) {
    throw new Error('Pending conversation identity is incomplete.');
  }
  if (entry.version === QUEUE_VERSION
    && (!isNonEmptyString(entry.canonicalDateRoot)
      || !isNonEmptyString(entry.dateIdentity))) {
    throw new Error('Pending conversation date identity is incomplete.');
  }
  if (entry.version === QUEUE_VERSION
    && entry.recoveryIdentity !== undefined
    && !isValidFilesystemIdentity(entry.recoveryIdentity)) {
    throw new Error('Pending conversation recovery identity is invalid.');
  }
  if (entry.version === QUEUE_VERSION
    && entry.recoveryId !== undefined
    && (!isNonEmptyString(entry.recoveryId) || !UUID_PATTERN.test(entry.recoveryId))) {
    throw new Error('Pending conversation recovery ID is invalid.');
  }
  if (entry.version === QUEUE_VERSION
    && entry.recoveryId !== undefined
    && entry.recoveryIdentity === undefined) {
    throw new Error('Pending conversation recovery ID requires a recovery identity.');
  }
  return entry;
}

function entryPayloadsAreEqual(left, right) {
  return left.id === right.id
    && left.projectRoot === right.projectRoot
    && left.canonicalProjectRoot === right.canonicalProjectRoot
    && left.projectIdentity === right.projectIdentity
    && left.knowledgeRoot === right.knowledgeRoot
    && left.canonicalKnowledgeRoot === right.canonicalKnowledgeRoot
    && left.knowledgeIdentity === right.knowledgeIdentity
    && left.canonicalConversationsRoot === right.canonicalConversationsRoot
    && left.conversationsIdentity === right.conversationsIdentity
    && left.canonicalDateRoot === right.canonicalDateRoot
    && left.dateIdentity === right.dateIdentity
    && left.recoveryIdentity === right.recoveryIdentity
    && left.recoveryId === right.recoveryId
    && JSON.stringify(left.conversation) === JSON.stringify(right.conversation);
}

function entriesAreEqual(left, right) {
  return left.version === right.version
    && left.queuedAt === right.queuedAt
    && entryPayloadsAreEqual(left, right);
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

async function acquireQueueLock(queueRoot, options = {}) {
  const lockPath = path.join(queueRoot, QUEUE_LOCK_NAME);
  const ownerPath = path.join(lockPath, 'owner');
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const attempts = Number.isInteger(options.lockAttempts) && options.lockAttempts > 0
    ? options.lockAttempts
    : 200;
  const delayMs = Number.isInteger(options.lockDelayMs) && options.lockDelayMs >= 0
    ? options.lockDelayMs
    : 25;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(ownerPath, owner, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        try {
          const currentOwner = await fs.readFile(ownerPath, 'utf8');
          if (currentOwner !== owner) {
            throw new Error('The local pending queue lock owner changed before release.');
          }
          await fs.rm(lockPath, { recursive: true });
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
      await wait(delayMs);
    }
  }
  throw new Error('Timed out waiting for the local pending queue lock.');
}

async function enqueuePendingConversation(queueRoot, entry, options = {}) {
  const validated = validateEntry({ ...entry, version: QUEUE_VERSION });
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0
    ? options.maxFiles
    : 500;
  const maxTotalBytes = Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes > 0
    ? options.maxTotalBytes
    : 33554432;
  await fs.mkdir(queueRoot, { recursive: true });
  const releaseLock = await acquireQueueLock(queueRoot, options);
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
      const sameEntry = existingEntry.version === QUEUE_VERSION
        && entryPayloadsAreEqual(existingEntry, validated);
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
      try {
        currentBytes += (await fs.stat(queueFile)).size;
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      if (currentBytes + Buffer.byteLength(payload) > maxTotalBytes) {
        throw new Error(`Local pending queue byte limit reached (${maxTotalBytes}).`);
      }
    }
    if (currentBytes + Buffer.byteLength(payload) > maxTotalBytes) {
      throw new Error(`Local pending queue byte limit reached (${maxTotalBytes}).`);
    }

    await atomicWriteFile(filePath, payload, {
      preservePublishedOnError: true,
    });
    return { filePath, alreadyExisted: false };
  } finally {
    await releaseLock();
  }
}

async function pinLegacyEntry(queueRoot, filePath, legacyEntry, options, pinnedDate) {
  const releaseLock = await acquireQueueLock(queueRoot, options);
  try {
    const current = validateEntry(JSON.parse(await fs.readFile(filePath, 'utf8')));
    if (current.version === QUEUE_VERSION) {
      return current;
    }
    if (!entriesAreEqual(current, legacyEntry)) {
      throw new Error(`Pending conversation changed during migration: ${legacyEntry.id}`);
    }
    const migratedSource = { ...current };
    delete migratedSource.recoveryIdentity;
    delete migratedSource.recoveryId;
    const migrated = validateEntry({
      ...migratedSource,
      version: QUEUE_VERSION,
      canonicalProjectRoot: options.canonicalProjectRoot,
      projectIdentity: options.projectIdentity,
      canonicalKnowledgeRoot: options.canonicalKnowledgeRoot,
      knowledgeIdentity: options.knowledgeIdentity,
      canonicalConversationsRoot: options.canonicalConversationsRoot,
      conversationsIdentity: options.conversationsIdentity,
      canonicalDateRoot: pinnedDate.canonicalDateRoot,
      dateIdentity: pinnedDate.dateIdentity,
    });
    await atomicWriteFile(filePath, `${JSON.stringify(migrated)}\n`, {
      preservePublishedOnError: true,
    });
    return migrated;
  } finally {
    await releaseLock();
  }
}

async function persistRecoveryIdentity(
  queueRoot,
  filePath,
  expectedEntry,
  recoveryIdentity,
  recoveryId,
  options,
) {
  const releaseLock = await acquireQueueLock(queueRoot, options);
  try {
    const current = validateEntry(JSON.parse(await fs.readFile(filePath, 'utf8')));
    if (!entriesAreEqual(current, expectedEntry)) {
      throw new Error(`Pending conversation changed during synchronization: ${expectedEntry.id}`);
    }
    const updated = validateEntry({ ...current, recoveryIdentity, recoveryId });
    await atomicWriteFile(filePath, `${JSON.stringify(updated)}\n`, {
      preservePublishedOnError: true,
    });
    return updated;
  } finally {
    await releaseLock();
  }
}

async function listMatchingLegacyPendingConversations(queueRoot, options) {
  if (!options || !options.projectRoot || !options.knowledgeRoot) {
    throw new TypeError('Project and knowledge paths are required to inspect legacy pending conversations.');
  }
  const targetProjectRoot = normalizePath(options.projectRoot);
  const targetKnowledgeRoot = normalizePath(options.knowledgeRoot);
  const matching = [];
  for (const filePath of await listQueueFiles(queueRoot)) {
    try {
      const entry = validateEntry(JSON.parse(await fs.readFile(filePath, 'utf8')));
      if (entry.version === LEGACY_QUEUE_VERSION
        && normalizePath(entry.projectRoot) === targetProjectRoot
        && normalizePath(entry.knowledgeRoot) === targetKnowledgeRoot) {
        matching.push(entry);
      }
    } catch (_error) {
      // Corrupt records are reported by the normal flush path.
    }
  }
  return matching;
}

async function flushPendingConversations(queueRoot, options) {
  if (!options || typeof options.save !== 'function') {
    throw new TypeError('A save callback is required to flush pending conversations.');
  }

  if (!options.projectRoot
    || !options.knowledgeRoot
    || !options.canonicalProjectRoot
    || !options.projectIdentity
    || !options.canonicalKnowledgeRoot
    || !options.knowledgeIdentity
    || !options.canonicalConversationsRoot
    || !options.conversationsIdentity) {
    throw new TypeError('Canonical project, knowledge, and conversation identities are required to flush pending conversations.');
  }

  const targetProjectRoot = normalizePath(options.projectRoot);
  const targetRoot = normalizePath(options.knowledgeRoot);
  const targetCanonicalProjectRoot = normalizePath(options.canonicalProjectRoot);
  const targetCanonicalKnowledgeRoot = normalizePath(options.canonicalKnowledgeRoot);
  const targetCanonicalConversationsRoot = normalizePath(options.canonicalConversationsRoot);
  const approvedLegacyEntries = new Map(
    (Array.isArray(options.approvedLegacyEntries) ? options.approvedLegacyEntries : [])
      .map((entry) => [entry && entry.id, entry]),
  );
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 100;
  const files = await listQueueFiles(queueRoot);
  const stats = { considered: 0, synced: 0, failed: 0, remaining: 0, unmatched: 0, legacy: 0 };
  const matching = [];
  let unreadable = 0;

  for (const filePath of files) {
    try {
      const entry = validateEntry(JSON.parse(await fs.readFile(filePath, 'utf8')));
      const legacy = entry.version === LEGACY_QUEUE_VERSION;
      const lexicalProjectMatches = normalizePath(entry.projectRoot) === targetProjectRoot;
      const lexicalKnowledgeMatches = normalizePath(entry.knowledgeRoot) === targetRoot;
      if (legacy) {
        if (!lexicalProjectMatches || !lexicalKnowledgeMatches) {
          stats.unmatched += 1;
          continue;
        }
        const approvedEntry = approvedLegacyEntries.get(entry.id);
        if (!approvedEntry || !entriesAreEqual(approvedEntry, entry)) {
          stats.legacy += 1;
          continue;
        }
        matching.push({ entry, filePath });
        continue;
      }
      const projectMatches = lexicalProjectMatches
        && normalizePath(entry.canonicalProjectRoot) === targetCanonicalProjectRoot
        && entry.projectIdentity === options.projectIdentity;
      const knowledgeMatches = lexicalKnowledgeMatches
        && normalizePath(entry.canonicalKnowledgeRoot) === targetCanonicalKnowledgeRoot
        && entry.knowledgeIdentity === options.knowledgeIdentity;
      const conversationsMatch = normalizePath(entry.canonicalConversationsRoot) === targetCanonicalConversationsRoot
        && entry.conversationsIdentity === options.conversationsIdentity;
      if (!projectMatches || !knowledgeMatches || !conversationsMatch) {
        stats.unmatched += 1;
        continue;
      }

      matching.push({ entry, filePath });
    } catch (_error) {
      stats.failed += 1;
      unreadable += 1;
    }
  }

  for (const candidate of matching.slice(0, limit)) {
    stats.considered += 1;
    try {
      let { entry } = candidate;
      const { filePath } = candidate;
      if (entry.version === LEGACY_QUEUE_VERSION) {
        if (typeof options.pinDate !== 'function') {
          throw new TypeError('A date identity callback is required to migrate legacy pending conversations.');
        }
        const pinnedDate = await options.pinDate(entry);
        if (!pinnedDate
          || !isNonEmptyString(pinnedDate.canonicalDateRoot)
          || !isNonEmptyString(pinnedDate.dateIdentity)) {
          throw new Error(`Could not pin the pending conversation date target: ${entry.id}`);
        }
        entry = await pinLegacyEntry(queueRoot, filePath, entry, options, pinnedDate);
      }
      const stillMatches = normalizePath(entry.projectRoot) === targetProjectRoot
        && normalizePath(entry.canonicalProjectRoot) === targetCanonicalProjectRoot
        && entry.projectIdentity === options.projectIdentity
        && normalizePath(entry.knowledgeRoot) === targetRoot
        && normalizePath(entry.canonicalKnowledgeRoot) === targetCanonicalKnowledgeRoot
        && entry.knowledgeIdentity === options.knowledgeIdentity
        && normalizePath(entry.canonicalConversationsRoot) === targetCanonicalConversationsRoot
        && entry.conversationsIdentity === options.conversationsIdentity;
      if (!stillMatches) {
        throw new Error(`Pending conversation target changed during synchronization: ${entry.id}`);
      }
      try {
        await options.save(entry);
      } catch (error) {
        const emittedRecoveryIdentity = error && error.recoveryIdentity;
        const emittedRecoveryId = error && isNonEmptyString(error.recoveryId)
          && UUID_PATTERN.test(error.recoveryId)
          ? error.recoveryId
          : entry.recoveryId || entry.id;
        if (entry.version === QUEUE_VERSION
          && isValidFilesystemIdentity(emittedRecoveryIdentity)
          && (emittedRecoveryIdentity !== entry.recoveryIdentity
            || emittedRecoveryId !== entry.recoveryId)) {
          entry = await persistRecoveryIdentity(
            queueRoot,
            filePath,
            entry,
            emittedRecoveryIdentity,
            emittedRecoveryId,
            options,
          );
        }
        throw error;
      }
      const releaseLock = await acquireQueueLock(queueRoot, options);
      try {
        try {
          const current = validateEntry(JSON.parse(await fs.readFile(filePath, 'utf8')));
          const unchanged = entriesAreEqual(current, entry);
          if (!unchanged) {
            throw new Error(`Pending conversation changed during synchronization: ${entry.id}`);
          }
          await fs.unlink(filePath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
      } finally {
        await releaseLock();
      }
      stats.synced += 1;
    } catch (_error) {
      stats.failed += 1;
    }
  }

  stats.remaining = unreadable + Math.max(0, matching.length - stats.synced);
  return stats;
}

module.exports = {
  QUEUE_VERSION,
  enqueuePendingConversation,
  flushPendingConversations,
  listMatchingLegacyPendingConversations,
  listQueueFiles,
  validateEntry,
};
