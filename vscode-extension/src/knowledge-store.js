'use strict';

const crypto = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const CONVERSATION_SCHEMA = 'collaborare/conversation/v1';
const VALID_STATUSES = new Set(['complete', 'cancelled', 'error']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILESYSTEM_IDENTITY_PATTERN = /^[1-9][0-9]*:[1-9][0-9]*$/;
const RECOVERY_CHAIN_DEPTH = Symbol('collaborareRecoveryChainDepth');
const MAX_RECOVERY_CHAIN_DEPTH = 32;

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

function pathsAreEqual(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

async function assertNoLinkedPathComponents(rootPath, candidatePath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (isPathOutside(resolvedRoot, resolvedCandidate)) {
    throw new Error('The knowledge directory must remain inside the lexical project root.');
  }

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const components = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    components.push(current);
  }

  for (const component of components) {
    let stat;
    try {
      stat = await fs.lstat(component);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`The shared knowledge path cannot contain a symbolic link or junction: ${component}`);
    }
    if (!stat.isDirectory() && component !== resolvedCandidate) {
      throw new Error(`The shared knowledge path contains a non-directory component: ${component}`);
    }
  }
}

function filesystemIdentity(stat) {
  if (!hasStableFilesystemIdentity(stat)) {
    throw new Error('A stable filesystem identity is unavailable for the shared path.');
  }
  return `${String(stat.dev || 0)}:${String(stat.ino || 0)}`;
}

function isValidFilesystemIdentity(value) {
  return typeof value === 'string'
    && value.length <= 128
    && FILESYSTEM_IDENTITY_PATTERN.test(value);
}

function hasStableFilesystemIdentity(stat) {
  function isStableValue(value) {
    return typeof value === 'bigint'
      ? value > 0n
      : Number.isSafeInteger(value) && value > 0;
  }
  return Boolean(stat) && isStableValue(stat.dev) && isStableValue(stat.ino);
}

function sameFilesystemEntry(left, right) {
  return hasStableFilesystemIdentity(left)
    && hasStableFilesystemIdentity(right)
    && filesystemIdentity(left) === filesystemIdentity(right);
}

async function inspectWriteDirectory(directory, canonicalProjectRoot) {
  const directoryStats = await fs.lstat(directory, { bigint: true });
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Conversation write directory cannot be a symbolic link or junction.');
  }
  const realDirectory = await fs.realpath(directory);
  if (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, realDirectory)) {
    throw new Error('The conversation write directory resolves outside the project root.');
  }
  return {
    filesystemIdentity: filesystemIdentity(directoryStats),
    realPath: realDirectory,
    stats: directoryStats,
  };
}

async function assertWriteDirectoryIdentity(
  directory,
  canonicalProjectRoot,
  expectedDirectory,
  label = 'conversation write directory',
) {
  const currentDirectory = await inspectWriteDirectory(directory, canonicalProjectRoot);
  if (expectedDirectory && !pathsAreEqual(expectedDirectory.realPath, currentDirectory.realPath)) {
    throw new Error(`The ${label} changed during publishing.`);
  }
  if (expectedDirectory
    && expectedDirectory.filesystemIdentity !== currentDirectory.filesystemIdentity) {
    throw new Error(`The ${label} identity changed during publishing.`);
  }
  return currentDirectory;
}

