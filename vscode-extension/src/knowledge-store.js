'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const CONVERSATION_SCHEMA = 'collaborare/conversation/v1';
const VALID_STATUSES = new Set(['complete', 'cancelled', 'error']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function quoteFrontmatter(value) {
  return JSON.stringify(String(value));
}

function normalizeMarkdownBody(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function serializeConversation(conversation) {
  if (!VALID_STATUSES.has(conversation.status)) {
    throw new Error(`Invalid conversation status: ${conversation.status}`);
  }

  const question = normalizeMarkdownBody(conversation.question);
  const response = normalizeMarkdownBody(conversation.response);

  const fields = [
    ['schema', CONVERSATION_SCHEMA],
    ['id', conversation.id],
    ['project', conversation.project],
    ['account', conversation.account],
    ['account_source', conversation.accountSource || 'unspecified'],
    ['machine', conversation.machine],
    ['question_at', conversation.questionAt],
    ['response_at', conversation.responseAt],
    ['model', conversation.model],
    ['status', conversation.status],
    ['question_chars', question.length],
    ['response_chars', response.length]
  ];

  const frontmatter = fields
    .map(([key, value]) => `${key}: ${quoteFrontmatter(value)}`)
    .join('\n');

  return [
    '---',
    frontmatter,
    '---',
    '',
    '# Conversation',
    '',
    '## User',
    '',
    question,
    '',
    '## Copilot',
    '',
    response,
    ''
  ].join('\n');
}

function validateKnowledgeDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('collaborare.knowledgeDirectory must be a non-empty relative path.');
  }

  const candidate = value.trim();
  if (candidate.includes('\0')) {
    throw new Error('collaborare.knowledgeDirectory cannot contain a null byte.');
  }
  if (
    path.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    /^[a-zA-Z]:/.test(candidate)
  ) {
    throw new Error('collaborare.knowledgeDirectory must be relative to the project root.');
  }

  const segments = candidate.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('collaborare.knowledgeDirectory cannot contain traversal segments.');
  }

  return segments.join(path.sep);
}

function resolveKnowledgeRoot(projectRoot, knowledgeDirectory) {
  const root = path.resolve(projectRoot);
  const relativeDirectory = validateKnowledgeDirectory(knowledgeDirectory);
  const knowledgeRoot = path.resolve(root, relativeDirectory);
  const relative = path.relative(root, knowledgeRoot);

  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The knowledge directory must remain inside the project root.');
  }

  return knowledgeRoot;
}

function isPathOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function assertKnowledgeRootContained(projectRoot, knowledgeRoot, options = {}) {
  const realProjectRoot = options.projectRootIsCanonical
    ? path.resolve(projectRoot)
    : await fs.realpath(projectRoot);
  let existingPath = knowledgeRoot;
  let realExistingPath;

  while (!realExistingPath) {
    try {
      realExistingPath = await fs.realpath(existingPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(existingPath);
      if (parent === existingPath) {
        throw error;
      }
      existingPath = parent;
    }
  }

  if (isPathOutside(realProjectRoot, realExistingPath)) {
    throw new Error('The knowledge directory resolves outside the project root through a symbolic link.');
  }
  return realProjectRoot;
}

async function ensureKnowledgeDatabase(knowledgeRoot, projectRoot, options = {}) {
  if (projectRoot) {
    await assertKnowledgeRootContained(projectRoot, path.join(knowledgeRoot, 'conversations'), options);
  }
  await fs.mkdir(path.join(knowledgeRoot, 'conversations'), { recursive: true });
  if (projectRoot) {
    return assertKnowledgeRootContained(projectRoot, path.join(knowledgeRoot, 'conversations'), options);
  }
  return null;
}

function dateDirectory(questionAt) {
  const date = new Date(questionAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid question_at timestamp: ${questionAt}`);
  }
  return date.toISOString().slice(0, 10);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function atomicWriteFile(finalPath, contents) {
  const directory = path.dirname(finalPath);
  const tempName = `.${path.basename(finalPath)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tempPath = path.join(directory, tempName);
  let handle;

  await fs.mkdir(directory, { recursive: true });

  try {
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function saveConversation(knowledgeRoot, conversation, options = {}) {
  const idFactory = options.idFactory || crypto.randomUUID;
  const fixedId = options.id;
  const directory = path.join(knowledgeRoot, 'conversations', dateDirectory(conversation.questionAt));

  if (options.projectRoot) {
    await assertKnowledgeRootContained(options.projectRoot, directory, {
      projectRootIsCanonical: options.projectRootIsCanonical
    });
  }
  if (options.requireExistingRoot) {
    const conversationsRoot = path.join(knowledgeRoot, 'conversations');
    const rootStat = await fs.stat(conversationsRoot);
    if (!rootStat.isDirectory()) {
      throw new Error('The knowledge conversation directory is not available.');
    }
  }
  await fs.mkdir(directory, { recursive: true });

  for (let attempt = 0; attempt < (fixedId ? 1 : 10); attempt += 1) {
    const id = fixedId || idFactory();
    if (!UUID_PATTERN.test(id)) {
      throw new Error('Conversation IDs must be UUIDs.');
    }

    const filePath = path.join(directory, `${id}.md`);
    const markdown = serializeConversation({ ...conversation, id });
    if (await pathExists(filePath)) {
      if (fixedId) {
        const existing = await fs.readFile(filePath, 'utf8');
        if (existing === markdown) {
          return { id, filePath, alreadyExisted: true };
        }
        throw new Error(`Conversation UUID collision: ${id}`);
      }
      continue;
    }

    await atomicWriteFile(filePath, markdown);
    return { id, filePath };
  }

  throw new Error('Could not allocate a unique conversation UUID.');
}

function isTemporaryMarkdown(name) {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.tmp.md') ||
    lower.endsWith('.md.tmp') ||
    lower.startsWith('.~') ||
    lower.endsWith('~') ||
    lower.startsWith('.collaborare-')
  );
}

function statFingerprint(stat) {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.dev || 0}:${stat.ino || 0}`;
}

function namespaceChangedError() {
  const error = new Error('Knowledge directory changed during scanning.');
  error.code = 'SCAN_NAMESPACE_CHANGED';
  return error;
}

function boundaryError() {
  const error = new Error('Knowledge directory escaped the configured project boundary.');
  error.code = 'PATH_OUTSIDE_BOUNDARY';
  return error;
}

async function readMarkdownFileLimited(filePath, maxFileBytes, expectedStats) {
  const handle = await fs.open(filePath, 'r');
  try {
    const initialStats = await handle.stat();
    if (!initialStats.isFile()) {
      const error = new Error('Path is not a regular file.');
      error.code = 'NOT_A_FILE';
      throw error;
    }
    if (expectedStats && statFingerprint(initialStats) !== statFingerprint(expectedStats)) {
      throw namespaceChangedError();
    }
    if (initialStats.size > maxFileBytes) {
      const error = new Error('Markdown file exceeds the configured size limit.');
      error.code = 'FILE_TOO_LARGE';
      throw error;
    }

    const chunks = [];
    let totalBytes = 0;
    let position = 0;
    while (true) {
      const remaining = maxFileBytes + 1 - totalBytes;
      if (remaining <= 0) {
        const error = new Error('Markdown file exceeds the configured size limit.');
        error.code = 'FILE_TOO_LARGE';
        throw error;
      }
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      position += bytesRead;
      if (totalBytes > maxFileBytes) {
        const error = new Error('Markdown file exceeds the configured size limit.');
        error.code = 'FILE_TOO_LARGE';
        throw error;
      }
    }

    const finalStats = await handle.stat();
    if (statFingerprint(finalStats) !== statFingerprint(initialStats)) {
      throw namespaceChangedError();
    }
    if (finalStats.size > maxFileBytes) {
      const error = new Error('Markdown file exceeds the configured size limit.');
      error.code = 'FILE_TOO_LARGE';
      throw error;
    }
    return {
      content: Buffer.concat(chunks, totalBytes).toString('utf8'),
      mtimeMs: finalStats.mtimeMs,
      size: totalBytes,
      stats: finalStats
    };
  } finally {
    await handle.close();
  }
}

async function scanMarkdownFiles(knowledgeRoot, options = {}) {
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 500;
  const maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : 262144;
  const maxTotalBytes = Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes > 0
    ? options.maxTotalBytes
    : 33554432;
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
  const canonicalProjectRoot = options.canonicalProjectRoot
    ? path.resolve(options.canonicalProjectRoot)
    : null;
  const resolvedKnowledgeRoot = path.resolve(knowledgeRoot);
  const documents = [];
  const directories = [];
  const observedFiles = [];
  const stats = {
    consideredFiles: 0,
    loadedFiles: 0,
    oversizedFiles: 0,
    failedFiles: 0,
    loadedBytes: 0,
    byteLimitReached: false,
    limitReached: false,
    cancelled: false
  };
  let realKnowledgeRoot;
  let rootStats;
  let scanInvalidated = false;

  function invalidateScan() {
    if (!scanInvalidated) {
      stats.failedFiles += 1;
      scanInvalidated = true;
    }
    stats.loadedFiles = 0;
    stats.loadedBytes = 0;
    documents.length = 0;
    directories.length = 0;
  }

  try {
    realKnowledgeRoot = await fs.realpath(resolvedKnowledgeRoot);
    rootStats = await fs.stat(resolvedKnowledgeRoot);
    if (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, realKnowledgeRoot)) {
      throw boundaryError();
    }
    directories.push(resolvedKnowledgeRoot);
  } catch (_error) {
    invalidateScan();
  }

  while (directories.length > 0 && stats.consideredFiles < maxFiles) {
    if (isCancelled()) {
      stats.cancelled = true;
      break;
    }

    const directory = directories.shift();
    let entries;
    try {
      const realDirectory = await fs.realpath(directory);
      if (isPathOutside(realKnowledgeRoot, realDirectory)
        || (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, realDirectory))) {
        throw boundaryError();
      }
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && ['PATH_OUTSIDE_BOUNDARY', 'SCAN_NAMESPACE_CHANGED'].includes(error.code)) {
        invalidateScan();
        break;
      }
      stats.failedFiles += 1;
      continue;
    }

    entries.sort((left, right) => right.name.localeCompare(left.name, 'en'));

    for (const entry of entries) {
      if (isCancelled()) {
        stats.cancelled = true;
        break;
      }

      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(filePath);
        continue;
      }
      if (
        !entry.isFile() ||
        path.extname(entry.name).toLowerCase() !== '.md' ||
        isTemporaryMarkdown(entry.name)
      ) {
        continue;
      }
      if (stats.consideredFiles >= maxFiles) {
        stats.limitReached = true;
        break;
      }

      stats.consideredFiles += 1;

      try {
        const realFilePath = await fs.realpath(filePath);
        if (isPathOutside(realKnowledgeRoot, realFilePath)
          || (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, realFilePath))) {
          throw boundaryError();
        }
        const pathStats = await fs.lstat(filePath);
        if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
          throw namespaceChangedError();
        }
        const file = await readMarkdownFileLimited(filePath, maxFileBytes, pathStats);
        const finalRealFilePath = await fs.realpath(filePath);
        const finalPathStats = await fs.lstat(filePath);
        if (finalRealFilePath !== realFilePath
          || !finalPathStats.isFile()
          || finalPathStats.isSymbolicLink()
          || statFingerprint(finalPathStats) !== statFingerprint(file.stats)
          || isPathOutside(realKnowledgeRoot, finalRealFilePath)
          || (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, finalRealFilePath))) {
          throw namespaceChangedError();
        }
        if (stats.loadedBytes + file.size > maxTotalBytes) {
          stats.byteLimitReached = true;
          directories.length = 0;
          break;
        }

        documents.push({
          path: filePath,
          relativePath: path.relative(knowledgeRoot, filePath).split(path.sep).join('/'),
          content: file.content,
          mtimeMs: file.mtimeMs,
          size: file.size
        });
        stats.loadedFiles += 1;
        stats.loadedBytes += file.size;
        observedFiles.push({
          filePath,
          fingerprint: statFingerprint(file.stats),
          realPath: finalRealFilePath
        });
      } catch (error) {
        if (error && error.code === 'FILE_TOO_LARGE') {
          stats.oversizedFiles += 1;
        } else if (error && ['PATH_OUTSIDE_BOUNDARY', 'SCAN_NAMESPACE_CHANGED'].includes(error.code)) {
          invalidateScan();
          break;
        } else {
          stats.failedFiles += 1;
        }
      }
    }
  }

  if (!scanInvalidated && !stats.cancelled) {
    try {
      const [finalRealRoot, finalRootStats] = await Promise.all([
        fs.realpath(resolvedKnowledgeRoot),
        fs.stat(resolvedKnowledgeRoot)
      ]);
      if (finalRealRoot !== realKnowledgeRoot
        || statFingerprint(finalRootStats) !== statFingerprint(rootStats)) {
        throw namespaceChangedError();
      }
      for (const observed of observedFiles) {
        const [currentRealPath, currentStats] = await Promise.all([
          fs.realpath(observed.filePath),
          fs.lstat(observed.filePath)
        ]);
        if (!currentStats.isFile()
          || currentStats.isSymbolicLink()
          || currentRealPath !== observed.realPath
          || isPathOutside(realKnowledgeRoot, currentRealPath)
          || (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, currentRealPath))
          || statFingerprint(currentStats) !== observed.fingerprint) {
          throw namespaceChangedError();
        }
      }
    } catch (_error) {
      invalidateScan();
    }
  }

  if (stats.consideredFiles >= maxFiles && directories.length > 0) {
    stats.limitReached = true;
  }

  return { documents, stats };
}

module.exports = {
  CONVERSATION_SCHEMA,
  assertKnowledgeRootContained,
  atomicWriteFile,
  ensureKnowledgeDatabase,
  isTemporaryMarkdown,
  quoteFrontmatter,
  readMarkdownFileLimited,
  resolveKnowledgeRoot,
  saveConversation,
  scanMarkdownFiles,
  serializeConversation,
  validateKnowledgeDirectory
};
