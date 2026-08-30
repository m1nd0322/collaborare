'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');

const { startDashboard } = require('../server');
const {
  createTestDirectory,
  removeTestDirectory,
} = require('../test-support/helpers');

test('CLI runtime closes its listener and signal handlers on SIGTERM', async (t) => {
  const knowledgePath = await createTestDirectory('server-shutdown');
  const processReference = new EventEmitter();
  processReference.exitCode = 0;
  const output = [];
  let runtime;

  t.after(async () => {
    await runtime?.shutdown();
    await removeTestDirectory(knowledgePath);
  });

  runtime = await startDashboard({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
    intervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    maxFileBytes: 1024 * 1024,
    maxFiles: 10,
  }, {
    processReference,
    output: (message) => output.push(message),
    errorOutput: (message) => output.push(message),
  });

  assert.equal(runtime.dashboard.server.listening, true);
  assert.equal(processReference.listenerCount('SIGINT'), 1);
  assert.equal(processReference.listenerCount('SIGTERM'), 1);
  assert.match(output[0], /^Knowledge Relay: http:\/\/127\.0\.0\.1:\d+$/);

  const closed = once(runtime.dashboard.server, 'close');
  processReference.emit('SIGTERM');
  await closed;

  assert.equal(runtime.dashboard.server.listening, false);
  assert.equal(processReference.listenerCount('SIGINT'), 0);
  assert.equal(processReference.listenerCount('SIGTERM'), 0);
});
