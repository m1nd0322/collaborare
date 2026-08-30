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

function requestRaw(baseUrl, requestPath) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      method: 'GET',
      path: requestPath,
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
    /resolves outside the project/,
  );
});