async function assertKnowledgeRootContained(projectRoot, knowledgeRoot, options = {}) {
  let lexicalProjectRoot = options.lexicalProjectRoot;
  if (!lexicalProjectRoot && !options.projectRootIsCanonical) {
    lexicalProjectRoot = projectRoot;
  }
  if (!lexicalProjectRoot
    && options.projectRootIsCanonical
    && !isPathOutside(path.resolve(projectRoot), path.resolve(knowledgeRoot))) {
    lexicalProjectRoot = projectRoot;
  }
  if (lexicalProjectRoot) {
    await assertNoLinkedPathComponents(lexicalProjectRoot, knowledgeRoot);
  }
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

async function assertKnowledgeDatabaseReady(knowledgeRoot, projectRoot, options = {}) {
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const canonicalProjectRoot = projectRoot
    ? options.projectRootIsCanonical
      ? path.resolve(projectRoot)
      : await fs.realpath(projectRoot)
    : null;
  const expectedProjectDirectory = options.expectedProjectIdentity && canonicalProjectRoot
    ? {
        realPath: canonicalProjectRoot,
        filesystemIdentity: options.expectedProjectIdentity,
      }
    : null;
  if (options.expectedProjectIdentity && !canonicalProjectRoot) {
    throw new TypeError('A project root is required with an expected project identity.');
  }
  const hasExpectedDateRoot = Boolean(options.expectedCanonicalDateRoot);
  const hasExpectedDateIdentity = Boolean(options.expectedDateIdentity);
  if (hasExpectedDateRoot !== hasExpectedDateIdentity) {
    throw new TypeError('The expected date root and identity must be provided together.');
  }
  if (hasExpectedDateRoot && !options.probeDate) {
    throw new TypeError('A probe date is required with an expected date identity.');
  }
  async function assertExpectedProjectIdentity() {
    if (expectedProjectDirectory) {
      await assertWriteDirectoryIdentity(
        canonicalProjectRoot,
        null,
        expectedProjectDirectory,
        'project root',
      );
    }
  }
  await assertExpectedProjectIdentity();
  if (projectRoot) {
    await assertKnowledgeRootContained(projectRoot, conversationsRoot, options);
  }
  let knowledgeDirectory;
  let conversationsDirectory;
  try {
    knowledgeDirectory = await inspectWriteDirectory(knowledgeRoot, canonicalProjectRoot);
    conversationsDirectory = await inspectWriteDirectory(conversationsRoot, canonicalProjectRoot);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new Error('The knowledge conversation directory is not available. Run @collaborare /init first.');
    }
    throw error;
  }

  const expectedChecks = [
    ['knowledge root', options.expectedCanonicalKnowledgeRoot, knowledgeDirectory.realPath],
    ['conversation root', options.expectedCanonicalConversationsRoot, conversationsDirectory.realPath],
  ];
  for (const [label, expected, actual] of expectedChecks) {
    if (expected && !pathsAreEqual(expected, actual)) {
      throw new Error(`The ${label} changed after the request began.`);
    }
  }
  if (options.expectedKnowledgeIdentity
    && options.expectedKnowledgeIdentity !== knowledgeDirectory.filesystemIdentity) {
    throw new Error('The knowledge root identity changed after the request began.');
  }
  if (options.expectedConversationsIdentity
    && options.expectedConversationsIdentity !== conversationsDirectory.filesystemIdentity) {
    throw new Error('The conversation root identity changed after the request began.');
  }

  let dateIdentity;
  let probedDateDirectory;
  if (options.probeDate) {
    const probeDirectory = path.join(conversationsRoot, dateDirectory(options.probeDate));
    try {
      await fs.mkdir(probeDirectory);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
    }
    const expectedProbeDirectory = hasExpectedDateRoot
      ? await assertWriteDirectoryIdentity(probeDirectory, canonicalProjectRoot, {
          realPath: options.expectedCanonicalDateRoot,
          filesystemIdentity: options.expectedDateIdentity,
        }, 'date root')
      : await inspectWriteDirectory(probeDirectory, canonicalProjectRoot);
    const probePath = path.join(
      probeDirectory,
      `.collaborare-write-probe-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    let probeHandle;
    let probeStats;
    let probeError;
    try {
      probeHandle = await fs.open(probePath, 'wx');
      probeStats = await probeHandle.stat({ bigint: true });
      await probeHandle.writeFile('collaborare-write-probe', 'utf8');
      await probeHandle.sync();
      await assertWriteDirectoryIdentity(probeDirectory, canonicalProjectRoot, expectedProbeDirectory);
    } catch (error) {
      probeError = error;
    }

    const cleanupErrors = [];
    if (probeHandle) {
      try {
        await probeHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        const cleanupStats = await fs.lstat(probePath, { bigint: true });
        if (!probeStats || !sameFilesystemEntry(probeStats, cleanupStats)) {
          throw namespaceChangedError();
        }
        await fs.unlink(probePath);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (probeError && cleanupErrors.length > 0) {
      const error = new AggregateError(
        [probeError, ...cleanupErrors],
        `${probeError.message} The write probe could not be safely removed: ${cleanupErrors.map((item) => item.message).join('; ')}`,
      );
      error.code = cleanupErrors[0].code || probeError.code;
      throw error;
    }
    if (probeError) {
      throw probeError;
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      const error = new AggregateError(
        cleanupErrors,
        `The write probe cleanup failed: ${cleanupErrors.map((item) => item.message).join('; ')}`,
      );
      error.code = cleanupErrors[0].code;
      throw error;
    }
    await assertWriteDirectoryIdentity(probeDirectory, canonicalProjectRoot, expectedProbeDirectory);
    dateIdentity = {
      canonicalDateRoot: expectedProbeDirectory.realPath,
      dateIdentity: expectedProbeDirectory.filesystemIdentity,
      dateRoot: probeDirectory,
    };
    probedDateDirectory = expectedProbeDirectory;
  }
  await assertWriteDirectoryIdentity(
    knowledgeRoot,
    canonicalProjectRoot,
    knowledgeDirectory,
    'knowledge root',
  );
  await assertWriteDirectoryIdentity(
    conversationsRoot,
    canonicalProjectRoot,
    conversationsDirectory,
    'conversation root',
  );
  if (probedDateDirectory) {
    await assertWriteDirectoryIdentity(
      dateIdentity.dateRoot,
      canonicalProjectRoot,
      probedDateDirectory,
      'date root',
    );
  }
  await assertExpectedProjectIdentity();

  return {
    canonicalConversationsRoot: conversationsDirectory.realPath,
    canonicalKnowledgeRoot: knowledgeDirectory.realPath,
    conversationsIdentity: conversationsDirectory.filesystemIdentity,
    conversationsRoot,
    knowledgeIdentity: knowledgeDirectory.filesystemIdentity,
    ...dateIdentity,
  };
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
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readExistingRegularFile(filePath, expectedStats, validateTarget) {
  if (!expectedStats.isFile() || expectedStats.isSymbolicLink()) {
    throw new Error('The existing conversation publish target is not a regular file.');
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.open(filePath, flags);
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile() || !sameFilesystemEntry(expectedStats, openedStats)) {
      throw new Error('The existing conversation publish target changed while it was being opened.');
    }
    const contents = await handle.readFile('utf8');
    const finalStats = await handle.stat({ bigint: true });
    if (!sameFilesystemEntry(openedStats, finalStats)) {
      throw new Error('The existing conversation publish target changed while it was being read.');
    }
    if (validateTarget) {
      await validateTarget(filePath, 'existing', finalStats);
    }
    return contents;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

function attachRecoveryIdentity(error, recoveryIdentity, recoveryId) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      error.recoveryIdentity = recoveryIdentity;
      if (recoveryId) {
        error.recoveryId = recoveryId;
      }
      return error;
    } catch (_assignmentError) {
      // Fall through and preserve the original error as the cause.
    }
  }
  const wrapped = new Error(error && error.message ? error.message : String(error));
  wrapped.cause = error;
  if (error && error.code) {
    wrapped.code = error.code;
  }
  wrapped.recoveryIdentity = recoveryIdentity;
  if (recoveryId) {
    wrapped.recoveryId = recoveryId;
  }
  return wrapped;
}

function isSingleLink(stat) {
  return stat && (stat.nlink === 1 || stat.nlink === 1n);
}

function hasTwoLinks(stat) {
  return stat && (stat.nlink === 2 || stat.nlink === 2n);
}

function hasSize(stat, size) {
  return stat && String(stat.size) === String(size);
}

function recoveryConversationId(id, recoveryIdentity) {
  const bytes = crypto.createHash('sha256')
    .update('collaborare/recovery/v1\0')
    .update(id)
    .update('\0')
    .update(recoveryIdentity)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPublicationTempName(finalPath, name) {
  const prefix = `.${path.basename(finalPath)}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
    return false;
  }
  const suffix = name.slice(prefix.length, -4);
  const separator = suffix.indexOf('.');
  return separator > 0
    && /^\d+$/.test(suffix.slice(0, separator))
    && UUID_PATTERN.test(suffix.slice(separator + 1));
}

async function hasPublicationTempHardLink(finalPath, finalStats, validateTarget) {
  if (!hasTwoLinks(finalStats) || !hasSize(finalStats, 0)) {
    return false;
  }
  try {
    const directory = path.dirname(finalPath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!isPublicationTempName(finalPath, entry.name)) {
        continue;
      }
      const candidatePath = path.join(directory, entry.name);
      const candidateStats = await fs.lstat(candidatePath, { bigint: true });
      if (candidateStats.isFile()
        && !candidateStats.isSymbolicLink()
        && sameFilesystemEntry(candidateStats, finalStats)) {
        candidates.push({ candidatePath, candidateStats });
      }
    }
    if (candidates.length !== 1) {
      return false;
    }

    const [{ candidatePath, candidateStats }] = candidates;
    if (validateTarget) {
      await validateTarget(candidatePath, 'cleanup', candidateStats);
    }
    const [currentCandidateStats, currentFinalStats] = await Promise.all([
      fs.lstat(candidatePath, { bigint: true }),
      fs.lstat(finalPath, { bigint: true }),
    ]);
    if (!currentCandidateStats.isFile()
      || currentCandidateStats.isSymbolicLink()
      || !sameFilesystemEntry(candidateStats, currentCandidateStats)
      || !sameFilesystemEntry(finalStats, currentFinalStats)
      || !sameFilesystemEntry(currentCandidateStats, currentFinalStats)
      || !hasTwoLinks(currentFinalStats)
      || !hasSize(currentFinalStats, 0)) {
      return false;
    }
    return true;
  } catch (_error) {
    return false;
  }
}

