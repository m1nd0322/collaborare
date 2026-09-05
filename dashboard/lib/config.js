'use strict';

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 43110,
  intervalMs: 2000,
  maxFileBytes: 256 * 1024,
  maxFiles: 2000,
  maxTotalBytes: 32 * 1024 * 1024,
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

const OPTION_NAMES = new Map([
  ['--project', 'project'],
  ['--knowledge-path', 'knowledgePath'],
  ['--host', 'host'],
  ['--port', 'port'],
  ['--interval', 'intervalMs'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-files', 'maxFiles'],
  ['--max-total-bytes', 'maxTotalBytes'],
]);

function readPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? 'a positive integer'
      : `an integer between 1 and ${maximum}`;
    throw new Error(`${label} must be ${range}`);
  }

  return Number(value);
}

function readLoopbackHost(value) {
  if (typeof value !== 'string' || !LOOPBACK_HOSTS.has(value)) {
    throw new Error('host must be one of: 127.0.0.1, ::1');
  }

  return value;
}

function readEnvironment(env) {
  return {
    project: env.DASHBOARD_PROJECT || undefined,
    knowledgePath: env.DASHBOARD_KNOWLEDGE_PATH || undefined,
    host: env.DASHBOARD_HOST || DEFAULTS.host,
    port: env.DASHBOARD_PORT
      ? readPositiveInteger(env.DASHBOARD_PORT, 'port', 65535)
      : DEFAULTS.port,
    intervalMs: env.DASHBOARD_INTERVAL
      ? readPositiveInteger(env.DASHBOARD_INTERVAL, 'interval')
      : DEFAULTS.intervalMs,
    maxFileBytes: env.DASHBOARD_MAX_FILE_BYTES
      ? readPositiveInteger(env.DASHBOARD_MAX_FILE_BYTES, 'max file bytes')
      : DEFAULTS.maxFileBytes,
    maxFiles: env.DASHBOARD_MAX_FILES
      ? readPositiveInteger(env.DASHBOARD_MAX_FILES, 'max files')
      : DEFAULTS.maxFiles,
    maxTotalBytes: env.DASHBOARD_MAX_TOTAL_BYTES
      ? readPositiveInteger(env.DASHBOARD_MAX_TOTAL_BYTES, 'max total bytes')
      : DEFAULTS.maxTotalBytes,
    help: false,
  };
}

function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const options = readEnvironment(env);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help') {
      options.help = true;
      continue;
    }

    const equalsAt = argument.indexOf('=');
    const optionName = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    const key = OPTION_NAMES.get(optionName);

    if (!key) {
      throw new Error(`Unknown option: ${optionName}`);
    }

    const value = equalsAt === -1 ? argv[index + 1] : argument.slice(equalsAt + 1);
    if (value === undefined || value === '' || (equalsAt === -1 && value.startsWith('--'))) {
      throw new Error(`Missing value for ${optionName}`);
    }

    if (equalsAt === -1) {
      index += 1;
    }

    if (key === 'port') {
      options.port = readPositiveInteger(value, 'port', 65535);
    } else if (key === 'intervalMs') {
      options.intervalMs = readPositiveInteger(value, 'interval');
    } else if (key === 'maxFileBytes') {
      options.maxFileBytes = readPositiveInteger(value, 'max file bytes');
    } else if (key === 'maxFiles') {
      options.maxFiles = readPositiveInteger(value, 'max files');
    } else if (key === 'maxTotalBytes') {
      options.maxTotalBytes = readPositiveInteger(value, 'max total bytes');
    } else {
      options[key] = value;
    }
  }

  if (!options.help && !options.project && !options.knowledgePath) {
    throw new Error('Either --project or --knowledge-path is required');
  }

  options.host = readLoopbackHost(options.host);

  return options;
}

function formatHelp() {
  return [
    'Knowledge Conversation Dashboard',
    '',
    'Usage:',
    '  node server.js --project "Z:\\ProjectName"',
    '  node server.js --knowledge-path "Z:\\ProjectName\\knowledge-database"',
    '',
    'Options:',
    '  --project <path>         Project root (watches <path>/knowledge-database)',
    '  --knowledge-path <path> Explicit knowledge-database path',
    `  --host <host>            Loopback bind host (default: ${DEFAULTS.host})`,
    `  --port <port>            Bind port (default: ${DEFAULTS.port})`,
    `  --interval <ms>          Polling interval (default: ${DEFAULTS.intervalMs})`,
    `  --max-file-bytes <bytes> Per-file limit (default: ${DEFAULTS.maxFileBytes})`,
    `  --max-files <count>      Markdown file limit (default: ${DEFAULTS.maxFiles})`,
    `  --max-total-bytes <bytes> Aggregate Markdown limit (default: ${DEFAULTS.maxTotalBytes})`,
    '  --help                   Show this help',
    '',
    'Environment: DASHBOARD_PROJECT, DASHBOARD_KNOWLEDGE_PATH, DASHBOARD_HOST,',
    '             DASHBOARD_PORT, DASHBOARD_INTERVAL, DASHBOARD_MAX_FILE_BYTES,',
    '             DASHBOARD_MAX_FILES, DASHBOARD_MAX_TOTAL_BYTES',
  ].join('\n');
}

module.exports = {
  DEFAULTS,
  formatHelp,
  parseCliArgs,
  readLoopbackHost,
};
