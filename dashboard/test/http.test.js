'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { createDashboardServer } = require('../lib/core');
const {
  conversationMarkdown,
  createTestDirectory,
  removeTestDirectory,
} = require('../test-support/helpers');

function requestRaw(baseUrl, requestPath, headers = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      method: 'GET',
      path: requestPath,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
          statusCode: response.statusCode,
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function openEventStream(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let buffer = '';
      const waiters = new Set();

      function settleWaiters() {
        for (const waiter of waiters) {
          if (buffer.includes(waiter.text)) {
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            waiter.resolve(buffer);
          }
        }
      }

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        settleWaiters();
      });

      resolve({
        request,
        response,
        waitFor(text, timeoutMs = 1500) {
          if (buffer.includes(text)) {
            return Promise.resolve(buffer);
          }

          return new Promise((waitResolve, waitReject) => {
            const waiter = {
              text,
              resolve: waitResolve,
              reject: waitReject,
              timer: setTimeout(() => {
                waiters.delete(waiter);
                waitReject(new Error(`Timed out waiting for SSE text: ${text}`));
              }, timeoutMs),
            };
            waiters.add(waiter);
          });
        },
        close() {
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject?.(new Error('Event stream closed'));
          }
          waiters.clear();
          response.destroy();
          request.destroy();
        },
      });
    });
    request.on('error', reject);
  });
}