async function atomicWriteFile(finalPath, contents, options = {}) {
  const directory = path.dirname(finalPath);
  const tempName = `.${path.basename(finalPath)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tempPath = path.join(directory, tempName);
  const expectedContents = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  let handle;
  let tempStats;
  let published = false;
  let committed = false;

  await fs.mkdir(directory, { recursive: true });

  try {
    handle = await fs.open(tempPath, 'wx');
    tempStats = await handle.stat({ bigint: true });
    if (options.validateTarget) {
      await options.validateTarget(tempPath, 'opened', tempStats);
    }
    await handle.writeFile(expectedContents);
    await handle.sync();
    tempStats = await handle.stat({ bigint: true });
    if (options.validateTarget) {
      await options.validateTarget(tempPath, 'written', tempStats);
    }
    if (options.noClobber) {
      await fs.link(tempPath, finalPath);
      published = true;
    } else {
      await fs.rename(tempPath, finalPath);
      published = true;
    }
    if (options.validateTarget) {
      await options.validateTarget(finalPath, 'published', tempStats);
    }
    const publishedContents = await fs.readFile(finalPath);
    if (!publishedContents.equals(expectedContents)) {
      throw new Error('The published conversation content changed during publishing.');
    }
    if (options.validateTarget) {
      await options.validateTarget(finalPath, 'verified', tempStats);
    }
    if (options.noClobber) {
      await fs.unlink(tempPath);
      committed = true;
    }
    await handle.close();
    handle = undefined;
  } catch (error) {
    let writeError = error;
    const preservePublished = committed
      || (published && options.preservePublishedOnError === true);
    if (handle) {
      if (!preservePublished) {
        try {
          await handle.truncate(0);
          await handle.sync();
          const scrubbedStats = await handle.stat({ bigint: true });
          const scrubbedLinksAreRecoverable = isSingleLink(scrubbedStats)
            || (published
            && options.noClobber
            && tempStats
            && sameFilesystemEntry(tempStats, scrubbedStats)
            && hasSize(scrubbedStats, 0)
            && await hasPublicationTempHardLink(
              finalPath,
              scrubbedStats,
              options.validateTarget,
            ));
          if (published
            && options.noClobber
            && tempStats
            && sameFilesystemEntry(tempStats, scrubbedStats)
            && scrubbedLinksAreRecoverable
            && hasSize(scrubbedStats, 0)) {
            const publishedStats = await fs.lstat(finalPath, { bigint: true });
            const publishedLinksAreRecoverable = isSingleLink(publishedStats)
              || await hasPublicationTempHardLink(
                finalPath,
                publishedStats,
                options.validateTarget,
              );
            if (publishedStats.isFile()
              && !publishedStats.isSymbolicLink()
              && sameFilesystemEntry(scrubbedStats, publishedStats)
              && publishedLinksAreRecoverable
              && hasSize(publishedStats, 0)) {
              writeError = attachRecoveryIdentity(error, filesystemIdentity(scrubbedStats));
            }
          }
        } catch (_scrubError) {
          // Without a proven scrubbed pathname, no recovery capability is returned.
        }
      }
      await handle.close().catch(() => {});
      handle = undefined;
    }

    if (preservePublished) {
      throw writeError;
    }

    if (published) {
      throw writeError;
    }

    const cleanupPath = tempPath;
    try {
      if (options.validateTarget) {
        await options.validateTarget(cleanupPath, 'cleanup', tempStats);
      }
      const cleanupStats = await fs.lstat(cleanupPath, { bigint: true });
      if (tempStats && sameFilesystemEntry(cleanupStats, tempStats)) {
        await fs.unlink(cleanupPath);
      }
    } catch (_cleanupError) {
      // The open handle was scrubbed; an uncertain namespace entry is safer left untouched.
    }
    throw writeError;
  }
}

async function saveConversation(knowledgeRoot, conversation, options = {}) {
  const idFactory = options.idFactory || crypto.randomUUID;
  const fixedId = options.id;
  const recoveryIdentity = options.recoveryIdentity;
  const recoveryChainDepth = options[RECOVERY_CHAIN_DEPTH] || 0;
  const allowUnidentifiedRecovery = options.allowUnidentifiedRecovery === true;
  if (recoveryIdentity !== undefined && !isValidFilesystemIdentity(recoveryIdentity)) {
    throw new TypeError('A recovery identity must be a stable filesystem identity.');
  }
  if (recoveryIdentity !== undefined && !fixedId) {
    throw new TypeError('A fixed conversation UUID is required with a recovery identity.');
  }
  if (allowUnidentifiedRecovery && !fixedId) {
    throw new TypeError('A fixed conversation UUID is required for unidentified recovery.');
  }
  const conversationsRoot = path.join(knowledgeRoot, 'conversations');
  const directory = path.join(conversationsRoot, dateDirectory(conversation.questionAt));

  let canonicalProjectRoot;
  if (options.projectRoot) {
    canonicalProjectRoot = options.projectRootIsCanonical
      ? path.resolve(options.projectRoot)
      : await fs.realpath(options.projectRoot);
    await assertKnowledgeRootContained(options.projectRoot, directory, {
      projectRootIsCanonical: options.projectRootIsCanonical
    });
  }
  if (options.expectedProjectIdentity && !canonicalProjectRoot) {
    throw new TypeError('A project root is required with an expected project identity.');
  }
  const hasExpectedKnowledgeRoot = Boolean(options.expectedCanonicalKnowledgeRoot);
  const hasExpectedKnowledgeIdentity = Boolean(options.expectedKnowledgeIdentity);
  if (hasExpectedKnowledgeRoot !== hasExpectedKnowledgeIdentity) {
    throw new TypeError('The expected knowledge root and identity must be provided together.');
  }
  const hasExpectedConversationsRoot = Boolean(options.expectedCanonicalConversationsRoot);
  const hasExpectedConversationsIdentity = Boolean(options.expectedConversationsIdentity);
  if (hasExpectedConversationsRoot !== hasExpectedConversationsIdentity) {
    throw new TypeError('The expected conversation root and identity must be provided together.');
  }
  const hasExpectedDateRoot = Boolean(options.expectedCanonicalDateRoot);
  const hasExpectedDateIdentity = Boolean(options.expectedDateIdentity);
  if (hasExpectedDateRoot !== hasExpectedDateIdentity) {
    throw new TypeError('The expected date root and identity must be provided together.');
  }
  const expectedProjectDirectory = options.expectedProjectIdentity
    ? {
        realPath: canonicalProjectRoot,
        filesystemIdentity: options.expectedProjectIdentity,
      }
    : null;
  const expectedKnowledgeDirectory = hasExpectedKnowledgeRoot
    ? {
        realPath: options.expectedCanonicalKnowledgeRoot,
        filesystemIdentity: options.expectedKnowledgeIdentity,
      }
    : null;
  const expectedConversationsDirectory = hasExpectedConversationsRoot
    ? {
        realPath: options.expectedCanonicalConversationsRoot,
        filesystemIdentity: options.expectedConversationsIdentity,
      }
    : null;
  const expectedDateDirectory = hasExpectedDateRoot
    ? {
        realPath: options.expectedCanonicalDateRoot,
        filesystemIdentity: options.expectedDateIdentity,
      }
    : null;

  async function assertPinnedRoots() {
    if (options.projectRoot) {
      await assertKnowledgeRootContained(options.projectRoot, directory, options);
    }
    if (expectedProjectDirectory) {
      await assertWriteDirectoryIdentity(canonicalProjectRoot, null, expectedProjectDirectory);
    }
    if (expectedKnowledgeDirectory) {
      await assertWriteDirectoryIdentity(knowledgeRoot, canonicalProjectRoot, expectedKnowledgeDirectory);
    }
    if (expectedConversationsDirectory) {
      await assertWriteDirectoryIdentity(
        conversationsRoot,
        canonicalProjectRoot,
        expectedConversationsDirectory,
        'conversation root',
      );
    }
    if (expectedDateDirectory) {
      await assertWriteDirectoryIdentity(
        directory,
        canonicalProjectRoot,
        expectedDateDirectory,
        'date root',
      );
    }
  }

  await assertPinnedRoots();
  if (options.requireExistingRoot) {
    const knowledgeStat = await fs.lstat(knowledgeRoot);
    const rootStat = await fs.lstat(conversationsRoot);
    if (!knowledgeStat.isDirectory() || knowledgeStat.isSymbolicLink()
      || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('The knowledge conversation directory is not available.');
    }
    if (canonicalProjectRoot) {
      await assertWriteDirectoryIdentity(knowledgeRoot, canonicalProjectRoot);
      await assertWriteDirectoryIdentity(conversationsRoot, canonicalProjectRoot);
    }
  }
  if (options.requireExistingRoot) {
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
    }
  } else {
    await fs.mkdir(directory, { recursive: true });
  }

  await assertPinnedRoots();

  const realWriteDirectory = canonicalProjectRoot
    ? await assertWriteDirectoryIdentity(
        directory,
        canonicalProjectRoot,
        expectedDateDirectory,
        'date root',
      )
    : null;

  async function validateWriteTarget(targetPath, _stage, expectedStats) {
    await assertPinnedRoots();
    const currentRealDirectory = await assertWriteDirectoryIdentity(
      directory,
      canonicalProjectRoot,
      realWriteDirectory
    );
    const targetStats = await fs.lstat(targetPath, { bigint: true });
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error('The conversation publish target is not a regular file.');
    }
    const realTarget = await fs.realpath(targetPath);
    if (!pathsAreEqual(path.dirname(realTarget), currentRealDirectory.realPath)) {
      throw new Error('The conversation publish target changed directories during publishing.');
    }
    if (expectedStats
      && hasStableFilesystemIdentity(expectedStats)
      && hasStableFilesystemIdentity(targetStats)
      && !sameFilesystemEntry(expectedStats, targetStats)) {
      throw new Error('The conversation publish target identity changed during publishing.');
    }
  }

  for (let attempt = 0; attempt < (fixedId ? 1 : 10); attempt += 1) {
    const id = fixedId || idFactory();
    if (!UUID_PATTERN.test(id)) {
      throw new Error('Conversation IDs must be UUIDs.');
    }

    const filePath = path.join(directory, `${id}.md`);
    const markdown = serializeConversation({ ...conversation, id });
    await assertPinnedRoots();
    if (realWriteDirectory) {
      await assertWriteDirectoryIdentity(directory, canonicalProjectRoot, realWriteDirectory);
    }
    if (await pathExists(filePath)) {
      if (fixedId) {
        const existingStats = await fs.lstat(filePath, { bigint: true });
        const existing = await readExistingRegularFile(
          filePath,
          existingStats,
          canonicalProjectRoot ? validateWriteTarget : undefined,
        );
        if (existing === markdown) {
          const currentStats = await fs.lstat(filePath, { bigint: true });
          if (sameFilesystemEntry(existingStats, currentStats)
            && isSingleLink(existingStats)
            && isSingleLink(currentStats)
            && hasSize(currentStats, Buffer.byteLength(markdown))) {
            return { id, filePath, alreadyExisted: true };
          }
          throw new Error(`Conversation UUID collision: ${id}`);
        }
        const existingIdentity = existing === ''
          ? filesystemIdentity(existingStats)
          : undefined;
        const canContinueRecovery = Boolean(existingIdentity) && (recoveryIdentity
          ? existingIdentity === recoveryIdentity
          : recoveryChainDepth > 0 || allowUnidentifiedRecovery);
        const existingLinksAreRecoverable = canContinueRecovery
          && existing === ''
          && hasSize(existingStats, 0)
          && (isSingleLink(existingStats)
            || await hasPublicationTempHardLink(
              filePath,
              existingStats,
              canonicalProjectRoot ? validateWriteTarget : undefined,
            ));
        if (canContinueRecovery
          && existing === ''
          && existingLinksAreRecoverable
          && hasSize(existingStats, 0)) {
          if (recoveryChainDepth >= MAX_RECOVERY_CHAIN_DEPTH) {
            throw new Error(`Conversation recovery chain limit reached: ${id}`);
          }
          const currentStats = await fs.lstat(filePath, { bigint: true });
          const currentLinksAreRecoverable = isSingleLink(currentStats)
            || await hasPublicationTempHardLink(
              filePath,
              currentStats,
              canonicalProjectRoot ? validateWriteTarget : undefined,
            );
          if (!currentStats.isFile()
            || currentStats.isSymbolicLink()
            || !sameFilesystemEntry(existingStats, currentStats)
            || !currentLinksAreRecoverable
            || !hasSize(currentStats, 0)) {
            throw new Error(`Conversation UUID collision: ${id}`);
          }
          const recovered = await saveConversation(knowledgeRoot, conversation, {
            ...options,
            id: recoveryConversationId(id, existingIdentity),
            recoveryIdentity: undefined,
            [RECOVERY_CHAIN_DEPTH]: recoveryChainDepth + 1,
          });
          return { ...recovered, recovered: true, recoveredFrom: id };
        }
        throw new Error(`Conversation UUID collision: ${id}`);
      }
      continue;
    }

    try {
      await atomicWriteFile(filePath, markdown, {
        noClobber: true,
        validateTarget: canonicalProjectRoot ? validateWriteTarget : undefined
      });
    } catch (error) {
      if (error && isValidFilesystemIdentity(error.recoveryIdentity)) {
        throw attachRecoveryIdentity(error, error.recoveryIdentity, id);
      }
      if (!fixedId && error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
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
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.dev || 0}:${stat.ino || 0}:${stat.nlink || 0}`;
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
    if (!isSingleLink(initialStats)) {
      throw namespaceChangedError();
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
    if (!isSingleLink(finalStats)
      || statFingerprint(finalStats) !== statFingerprint(initialStats)) {
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

async function collectMarkdownNamespace(rootPath, realRootPath, canonicalProjectRoot, maxFiles) {
  const directories = [rootPath];
  const files = [];
  while (directories.length > 0) {
    const directory = directories.shift();
    const [realDirectory, directoryStats] = await Promise.all([
      fs.realpath(directory),
      fs.lstat(directory),
    ]);
    if (!directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || isPathOutside(realRootPath, realDirectory)
      || (canonicalProjectRoot && isPathOutside(canonicalProjectRoot, realDirectory))) {
      throw namespaceChangedError();
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(candidatePath);
      } else if (entry.isFile()
        && path.extname(entry.name).toLowerCase() === '.md'
        && !isTemporaryMarkdown(entry.name)) {
        files.push(path.resolve(candidatePath));
        if (files.length > maxFiles) {
          return { files, limitReached: true };
        }
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right, 'en'));
  return { files, limitReached: false };
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
  const discoveredFiles = [];
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

  async function assertExpectedRootIdentities() {
    if (options.expectedProjectIdentity) {
      if (!canonicalProjectRoot) {
        throw new TypeError('A canonical project root is required with an expected project identity.');
      }
      const projectStats = await fs.lstat(canonicalProjectRoot, { bigint: true });
      if (!projectStats.isDirectory()
        || projectStats.isSymbolicLink()
        || filesystemIdentity(projectStats) !== options.expectedProjectIdentity) {
        throw namespaceChangedError();
      }
    }
    if (options.expectedCanonicalKnowledgeRoot || options.expectedKnowledgeIdentity) {
      if (!options.expectedCanonicalKnowledgeRoot || !options.expectedKnowledgeIdentity) {
        throw new TypeError('The expected knowledge root and identity must be provided together.');
      }
      const [currentRealRoot, knowledgeStats] = await Promise.all([
        fs.realpath(resolvedKnowledgeRoot),
        fs.lstat(resolvedKnowledgeRoot, { bigint: true }),
      ]);
      if (!knowledgeStats.isDirectory()
        || knowledgeStats.isSymbolicLink()
        || !pathsAreEqual(currentRealRoot, options.expectedCanonicalKnowledgeRoot)
        || filesystemIdentity(knowledgeStats) !== options.expectedKnowledgeIdentity) {
        throw namespaceChangedError();
      }
    }
  }

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
    await assertExpectedRootIdentities();
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
      discoveredFiles.push(path.resolve(filePath));
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
        if (!pathStats.isFile()
          || pathStats.isSymbolicLink()
          || !isSingleLink(pathStats)) {
          throw namespaceChangedError();
        }
        observedFiles.push({
          filePath,
          fingerprint: statFingerprint(pathStats),
          realPath: realFilePath
        });
        const file = await readMarkdownFileLimited(filePath, maxFileBytes, pathStats);
        const finalRealFilePath = await fs.realpath(filePath);
        const finalPathStats = await fs.lstat(filePath);
        if (finalRealFilePath !== realFilePath
          || !finalPathStats.isFile()
          || finalPathStats.isSymbolicLink()
          || !isSingleLink(finalPathStats)
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
      await assertExpectedRootIdentities();
      const [finalRealRoot, finalRootStats] = await Promise.all([
        fs.realpath(resolvedKnowledgeRoot),
        fs.stat(resolvedKnowledgeRoot)
      ]);
      if (finalRealRoot !== realKnowledgeRoot
        || statFingerprint(finalRootStats) !== statFingerprint(rootStats)) {
        throw namespaceChangedError();
      }
      const finalNamespace = await collectMarkdownNamespace(
        resolvedKnowledgeRoot,
        realKnowledgeRoot,
        canonicalProjectRoot,
        maxFiles,
      );
      if (finalNamespace.limitReached) {
        stats.limitReached = true;
      } else {
        const observedNamespace = [...discoveredFiles]
          .sort((left, right) => left.localeCompare(right, 'en'));
        if (observedNamespace.length !== finalNamespace.files.length
          || observedNamespace.some((filePath, index) => filePath !== finalNamespace.files[index])) {
          throw namespaceChangedError();
        }
      }
      for (const observed of observedFiles) {
        const [currentRealPath, currentStats] = await Promise.all([
          fs.realpath(observed.filePath),
          fs.lstat(observed.filePath)
        ]);
        if (!currentStats.isFile()
          || currentStats.isSymbolicLink()
          || !isSingleLink(currentStats)
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

  return { documents, stats };
}

module.exports = {
  CONVERSATION_SCHEMA,
  assertKnowledgeDatabaseReady,
  assertKnowledgeRootContained,
  atomicWriteFile,
  ensureKnowledgeDatabase,
  filesystemIdentity,
  isValidFilesystemIdentity,
  isTemporaryMarkdown,
  quoteFrontmatter,
  readMarkdownFileLimited,
  resolveKnowledgeRoot,
  saveConversation,
  scanMarkdownFiles,
  serializeConversation,
  validateKnowledgeDirectory
};
