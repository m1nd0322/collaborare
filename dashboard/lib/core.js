'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { DEFAULTS } = require('./config');
const { PollingScanner } = require('./scanner');

const PUBLIC_DIRECTORY = path.resolve(__dirname, '..', 'public');
const STATIC_FILES = new Map([
  ['', { filename: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['index.html', { filename: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['styles.css', { filename: 'styles.css', contentType: 'text/css; charset=utf-8' }],
  ['app.js', { filename: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
]);

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function basenamePortable(value) {
  return path.win32.basename(path.basename(value));
}

function resolveRuntimeOptions(options) {
  const projectRoot = options.project ? path.resolve(options.project) : null;
  const knowledgeRoot = options.knowledgePath
    ? path.resolve(options.knowledgePath)
    : projectRoot && path.join(projectRoot, 'knowledge-database');

  if (!knowledgeRoot) {
    throw new Error('A project or knowledge path is required');
  }

  const knowledgeName = basenamePortable(knowledgeRoot) || 'knowledge-database';
  const inferredProjectRoot = projectRoot
    || (knowledgeName.toLowerCase() === 'knowledge-database' ? path.dirname(knowledgeRoot) : null);
  const projectName = options.projectName
    || (inferredProjectRoot && basenamePortable(inferredProjectRoot))
    || 'Standalone';

  return {
    projectRoot,
    knowledgeRoot,
    projectName,
    knowledgeName,
    knowledgeLabel: `${projectName}/${knowledgeName}`,
    host: options.host || DEFAULTS.host,
    port: options.port ?? DEFAULTS.port,
    intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
    maxFileBytes: options.maxFileBytes ?? DEFAULTS.maxFileBytes,
    maxFiles: options.maxFiles ?? DEFAULTS.maxFiles,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
  };
}

function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function sendJson(request, response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    response.end(body);
  }
}

function sendText(request, response, statusCode, message, extraHeaders = {}) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    response.end(body);
  }
}

function decodeRequestPath(requestUrl) {
  const rawPath = String(requestUrl || '/').split(/[?#]/, 1)[0];
  let decoded;

  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { error: 'Malformed URL path', statusCode: 400 };
  }

  if (decoded.includes('\0')) {
    return { error: 'Malformed URL path', statusCode: 400 };
  }

  const normalized = decoded.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    return { error: 'Path traversal is not allowed', statusCode: 403 };
  }

  return {
    pathname: segments.length === 0 ? '/' : `/${segments.join('/')}`,
    staticKey: segments.join('/'),
  };
}

function writeSseEvent(response, eventName, payload, id) {
  if (response.destroyed || response.writableEnded) {
    return false;
  }

  let frame = '';
  if (id !== undefined && id !== null) {
    frame += `id: ${id}\n`;
  }
  frame += `event: ${eventName}\n`;
  frame += `data: ${JSON.stringify(payload)}\n\n`;

  try {
    return response.write(frame);
  } catch {
    response.destroy();
    return false;
  }
}

function pathIsSameOrInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function assertRuntimePathSafety(options) {
  if (!options.projectRoot) {
    return null;
  }

  let projectStat;
  try {
    projectStat = await fs.stat(options.projectRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Project directory does not exist: ${options.projectRoot}`);
    }
    throw error;
  }
  if (!projectStat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${options.projectRoot}`);
  }

  await fs.mkdir(options.knowledgeRoot, { recursive: true });
  const [realProjectRoot, realKnowledgeRoot] = await Promise.all([
    fs.realpath(options.projectRoot),
    fs.realpath(options.knowledgeRoot),
  ]);
  if (!pathIsSameOrInside(realProjectRoot, realKnowledgeRoot)) {
    throw new Error('Knowledge directory resolves outside the project through a symbolic link or junction');
  }
  return realProjectRoot;
}

function sortConversations(conversations) {
  return conversations.sort((left, right) => {
    const timeDifference = (right.sortTime || 0) - (left.sortTime || 0);
    if (timeDifference !== 0) {
      return timeDifference;
    }
    return left.relativePath.localeCompare(right.relativePath, 'en');
  });
}

function createDashboardServer(inputOptions = {}) {
  const options = resolveRuntimeOptions(inputOptions);
  const scanner = inputOptions.scanner || new PollingScanner({
    rootPath: options.knowledgeRoot,
    intervalMs: options.intervalMs,
    maxFileBytes: options.maxFileBytes,
    maxFiles: options.maxFiles,
    maxTotalBytes: options.maxTotalBytes,
    boundaryRoot: options.projectRoot,
  });
  const clients = new Set();
  let revision = 0;
  let heartbeatTimer = null;
  let startedAt = null;
  let startPromise = null;
  let closePromise = null;

  function publicMetadata() {
    return {
      project: options.projectName,
      knowledgePath: options.knowledgeLabel,
    };
  }

  function removeClient(client) {
    clients.delete(client);
    if (client.onDrain) {
      client.response.off('drain', client.onDrain);
      client.onDrain = null;
    }
  }

  function markBackpressured(client) {
    if (client.blocked || !clients.has(client)) {
      return;
    }
    client.blocked = true;
    client.onDrain = () => {
      client.onDrain = null;
      client.blocked = false;
      if (!clients.has(client) || client.response.destroyed || client.response.writableEnded) {
        removeClient(client);
        return;
      }
      if (client.needsSnapshot) {
        client.needsSnapshot = false;
        if (!writeSseEvent(client.response, 'resync', { revision }, revision)) {
          if (client.response.destroyed || client.response.writableEnded) {
            removeClient(client);
          } else {
            markBackpressured(client);
          }
        }
      }
    };
    client.response.once('drain', client.onDrain);
  }

  function sendClientEvent(client, eventName, payload, id) {
    if (client.response.destroyed || client.response.writableEnded) {
      removeClient(client);
      return;
    }
    if (client.blocked) {
      if (eventName === 'upsert' || eventName === 'delete') {
        client.needsSnapshot = true;
      }
      return;
    }
    if (!writeSseEvent(client.response, eventName, payload, id)) {
      if (client.response.destroyed || client.response.writableEnded) {
        removeClient(client);
      } else {
        markBackpressured(client);
      }
    }
  }

  function broadcast(eventName, payload, id) {
    for (const client of clients) {
      sendClientEvent(client, eventName, payload, id);
    }
  }

  scanner.on('upsert', (conversation) => {
    revision += 1;
    broadcast('upsert', { revision, item: conversation }, revision);
  });
  scanner.on('delete', (relativePath) => {
    revision += 1;
    broadcast('delete', { revision, relativePath }, revision);
  });
  scanner.on('warning', (warning) => {
    broadcast('error', { revision, ...warning });
  });
  scanner.on('scan-error', (error) => {
    broadcast('error', { revision, ...error });
  });

  async function serveStatic(request, response, staticKey) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(request, response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const asset = STATIC_FILES.get(staticKey);
    if (!asset) {
      sendText(request, response, 404, 'Not found');
      return;
    }

    try {
      const body = await fs.readFile(path.join(PUBLIC_DIRECTORY, asset.filename));
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': body.length,
        'Content-Type': asset.contentType,
      });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        response.end(body);
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        sendText(request, response, 404, 'Not found');
      } else {
        sendText(request, response, 500, 'Could not load the dashboard asset');
      }
    }
  }

  function handleEventStream(request, response) {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    });
    response.flushHeaders?.();
    response.socket?.setKeepAlive(true);
    response.write(`retry: ${Math.max(1000, options.intervalMs)}\n\n`);
    const client = {
      blocked: false,
      needsSnapshot: false,
      onDrain: null,
      response,
    };
    clients.add(client);

    sendClientEvent(client, 'ready', {
      revision,
      total: scanner.snapshot.size,
      intervalMs: options.intervalMs,
      ...publicMetadata(),
    });

    const cleanup = () => {
      removeClient(client);
    };
    request.once('aborted', cleanup);
    response.once('close', cleanup);
  }

  async function handleRequest(request, response) {
    applySecurityHeaders(response);
    const decodedPath = decodeRequestPath(request.url);

    if (decodedPath.error) {
      const isApi = String(request.url || '').startsWith('/api');
      if (isApi) {
        sendJson(request, response, decodedPath.statusCode, { error: decodedPath.error });
      } else {
        sendText(request, response, decodedPath.statusCode, decodedPath.error);
      }
      return;
    }

    const { pathname, staticKey } = decodedPath;
    if (pathname.startsWith('/api')) {
      if (request.method !== 'GET') {
        sendJson(request, response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
        return;
      }

      if (pathname === '/api/health') {
        sendJson(request, response, 200, {
          status: scanner.lastError ? 'degraded' : 'ok',
          conversationCount: scanner.snapshot.size,
          connectedClients: clients.size,
          intervalMs: options.intervalMs,
          lastScanAt: scanner.lastScanAt,
          startedAt,
          limits: {
            maxFileBytes: options.maxFileBytes,
            maxFiles: options.maxFiles,
            maxTotalBytes: options.maxTotalBytes,
          },
          ...publicMetadata(),
        });
        return;
      }

      if (pathname === '/api/conversations') {
        const items = sortConversations(scanner.getConversations());
        sendJson(request, response, 200, {
          revision,
          total: items.length,
          generatedAt: new Date().toISOString(),
          items,
          ...publicMetadata(),
        });
        return;
      }

      if (pathname === '/api/events') {
        handleEventStream(request, response);
        return;
      }

      sendJson(request, response, 404, { error: 'API endpoint not found' });
      return;
    }

    await serveStatic(request, response, staticKey);
  }

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        applySecurityHeaders(response);
        sendJson(request, response, 500, { error: 'Internal server error' });
      } else {
        response.destroy();
      }
    });
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  async function start() {
    if (server.listening) {
      return server.address();
    }
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      const realProjectRoot = await assertRuntimePathSafety(options);
      if (realProjectRoot && Object.hasOwn(scanner, 'canonicalBoundaryRoot')) {
        scanner.canonicalBoundaryRoot = realProjectRoot;
      }
      await scanner.scanNow();

      await new Promise((resolve, reject) => {
        function onError(error) {
          server.off('listening', onListening);
          reject(error);
        }
        function onListening() {
          server.off('error', onError);
          resolve();
        }

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.host);
      });

      startedAt = new Date().toISOString();
      scanner.start();
      heartbeatTimer = setInterval(() => {
        broadcast('heartbeat', { at: new Date().toISOString(), revision });
      }, options.heartbeatIntervalMs);
      heartbeatTimer.unref();
      return server.address();
    })();

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function close() {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      for (const client of clients) {
        writeSseEvent(client.response, 'error', {
          code: 'SERVER_SHUTDOWN',
          message: 'Dashboard server is shutting down',
          revision,
        });
        client.response.end();
        removeClient(client);
      }
      clients.clear();
      await scanner.stop();

      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
          server.closeIdleConnections?.();
        });
      }
    })();

    return closePromise;
  }

  return {
    close,
    options: {
      host: options.host,
      port: options.port,
      intervalMs: options.intervalMs,
      maxFileBytes: options.maxFileBytes,
      maxFiles: options.maxFiles,
      maxTotalBytes: options.maxTotalBytes,
      ...publicMetadata(),
    },
    scanner,
    server,
    start,
  };
}

module.exports = {
  createDashboardServer,
  assertRuntimePathSafety,
  decodeRequestPath,
  resolveRuntimeOptions,
};
