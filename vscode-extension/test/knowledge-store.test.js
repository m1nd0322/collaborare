'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureKnowledgeDatabase,
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

test('knowledge database initialization rejects a nested symlink that escapes the project root', async (t) => {
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
    ensureKnowledgeDatabase(knowledgeRoot, projectRoot),
    /resolves outside the project root/
  );
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
    /resolves outside the project root/
  );
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
