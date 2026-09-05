'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCliArgs } = require('../lib/config');

test('CLI parses a Windows project path and applies defaults', () => {
  const options = parseCliArgs(['--project', 'Z:\\Project Name'], {});

  assert.equal(options.project, 'Z:\\Project Name');
  assert.equal(options.knowledgePath, undefined);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 43110);
  assert.equal(options.intervalMs, 2000);
  assert.equal(options.maxFileBytes, 256 * 1024);
  assert.equal(options.maxFiles, 2000);
  assert.equal(options.maxTotalBytes, 32 * 1024 * 1024);
});

test('CLI values override corresponding environment variables', () => {
  const options = parseCliArgs(
    [
      '--knowledge-path=Z:\\Explicit\\knowledge-database',
      '--host',
      '127.0.0.1',
      '--port',
      '44000',
      '--interval',
      '750',
      '--max-total-bytes',
      '4096',
    ],
    {
      DASHBOARD_PROJECT: 'Z:\\FromEnvironment',
      DASHBOARD_HOST: '0.0.0.0',
      DASHBOARD_PORT: '45000',
      DASHBOARD_INTERVAL: '5000',
    },
  );

  assert.equal(options.project, 'Z:\\FromEnvironment');
  assert.equal(options.knowledgePath, 'Z:\\Explicit\\knowledge-database');
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 44000);
  assert.equal(options.intervalMs, 750);
  assert.equal(options.maxTotalBytes, 4096);
});

test('CLI rejects missing roots, unknown options, and invalid numbers', () => {
  assert.throws(() => parseCliArgs([], {}), /--project or --knowledge-path/);
  assert.throws(
    () => parseCliArgs(['--project', 'Z:\\P', '--wat'], {}),
    /Unknown option: --wat/,
  );
  assert.throws(
    () => parseCliArgs(['--project', 'Z:\\P', '--port', '70000'], {}),
    /port must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => parseCliArgs(['--project', 'Z:\\P', '--interval', '0'], {}),
    /interval must be a positive integer/,
  );
});

test('CLI accepts only explicit loopback bind hosts', () => {
  const ipv6Options = parseCliArgs(
    ['--project', 'Z:\\P', '--host', '::1'],
    {},
  );
  assert.equal(ipv6Options.host, '::1');

  assert.throws(
    () => parseCliArgs(['--project', 'Z:\\P', '--host', '0.0.0.0'], {}),
    /host must be one of: 127\.0\.0\.1, ::1/,
  );
  assert.throws(
    () => parseCliArgs(['--project', 'Z:\\P'], { DASHBOARD_HOST: '192.0.2.10' }),
    /host must be one of: 127\.0\.0\.1, ::1/,
  );
  assert.throws(
    () => parseCliArgs(['--project', 'Z:\\P', '--host', 'localhost'], {}),
    /host must be one of: 127\.0\.0\.1, ::1/,
  );
});

test('--help can be parsed without a project path', () => {
  const options = parseCliArgs(['--help'], {});
  assert.equal(options.help, true);
});

test('server module can be imported without starting a listener', () => {
  const serverModule = require('../server');

  assert.equal(typeof serverModule.main, 'function');
  assert.equal(typeof serverModule.startDashboard, 'function');
});
