'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');

const { createDashboardServer } = require('../lib/core');
const { startDashboard } = require('../server');
const {
  createTestDirectory,
  removeTestDirectory,
} = require('../test-support/helpers');

test('programmatic server options reject non-loopback bind hosts', () => {
  for (const host of ['0.0.0.0', '192.0.2.10']) {
    assert.throws(
      () => createDashboardServer({ knowledgePath: '/unused', host }),
      /host must be one of: 127\.0\.0\.1, ::1/,
    );
  }
});

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

test('close waits for a delayed initial scan and prevents startup after shutdown begins', async (t) => {
  const knowledgePath = await createTestDirectory('server-delayed-start-close');
  let releaseScan;
  let scanEntered;
  const scanStarted = new Promise((resolve) => {
    scanEntered = resolve;
  });
  const delayedScan = new Promise((resolve) => {
    releaseScan = resolve;
  });
  const scanner = new EventEmitter();
  scanner.snapshot = new Map();
  scanner.lastError = null;
  scanner.lastScanAt = null;
  scanner.scanNow = async () => {
    scanEntered();
    await delayedScan;
    return { snapshot: scanner.snapshot, changes: { upserts: [], deletes: [] }, warnings: [] };
  };
  scanner.start = () => {
    scanner.startCalls = (scanner.startCalls || 0) + 1;
  };
  scanner.stop = async () => {
    scanner.stopCalls = (scanner.stopCalls || 0) + 1;
  };

  const dashboard = createDashboardServer({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
    scanner,
  });
  t.after(async () => {
    releaseScan();
    await dashboard.close();
    await removeTestDirectory(knowledgePath);
  });

  const starting = dashboard.start();
  await scanStarted;
  const closing = dashboard.close();
  const closeState = await Promise.race([
    closing.then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);

  assert.equal(closeState, 'pending');
  releaseScan();
  await assert.rejects(starting, /shutdown|closing/i);
  await closing;
  assert.equal(dashboard.server.listening, false);
  assert.equal(scanner.startCalls || 0, 0);
  assert.equal(scanner.stopCalls, 1);
});

test('server can be started and closed again after a completed shutdown', async (t) => {
  const knowledgePath = await createTestDirectory('server-restart');
  const dashboard = createDashboardServer({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
    intervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(knowledgePath);
  });

  await dashboard.start();
  assert.equal(dashboard.server.listening, true);
  await dashboard.close();
  assert.equal(dashboard.server.listening, false);

  await dashboard.start();
  assert.equal(dashboard.server.listening, true);
  await dashboard.close();
  assert.equal(dashboard.server.listening, false);
});

test('start rejects and repeated close calls join while scanner shutdown is pending', async (t) => {
  const knowledgePath = await createTestDirectory('server-close-join');
  let releaseStop;
  let stopEntered;
  const stopStarted = new Promise((resolve) => {
    stopEntered = resolve;
  });
  const delayedStop = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const scanner = new EventEmitter();
  scanner.snapshot = new Map();
  scanner.lastError = null;
  scanner.lastScanAt = null;
  scanner.scanNow = async () => ({
    snapshot: scanner.snapshot,
    changes: { upserts: [], deletes: [] },
    warnings: [],
  });
  scanner.start = () => {};
  scanner.stop = async () => {
    stopEntered();
    await delayedStop;
  };

  const dashboard = createDashboardServer({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
    scanner,
  });
  t.after(async () => {
    releaseStop();
    await dashboard.close();
    await removeTestDirectory(knowledgePath);
  });

  await dashboard.start();
  const firstClose = dashboard.close();
  await stopStarted;
  assert.equal(dashboard.server.listening, true);
  await assert.rejects(dashboard.start(), /shutting down/);
  const secondClose = dashboard.close();

  releaseStop();
  await Promise.all([firstClose, secondClose]);
  assert.equal(dashboard.server.listening, false);
});

test('startup failure can be closed and retried without stale lifecycle state', async (t) => {
  const knowledgePath = await createTestDirectory('server-startup-retry');
  let scanCalls = 0;
  const scanner = new EventEmitter();
  scanner.snapshot = new Map();
  scanner.lastError = null;
  scanner.lastScanAt = null;
  scanner.scanNow = async () => {
    scanCalls += 1;
    if (scanCalls === 1) {
      throw new Error('injected startup failure');
    }
    return { snapshot: scanner.snapshot, changes: { upserts: [], deletes: [] }, warnings: [] };
  };
  scanner.start = () => {};
  scanner.stop = async () => {};

  const dashboard = createDashboardServer({
    knowledgePath,
    host: '127.0.0.1',
    port: 0,
    scanner,
  });
  t.after(async () => {
    await dashboard.close();
    await removeTestDirectory(knowledgePath);
  });

  await assert.rejects(dashboard.start(), /injected startup failure/);
  await dashboard.close();
  await dashboard.start();
  assert.equal(dashboard.server.listening, true);
  await dashboard.close();
  assert.equal(dashboard.server.listening, false);
});
