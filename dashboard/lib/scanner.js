'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { parseConversationMarkdown } = require('./markdown');

class ScanLimitError extends Error {
  constructor(maxFiles) {
    super(`Markdown scan limit exceeded (${maxFiles})`);
    this.name = 'ScanLimitError';
    this.code = 'SCAN_LIMIT_EXCEEDED';
  }
}

class FileTooLargeError extends Error {
  constructor() {
    super('Markdown file exceeds the configured size limit');
    this.name = 'FileTooLargeError';
    this.code = 'FILE_TOO_LARGE';
  }
}

class ScanByteLimitError extends Error {
  constructor(maxTotalBytes) {
    super(`Markdown aggregate byte limit exceeded (${maxTotalBytes})`);
    this.name = 'ScanByteLimitError';
    this.code = 'SCAN_BYTE_LIMIT_EXCEEDED';
  }
}

class PathBoundaryError extends Error {
  constructor() {
    super('Knowledge directory resolves outside the configured project boundary');
    this.name = 'PathBoundaryError';
    this.code = 'PATH_OUTSIDE_BOUNDARY';
  }
}

class ScanMutationError extends Error {
  constructor() {
    super('Knowledge directory namespace changed during the scan');
    this.name = 'ScanMutationError';
    this.code = 'SCAN_NAMESPACE_CHANGED';
  }
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isPathSameOrInside(rootPath, candidatePath) {
  return rootPath === candidatePath || isPathInside(rootPath, candidatePath);
}

function isTemporaryName(name) {
  if (/^[.~#]/.test(name) || /[~#]$/.test(name)) {
    return true;
  }

  const stem = name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
  return /\.(?:tmp|temp|swp|swo|part|crdownload)$/i.test(stem);
}

function toRelativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join('/');
}

async function collectMarkdownFiles(rootPath, maxFiles) {
  const files = [];
  let ignoredFileCount = 0;

  async function visit(directoryPath) {
    const directory = await fs.opendir(directoryPath);

    for await (const entry of directory) {
      const candidatePath = path.join(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        ignoredFileCount += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (isTemporaryName(entry.name)) {
          ignoredFileCount += 1;
          continue;
        }
        await visit(candidatePath);
        continue;
      }

      if (!entry.isFile()) {
        ignoredFileCount += 1;
        continue;
      }

      if (path.extname(entry.name).toLowerCase() !== '.md' || isTemporaryName(entry.name)) {
        ignoredFileCount += 1;
        continue;
      }

      files.push(candidatePath);
      if (files.length > maxFiles) {
        throw new ScanLimitError(maxFiles);
      }
    }
  }

  await visit(rootPath);
  files.sort((left, right) => left.localeCompare(right, 'en'));
  return { files, ignoredFileCount };
}

async function readFileLimited(filePath, maxFileBytes, expectedStat) {
  const handle = await fs.open(filePath, 'r');

  try {
    const initialStat = await handle.stat();
    if (!initialStat.isFile()) {
      const error = new Error('Path is not a regular file');
      error.code = 'NOT_A_FILE';
      throw error;
    }
    if (expectedStat && fingerprint(initialStat) !== fingerprint(expectedStat)) {
      throw new ScanMutationError();
    }
    if (initialStat.size > maxFileBytes) {
      throw new FileTooLargeError();
    }

    const chunks = [];
    let totalBytes = 0;
    let position = 0;

    while (true) {
      const remaining = maxFileBytes + 1 - totalBytes;
      if (remaining <= 0) {
        throw new FileTooLargeError();
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
        throw new FileTooLargeError();
      }
    }

    const finalStat = await handle.stat();
    if (fingerprint(finalStat) !== fingerprint(initialStat)) {
      throw new ScanMutationError();
    }
    if (finalStat.size > maxFileBytes) {
      throw new FileTooLargeError();
    }

    return {
      source: Buffer.concat(chunks, totalBytes).toString('utf8'),
      stat: finalStat,
      bytesRead: totalBytes,
    };
  } finally {
    await handle.close();
  }
}

function fingerprint(stat) {
  return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.dev || 0}:${stat.ino || 0}`;
}

function diffSnapshots(previousSnapshot, snapshot) {
  const upserts = [];
  const deletes = [];

  for (const [relativePath, record] of snapshot) {
    const previous = previousSnapshot.get(relativePath);
    if (!previous || previous.fingerprint !== record.fingerprint) {
      upserts.push(record.conversation);
    }
  }

  for (const relativePath of previousSnapshot.keys()) {
    if (!snapshot.has(relativePath)) {
      deletes.push(relativePath);
    }
  }

  deletes.sort((left, right) => left.localeCompare(right, 'en'));
  return { upserts, deletes };
}

async function scanKnowledgeDirectory(options) {
  const {
    rootPath,
    previousSnapshot = new Map(),
    maxFileBytes,
    maxFiles,
    maxTotalBytes = Number.MAX_SAFE_INTEGER,
    boundaryRoot,
    canonicalBoundaryRoot,
  } = options;

  if (!rootPath) {
    throw new TypeError('rootPath is required');
  }
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new TypeError('maxFileBytes must be a positive integer');
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new TypeError('maxFiles must be a positive integer');
  }
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new TypeError('maxTotalBytes must be a positive integer');
  }

  const resolvedRoot = path.resolve(rootPath);
  if (!canonicalBoundaryRoot) {
    await fs.mkdir(resolvedRoot, { recursive: true });
  }
  const realRoot = await fs.realpath(resolvedRoot);
  const rootStat = await fs.stat(resolvedRoot);
  const realBoundaryRoot = canonicalBoundaryRoot
    ? path.resolve(canonicalBoundaryRoot)
    : boundaryRoot
      ? await fs.realpath(path.resolve(boundaryRoot))
      : null;
  if (realBoundaryRoot && !isPathSameOrInside(realBoundaryRoot, realRoot)) {
    throw new PathBoundaryError();
  }
  const { files, ignoredFileCount } = await collectMarkdownFiles(resolvedRoot, maxFiles);
  const snapshot = new Map();
  const warnings = [];
  const observedFiles = [];
  let totalBytes = 0;

  for (const filePath of files) {
    const relativePath = toRelativePath(resolvedRoot, filePath);

    try {
      const realFilePath = await fs.realpath(filePath);
      if (!isPathInside(realRoot, realFilePath)
        || (realBoundaryRoot && !isPathInside(realBoundaryRoot, realFilePath))) {
        throw new PathBoundaryError();
      }

      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }

      if (stat.size > maxFileBytes) {
        warnings.push({
          code: 'FILE_TOO_LARGE',
          relativePath,
          message: `Skipped a Markdown file larger than ${maxFileBytes} bytes`,
        });
        continue;
      }

      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) {
        throw new ScanByteLimitError(maxTotalBytes);
      }

      const currentFingerprint = fingerprint(stat);
      const previous = previousSnapshot.get(relativePath);
      if (previous && previous.fingerprint === currentFingerprint) {
        snapshot.set(relativePath, previous);
        observedFiles.push({
          filePath,
          fingerprint: currentFingerprint,
          realPath: realFilePath,
        });
        continue;
      }

      const file = await readFileLimited(filePath, maxFileBytes, stat);
      const finalRealFilePath = await fs.realpath(filePath);
      const finalPathStat = await fs.lstat(filePath);
      if (finalRealFilePath !== realFilePath
        || !finalPathStat.isFile()
        || finalPathStat.isSymbolicLink()
        || fingerprint(finalPathStat) !== fingerprint(file.stat)
        || !isPathInside(realRoot, finalRealFilePath)
        || (realBoundaryRoot && !isPathInside(realBoundaryRoot, finalRealFilePath))) {
        throw new ScanMutationError();
      }
      totalBytes += Math.max(file.bytesRead, file.stat.size) - stat.size;
      if (totalBytes > maxTotalBytes) {
        throw new ScanByteLimitError(maxTotalBytes);
      }
      const finalFingerprint = fingerprint(file.stat);
      const conversation = parseConversationMarkdown(file.source, {
        relativePath,
        mtimeMs: file.stat.mtimeMs,
        size: file.stat.size,
      });

      snapshot.set(relativePath, {
        fingerprint: finalFingerprint,
        conversation,
      });
      observedFiles.push({
        filePath,
        fingerprint: finalFingerprint,
        realPath: finalRealFilePath,
      });
    } catch (error) {
      if (error && ['SCAN_BYTE_LIMIT_EXCEEDED', 'PATH_OUTSIDE_BOUNDARY', 'SCAN_NAMESPACE_CHANGED'].includes(error.code)) {
        throw error;
      }
      if (error && error.code === 'FILE_TOO_LARGE') {
        warnings.push({
          code: 'FILE_TOO_LARGE',
          relativePath,
          message: `Skipped a Markdown file larger than ${maxFileBytes} bytes`,
        });
        continue;
      }

      const previous = previousSnapshot.get(relativePath);
      if (previous) {
        snapshot.set(relativePath, previous);
      }
      warnings.push({
        code: 'READ_FAILED',
        relativePath,
        message: 'Could not read a Markdown file during this scan',
      });
    }
  }

  try {
    const [finalRealRoot, finalRootStat] = await Promise.all([
      fs.realpath(resolvedRoot),
      fs.stat(resolvedRoot),
    ]);
    if (finalRealRoot !== realRoot || fingerprint(finalRootStat) !== fingerprint(rootStat)) {
      throw new ScanMutationError();
    }
    for (const observed of observedFiles) {
      const [currentRealPath, currentStat] = await Promise.all([
        fs.realpath(observed.filePath),
        fs.lstat(observed.filePath),
      ]);
      if (!currentStat.isFile()
        || currentStat.isSymbolicLink()
        || currentRealPath !== observed.realPath
        || !isPathInside(realRoot, currentRealPath)
        || (realBoundaryRoot && !isPathInside(realBoundaryRoot, currentRealPath))
        || fingerprint(currentStat) !== observed.fingerprint) {
        throw new ScanMutationError();
      }
    }
  } catch (error) {
    if (error && error.code === 'SCAN_NAMESPACE_CHANGED') {
      throw error;
    }
    throw new ScanMutationError();
  }

  return {
    snapshot,
    changes: diffSnapshots(previousSnapshot, snapshot),
    warnings,
    scannedFileCount: files.length,
    ignoredFileCount,
    totalBytes,
  };
}

class PollingScanner extends EventEmitter {
  constructor(options) {
    super();
    this.rootPath = options.rootPath;
    this.intervalMs = options.intervalMs;
    this.maxFileBytes = options.maxFileBytes;
    this.maxFiles = options.maxFiles;
    this.maxTotalBytes = options.maxTotalBytes || Number.MAX_SAFE_INTEGER;
    this.boundaryRoot = options.boundaryRoot || null;
    this.canonicalBoundaryRoot = options.canonicalBoundaryRoot || null;
    this.snapshot = new Map();
    this.timer = null;
    this.scanPromise = null;
    this.lastScanAt = null;
    this.lastError = null;
  }

  getConversations() {
    return [...this.snapshot.values()].map((record) => record.conversation);
  }

  async scanNow() {
    if (this.scanPromise) {
      return this.scanPromise;
    }

    this.scanPromise = this.performScan();
    try {
      return await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }

  async performScan() {
    try {
      const report = await scanKnowledgeDirectory({
        rootPath: this.rootPath,
        previousSnapshot: this.snapshot,
        maxFileBytes: this.maxFileBytes,
        maxFiles: this.maxFiles,
        maxTotalBytes: this.maxTotalBytes,
        boundaryRoot: this.boundaryRoot,
        canonicalBoundaryRoot: this.canonicalBoundaryRoot,
      });

      this.snapshot = report.snapshot;
      this.lastScanAt = new Date().toISOString();
      this.lastError = null;

      for (const warning of report.warnings) {
        this.emit('warning', warning);
      }
      for (const conversation of report.changes.upserts) {
        this.emit('upsert', conversation);
      }
      for (const relativePath of report.changes.deletes) {
        this.emit('delete', relativePath);
      }
      this.emit('scan', report);
      return report;
    } catch (error) {
      const publicError = {
        code: error && ['SCAN_LIMIT_EXCEEDED', 'SCAN_BYTE_LIMIT_EXCEEDED', 'PATH_OUTSIDE_BOUNDARY', 'SCAN_NAMESPACE_CHANGED'].includes(error.code)
          ? error.code
          : 'SCAN_FAILED',
        message: error && error.code === 'SCAN_LIMIT_EXCEEDED'
          ? `Markdown scan limit exceeded (${this.maxFiles})`
          : error && error.code === 'SCAN_BYTE_LIMIT_EXCEEDED'
            ? `Markdown aggregate byte limit exceeded (${this.maxTotalBytes})`
            : error && error.code === 'PATH_OUTSIDE_BOUNDARY'
              ? 'Knowledge directory escaped the configured project boundary; the previous snapshot was retained'
              : error && error.code === 'SCAN_NAMESPACE_CHANGED'
                ? 'Knowledge directory changed during scanning; the previous snapshot was retained'
            : 'Knowledge directory scan failed; the previous snapshot was retained',
      };
      this.lastError = publicError;
      this.emit('scan-error', publicError);
      return {
        snapshot: this.snapshot,
        changes: { upserts: [], deletes: [] },
        warnings: [],
        error: publicError,
      };
    }
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.scanNow();
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.scanPromise) {
      await this.scanPromise;
    }
  }
}

module.exports = {
  PollingScanner,
  ScanByteLimitError,
  ScanLimitError,
  diffSnapshots,
  isTemporaryName,
  scanKnowledgeDirectory,
};
