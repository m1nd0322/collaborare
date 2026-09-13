'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function manifest(relativePath) {
  return JSON.parse(read(relativePath));
}

test('runtime package manifests have no downloadable dependencies', () => {
  for (const relativePath of [
    'package.json',
    'dashboard/package.json',
    'vscode-extension/package.json',
  ]) {
    const packageManifest = manifest(relativePath);
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'extensionDependencies',
      'extensionPack',
    ]) {
      assert.equal(
        Object.hasOwn(packageManifest, field),
        false,
        `${relativePath} must not declare ${field}`,
      );
    }
  }
});

test('browser assets contain no remote resource references', () => {
  const assets = [
    read('dashboard/public/index.html'),
    read('dashboard/public/styles.css'),
    read('dashboard/public/app.js'),
  ].join('\n');

  assert.doesNotMatch(assets, /https?:\/\//i);
  assert.doesNotMatch(assets, /@import\s/i);
  assert.doesNotMatch(assets, /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
});

test('VM runtime scripts do not invoke package managers or remote download tools', () => {
  const scripts = [
    read('scripts/Initialize-Project.ps1'),
    read('scripts/Install-Collaborare.ps1'),
    read('scripts/New-DeploymentManifest.ps1'),
    read('scripts/New-OfflineBundle.ps1'),
    read('scripts/Start-Dashboard.ps1'),
    read('scripts/Test-OfflineBundle.ps1'),
    read('scripts/Test-VsixArtifact.ps1'),
    read('scripts/Vsix-Validation.ps1'),
  ].join('\n');

  assert.doesNotMatch(
    scripts,
    /https?:\/\/(?!\$\{?urlHost\b|schemas\.openxmlformats\.org\/package\/2006\/content-types)/i,
  );
  assert.doesNotMatch(
    scripts,
    /^\s*(?:&\s+)?(?:npm|npx|curl|wget|Invoke-RestMethod)\b/im,
  );
});

test('extension runtime does not contain direct network endpoints', () => {
  const files = [
    'vscode-extension/extension.js',
    'vscode-extension/src/knowledge-store.js',
    'vscode-extension/src/pending-queue.js',
    'vscode-extension/src/prompt.js',
    'vscode-extension/src/retrieval.js',
  ];
  const source = files.map(read).join('\n');

  assert.doesNotMatch(source, /https?:\/\//i);
  assert.doesNotMatch(source, /require\(['"]node:(?:http|https|net|tls|dns)['"]\)/);
});

test('dashboard runtime contains no remote endpoint or outbound network client', () => {
  const files = [
    'dashboard/server.js',
    'dashboard/lib/config.js',
    'dashboard/lib/core.js',
    'dashboard/lib/markdown.js',
    'dashboard/lib/scanner.js',
  ];
  const source = files.map(read).join('\n');

  assert.doesNotMatch(source, /https:\/\//i);
  assert.doesNotMatch(source, /http:\/\/(?!\$\{(?:displayHost|authority)\})/i);
  assert.doesNotMatch(source, /require\(['"]node:(?:https|net|tls|dns)['"]\)/);
});