test('HTTP API, static assets, and SSE expose safe local dashboard behavior', async (t) => {
  const projectPath = await createTestDirectory('http-project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  const dayPath = path.join(knowledgePath, 'conversations', '2026-08-30');
  await fs.mkdir(dayPath, { recursive: true });
  await fs.writeFile(
    path.join(dayPath, 'older.md'),
    conversationMarkdown('older', { response_at: '2026-08-30T01:01:00Z' }),
  );
  await fs.writeFile(
    path.join(dayPath, 'newer.md'),
    conversationMarkdown('newer', { response_at: '2026-08-30T02:01:00Z' }),
  );

  const dashboard = createDashboardServer({
    project: projectPath,
    host: '127.0.0.1',
    port: 0,
    intervalMs: 60_000,
    heartbeatIntervalMs: 30,
    maxFileBytes: 1024 * 1024,
    maxFiles: 100,
  });
  let eventStream;
  t.after(async () => {
    eventStream?.close();
    await dashboard.close();
    await removeTestDirectory(projectPath);
  });

  const address = await dashboard.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const healthText = await healthResponse.text();
  const health = JSON.parse(healthText);
  assert.equal(healthResponse.status, 200);
  assert.match(healthResponse.headers.get('content-type'), /^application\/json/);
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), null);
  assert.equal(health.status, 'ok');
  assert.equal(health.conversationCount, 2);
  assert.equal(health.knowledgePath, `${path.basename(projectPath)}/knowledge-database`);
  assert.equal(healthText.includes(projectPath), false);

  const conversationsResponse = await fetch(`${baseUrl}/api/conversations`);
  const snapshotText = await conversationsResponse.text();
  const snapshot = JSON.parse(snapshotText);
  assert.match(conversationsResponse.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(snapshot.items.map((item) => item.id), ['newer', 'older']);
  assert.equal(snapshotText.includes(projectPath), false);
  assert.ok(snapshot.items.every((item) => !path.isAbsolute(item.relativePath)));

  const forgedHost = await requestRaw(baseUrl, '/api/conversations', {
    Host: `attacker.example:${address.port}`,
  });
  assert.equal(forgedHost.statusCode, 421);
  assert.equal(forgedHost.body.includes('newer'), false);

  const crossOrigin = await requestRaw(baseUrl, '/api/conversations', {
    Origin: 'http://attacker.example',
  });
  assert.equal(crossOrigin.statusCode, 421);
  assert.equal(crossOrigin.body.includes('newer'), false);

  const crossSite = await requestRaw(baseUrl, '/api/conversations', {
    'Sec-Fetch-Site': 'cross-site',
  });
  assert.equal(crossSite.statusCode, 421);
  assert.equal(crossSite.body.includes('newer'), false);

  const forgedEventHost = await requestRaw(baseUrl, '/api/events', {
    Host: `attacker.example:${address.port}`,
  });
  assert.equal(forgedEventHost.statusCode, 421);
  assert.equal(forgedEventHost.body.includes('event: ready'), false);

  const indexResponse = await fetch(`${baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get('content-type'), /^text\/html/);
  assert.match(indexResponse.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await indexResponse.text(), /Knowledge Relay/);

  const scriptResponse = await fetch(`${baseUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type'), /^text\/javascript/);
  assert.equal((await scriptResponse.text()).includes('innerHTML'), false);

  const traversal = await requestRaw(baseUrl, '/..%2fserver.js');
  assert.equal(traversal.statusCode, 403);
  assert.equal(traversal.body.includes('createDashboardServer'), false);

  const methodResponse = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
  assert.equal(methodResponse.status, 405);
  assert.match(methodResponse.headers.get('content-type'), /^application\/json/);

  const missingApiResponse = await fetch(`${baseUrl}/api/missing`);
  assert.equal(missingApiResponse.status, 404);
  assert.match(missingApiResponse.headers.get('content-type'), /^application\/json/);

  eventStream = await openEventStream(`${baseUrl}/api/events`);
  assert.match(eventStream.response.headers['content-type'], /^text\/event-stream/);
  await eventStream.waitFor('event: ready');
  await eventStream.waitFor('event: heartbeat');

  const addedPath = path.join(dayPath, 'added.md');
  await fs.writeFile(addedPath, conversationMarkdown('added'));
  await dashboard.scanner.scanNow();
  const upsertBuffer = await eventStream.waitFor('event: upsert');
  assert.match(upsertBuffer, /conversations\/2026-08-30\/added\.md/);

  const largePath = path.join(dayPath, 'large.md');
  await fs.writeFile(largePath, conversationMarkdown('large', { response: 'x'.repeat(100_000) }));
  await dashboard.scanner.scanNow();
  const largeBuffer = await eventStream.waitFor('conversations/2026-08-30/large.md');
  assert.match(largeBuffer, /Response|x{100}/);

  const afterLargePath = path.join(dayPath, 'after-large.md');
  await fs.writeFile(afterLargePath, conversationMarkdown('after-large'));
  await dashboard.scanner.scanNow();
  const afterLargeBuffer = await eventStream.waitFor('conversations/2026-08-30/after-large.md');
  assert.match(afterLargeBuffer, /after-large/);

  await fs.unlink(addedPath);
  await dashboard.scanner.scanNow();
  const deleteBuffer = await eventStream.waitFor('event: delete');
  assert.match(deleteBuffer, /conversations\/2026-08-30\/added\.md/);
});

test('server rejects a project knowledge directory symlink that escapes the project', async (t) => {
  const temporaryRoot = await createTestDirectory('http-path-safety');
  const projectPath = path.join(temporaryRoot, 'project');
  const outsidePath = path.join(temporaryRoot, 'outside');
  await fs.mkdir(projectPath);
  await fs.mkdir(outsidePath);
  try {
    await fs.symlink(outsidePath, path.join(projectPath, 'knowledge-database'), 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      await removeTestDirectory(temporaryRoot);
      return;
    }
    throw error;
  }

  const dashboard = createDashboardServer({
    project: projectPath,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(temporaryRoot);
  });

  await assert.rejects(
    dashboard.start(),
    /symbolic link or junction|resolves outside the project/,
  );
});

test('server rejects an in-project intermediate symlink in the knowledge path', async (t) => {
  const temporaryRoot = await createTestDirectory('http-intermediate-link');
  const projectPath = path.join(temporaryRoot, 'project');
  const actualParent = path.join(projectPath, 'actual');
  const linkedParent = path.join(projectPath, 'linked');
  const knowledgePath = path.join(linkedParent, 'knowledge-database');
  await fs.mkdir(path.join(actualParent, 'knowledge-database'), { recursive: true });
  try {
    await fs.symlink(actualParent, linkedParent, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      await removeTestDirectory(temporaryRoot);
      return;
    }
    throw error;
  }
  const dashboard = createDashboardServer({
    project: projectPath,
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(temporaryRoot);
  });

  await assert.rejects(
    dashboard.start(),
    /path cannot contain a symbolic link or junction/,
  );
});

test('server rejects an out-of-project lexical alias even when it resolves inside the project', async (t) => {
  const temporaryRoot = await createTestDirectory('http-outside-alias');
  const projectPath = path.join(temporaryRoot, 'project');
  const actualKnowledgePath = path.join(projectPath, 'actual-knowledge');
  const aliasPath = path.join(temporaryRoot, 'project-alias');
  const aliasedKnowledgePath = path.join(aliasPath, 'actual-knowledge');
  await fs.mkdir(actualKnowledgePath, { recursive: true });
  try {
    await fs.symlink(projectPath, aliasPath, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Creating directory symlinks is not permitted on this platform.');
      await removeTestDirectory(temporaryRoot);
      return;
    }
    throw error;
  }
  const dashboard = createDashboardServer({
    project: projectPath,
    knowledgePath: aliasedKnowledgePath,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(temporaryRoot);
  });

  await assert.rejects(
    dashboard.start(),
    /Knowledge path must be inside the configured project path/,
  );
});

test('a conventional standalone knowledge path infers and pins its project boundary', async (t) => {
  const projectPath = await createTestDirectory('http-inferred-project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  await fs.mkdir(knowledgePath);
  const dashboard = createDashboardServer({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(projectPath);
  });

  assert.equal(dashboard.scanner.boundaryRoot, projectPath);
});

test('server fails startup without creating a missing knowledge directory', async (t) => {
  const projectPath = await createTestDirectory('http-missing-knowledge');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  const dashboard = createDashboardServer({
    project: projectPath,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(projectPath);
  });

  await assert.rejects(
    dashboard.start(),
    /Knowledge directory does not exist:/,
  );
  await assert.rejects(
    fs.stat(knowledgePath),
    (error) => error && error.code === 'ENOENT',
  );
});

test('standalone server retains its snapshot when the knowledge root is replaced', async (t) => {
  const temporaryRoot = await createTestDirectory('http-pinned-knowledge');
  const knowledgePath = path.join(temporaryRoot, 'knowledge');
  const retainedPath = path.join(temporaryRoot, 'retained-knowledge');
  await fs.mkdir(knowledgePath);
  await fs.writeFile(path.join(knowledgePath, 'inside.md'), conversationMarkdown('inside'));
  const dashboard = createDashboardServer({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
    intervalMs: 60_000,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(temporaryRoot);
  });
  await dashboard.start();
  await fs.rename(knowledgePath, retainedPath);
  await fs.mkdir(knowledgePath);
  await fs.writeFile(path.join(knowledgePath, 'outside.md'), conversationMarkdown('outside'));

  const report = await dashboard.scanner.scanNow();

  assert.equal(report.error.code, 'SCAN_NAMESPACE_CHANGED');
  assert.deepEqual(dashboard.scanner.getConversations().map((item) => item.id), ['inside']);
});

test('project server retains its snapshot when the project root is replaced around the same knowledge directory', async (t) => {
  const temporaryRoot = await createTestDirectory('http-pinned-project');
  const projectPath = path.join(temporaryRoot, 'project');
  const retainedProjectPath = path.join(temporaryRoot, 'retained-project');
  const knowledgePath = path.join(projectPath, 'knowledge-database');
  await fs.mkdir(knowledgePath, { recursive: true });
  await fs.writeFile(path.join(knowledgePath, 'inside.md'), conversationMarkdown('inside'));
  const dashboard = createDashboardServer({
    project: projectPath,
    host: '127.0.0.1',
    port: 0,
    intervalMs: 60_000,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(temporaryRoot);
  });
  await dashboard.start();
  await fs.rename(projectPath, retainedProjectPath);
  await fs.mkdir(projectPath);
  await fs.rename(
    path.join(retainedProjectPath, 'knowledge-database'),
    path.join(projectPath, 'knowledge-database'),
  );
  await fs.writeFile(path.join(knowledgePath, 'replacement.md'), conversationMarkdown('replacement'));

  const report = await dashboard.scanner.scanNow();

  assert.equal(report.error.code, 'SCAN_NAMESPACE_CHANGED');
  assert.deepEqual(dashboard.scanner.getConversations().map((item) => item.id), ['inside']);
});

test('IPv6 loopback authority is accepted in bracketed form', async (t) => {
  const knowledgePath = await createTestDirectory('http-ipv6');
  const dashboard = createDashboardServer({
    knowledgePath,
    host: '::1',
    port: 0,
    intervalMs: 60_000,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(knowledgePath);
  });

  let address;
  try {
    address = await dashboard.start();
  } catch (error) {
    if (error && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) {
      t.skip('IPv6 loopback is not available on this host.');
      return;
    }
    throw error;
  }

  const response = await fetch(`http://[::1]:${address.port}/api/health`);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});
