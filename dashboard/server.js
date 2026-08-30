'use strict';

const { createDashboardServer } = require('./lib/core');
const { formatHelp, parseCliArgs } = require('./lib/config');

function displayUrl(host, port) {
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

async function startDashboard(options, dependencies = {}) {
  const output = dependencies.output || console.log;
  const errorOutput = dependencies.errorOutput || console.error;
  const processReference = dependencies.processReference || process;
  const dashboard = createDashboardServer(options);
  const address = await dashboard.start();
  const port = typeof address === 'object' && address ? address.port : options.port;

  output(`Knowledge Relay: ${displayUrl(options.host, port)}`);
  output(`Watching: ${dashboard.options.knowledgePath}`);
  output(`Polling: ${dashboard.options.intervalMs} ms (Ctrl+C to stop)`);

  let shutdownPromise = null;

  async function shutdown(signal = 'manual') {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    processReference.off('SIGINT', onSigint);
    processReference.off('SIGTERM', onSigterm);
    output(`Stopping dashboard (${signal})...`);
    shutdownPromise = dashboard.close().catch((error) => {
      processReference.exitCode = 1;
      errorOutput(`Shutdown failed: ${error.message}`);
      throw error;
    });
    return shutdownPromise;
  }

  function onSigint() {
    void shutdown('SIGINT').catch(() => {});
  }

  function onSigterm() {
    void shutdown('SIGTERM').catch(() => {});
  }

  processReference.once('SIGINT', onSigint);
  processReference.once('SIGTERM', onSigterm);

  return {
    address,
    dashboard,
    shutdown,
  };
}

async function main(
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
) {
  const output = dependencies.output || console.log;
  const options = parseCliArgs(argv, env);

  if (options.help) {
    output(formatHelp());
    return { dashboard: null, shutdown: async () => {} };
  }

  return startDashboard(options, dependencies);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`Could not start Knowledge Relay: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  startDashboard,
};
