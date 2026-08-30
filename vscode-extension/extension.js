'use strict';

const crypto = require('node:crypto');
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const {
  ensureKnowledgeDatabase,
  resolveKnowledgeRoot,
  saveConversation,
  scanMarkdownFiles
} = require('./src/knowledge-store');
const { selectRelevantDocuments } = require('./src/retrieval');
const { buildPrompt, fitKnowledgeDocuments, formatHistory } = require('./src/prompt');
const {
  enqueuePendingConversation,
  flushPendingConversations
} = require('./src/pending-queue');

const PARTICIPANT_ID = 'collaborare.collaborare';
const DEFAULTS = {
  localSpoolMaxFiles: 500,
  localSpoolMaxBytes: 33554432,
  maxKnowledgeFiles: 500,
  maxContextChars: 24000,
  maxFileBytes: 262144,
  maxKnowledgeBytes: 33554432,
  topK: 8
};
let pendingQueueRoot;

class UserFacingError extends Error {}

function readBoundedInteger(configuration, key, minimum, maximum) {
  const value = configuration.get(key, DEFAULTS[key]);
  if (!Number.isInteger(value)) {
    return DEFAULTS[key];
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function firstWorkspaceFolder() {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
}

function resolveProjectRoot(configuredPath, workspaceFolder) {
  const configured = String(configuredPath || '').trim();
  const workspacePath = workspaceFolder && workspaceFolder.uri && workspaceFolder.uri.fsPath;

  if (!configured) {
    if (!workspacePath) {
      throw new UserFacingError(
        'No project root is available. Open a workspace folder or set collaborare.projectPath.'
      );
    }
    return path.resolve(workspacePath);
  }

  if (path.isAbsolute(configured)) {
    return path.resolve(configured);
  }
  if (!workspacePath) {
    throw new UserFacingError(
      'A relative collaborare.projectPath requires an open workspace folder.'
    );
  }
  return path.resolve(workspacePath, configured);
}

async function getRuntimeSettings() {
  const configuration = vscode.workspace.getConfiguration('collaborare');
  const workspaceFolder = firstWorkspaceFolder();
  const projectRoot = resolveProjectRoot(configuration.get('projectPath', ''), workspaceFolder);

  let projectStats;
  try {
    projectStats = await fs.stat(projectRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new UserFacingError(`The configured project root does not exist: ${projectRoot}`);
    }
    throw error;
  }
  if (!projectStats.isDirectory()) {
    throw new UserFacingError(`The configured project root is not a directory: ${projectRoot}`);
  }
  const canonicalProjectRoot = await fs.realpath(projectRoot);

  let knowledgeRoot;
  try {
    knowledgeRoot = resolveKnowledgeRoot(
      projectRoot,
      configuration.get('knowledgeDirectory', 'knowledge-database')
    );
  } catch (error) {
    throw new UserFacingError(error.message);
  }

  const matchingWorkspace = (vscode.workspace.workspaceFolders || []).find(
    (folder) => path.resolve(folder.uri.fsPath) === projectRoot
  );

  return {
    projectRoot,
    canonicalProjectRoot,
    projectName: matchingWorkspace ? matchingWorkspace.name : path.basename(projectRoot) || projectRoot,
    knowledgeRoot,
    configuredAccount: String(configuration.get('accountName', '') || '').trim(),
    localSpoolEnabled: configuration.get('localSpoolEnabled', true) !== false,
    localSpoolMaxFiles: readBoundedInteger(configuration, 'localSpoolMaxFiles', 1, 10000),
    localSpoolMaxBytes: readBoundedInteger(configuration, 'localSpoolMaxBytes', 1048576, 536870912),
    maxKnowledgeFiles: readBoundedInteger(configuration, 'maxKnowledgeFiles', 1, 5000),
    maxContextChars: readBoundedInteger(configuration, 'maxContextChars', 1000, 200000),
    maxFileBytes: readBoundedInteger(configuration, 'maxFileBytes', 1024, 5242880),
    maxKnowledgeBytes: readBoundedInteger(configuration, 'maxKnowledgeBytes', 1048576, 536870912),
    topK: readBoundedInteger(configuration, 'topK', 1, 100)
  };
}

function machineName() {
  return String(process.env.COMPUTERNAME || os.hostname() || 'unknown-host');
}

function localAccountIdentifier() {
  let username = process.env.USERNAME || process.env.USER || '';
  try {
    username = os.userInfo().username || username;
  } catch (_error) {
    // Environment variables remain available when the operating system lookup fails.
  }
  return `local:${username || 'unknown-user'}@${machineName()}`;
}

function validateAccountName(value) {
  const accountName = String(value || '').trim();
  if (!accountName) {
    throw new UserFacingError('A GitHub Copilot account name is required for audit logs.');
  }
  if (accountName.length > 256 || /[\0\r\n]/.test(accountName)) {
    throw new UserFacingError('The GitHub Copilot account name must be one line and at most 256 characters.');
  }
  return accountName;
}

async function listGitHubAccounts() {
  const accounts = [];

  if (typeof vscode.authentication.getAccounts === 'function') {
    for (const provider of ['github', 'github-enterprise']) {
      try {
        const providerAccounts = await vscode.authentication.getAccounts(provider);
        for (const account of providerAccounts) {
          const label = account && String(account.label || '').trim();
          if (label) {
            accounts.push({ name: label, provider });
          }
        }
      } catch (_error) {
        // A provider may not be installed or available in this VS Code build.
      }
    }
  }

  if (accounts.length === 0) {
    for (const provider of ['github', 'github-enterprise']) {
      try {
        const session = await vscode.authentication.getSession(provider, [], { silent: true });
        const label = session && session.account && String(session.account.label || '').trim();
        if (label) {
          accounts.push({ name: label, provider });
        }
      } catch (_error) {
        // Authentication is best-effort; no token or session data is retained.
      }
    }
  }

  const unique = new Map();
  for (const account of accounts) {
    if (!unique.has(account.name)) {
      unique.set(account.name, account);
    }
  }
  return [...unique.values()];
}

async function enterAccountName(defaultValue = '') {
  const value = await vscode.window.showInputBox({
    title: 'Collaborare: Copilot Account Name',
    prompt: 'Enter the GitHub Copilot Enterprise account name to write to shared audit logs.',
    placeHolder: 'github-account-name',
    value: defaultValue,
    ignoreFocusOut: true,
    validateInput(input) {
      try {
        validateAccountName(input);
        return undefined;
      } catch (error) {
        return error.message;
      }
    }
  });
  if (value === undefined) {
    throw new UserFacingError('Account selection was cancelled. Configure an account before using @collaborare.');
  }
  return validateAccountName(value);
}

async function chooseAccountName(accounts, defaultValue = '') {
  if (accounts.length === 0) {
    return enterAccountName(defaultValue);
  }

  const items = accounts.map((account) => ({
    label: account.name,
    description: account.provider,
    account
  }));
  items.push({
    label: 'Enter a different account name',
    description: 'manual entry',
    account: null
  });
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Collaborare: Copilot Account Name',
    placeHolder: 'Select the account used by GitHub Copilot in this VM',
    ignoreFocusOut: true
  });
  if (!selected) {
    throw new UserFacingError('Account selection was cancelled. Configure an account before using @collaborare.');
  }
  return selected.account ? selected.account.name : enterAccountName(defaultValue);
}

async function saveConfiguredAccount(accountName) {
  const validated = validateAccountName(accountName);
  const configuration = vscode.workspace.getConfiguration('collaborare');
  await configuration.update('accountName', validated, vscode.ConfigurationTarget.Global);
  return validated;
}

async function configureAccountName() {
  const configuration = vscode.workspace.getConfiguration('collaborare');
  const current = String(configuration.get('accountName', '') || '').trim();
  const selected = await chooseAccountName(await listGitHubAccounts(), current);
  return saveConfiguredAccount(selected);
}

async function resolveAccountName(configuredAccount, options = {}) {
  if (configuredAccount) {
    return { name: validateAccountName(configuredAccount), source: 'setting' };
  }

  const accounts = await listGitHubAccounts();
  if (accounts.length === 1) {
    return { name: accounts[0].name, source: accounts[0].provider };
  }
  if (options.interactive) {
    const selected = await chooseAccountName(accounts);
    const saved = await saveConfiguredAccount(selected);
    return { name: saved, source: 'user selection' };
  }

  return { name: localAccountIdentifier(), source: 'local fallback' };
}

function isCopilotChatInstalled() {
  return Boolean(
    vscode.extensions.getExtension('GitHub.copilot-chat') ||
    vscode.extensions.getExtension('github.copilot-chat')
  );
}

function modelName(model) {
  if (!model) {
    return 'unavailable';
  }
  const identity = [model.vendor, model.family, model.version].filter(Boolean).join('/');
  return model.id ? `${identity || model.name || 'model'} (${model.id})` : identity || model.name || 'unknown';
}

function cleanErrorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error || 'Unknown error');
  return message.replace(/[\r\n]+/g, ' ').trim() || 'Unknown error';
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_{}[\]()<>#+\-.!|])/g, '\\$1');
}

function isCancellation(error, token) {
  return Boolean(
    token.isCancellationRequested ||
    (error && (error.name === 'Canceled' || error.name === 'CancellationError' || error.code === 'Canceled'))
  );
}

function auditResponse(responseText, status, errorMessage) {
  const sections = [];
  if (responseText) {
    sections.push(responseText);
  }
  if (status === 'cancelled') {
    sections.push('_Response cancelled._');
  } else if (status === 'error') {
    sections.push(`_Collaborare error: ${cleanErrorMessage(errorMessage)}_`);
  }
  return sections.join('\n\n') || '_No response content._';
}

async function warnLogFailure(stream, error, options = {}) {
  const queued = options.queued === true;
  const message = queued
    ? `Collaborare could not publish the conversation to the shared drive, so it was queued in this VM and will be retried: ${cleanErrorMessage(error)}`
    : `Collaborare could not save or queue the conversation log: ${cleanErrorMessage(error)}`;
  try {
    stream.markdown(`\n\n> **Warning:** ${escapeMarkdown(message)}`);
  } catch (_streamError) {
    // The response stream can already be closed after cancellation.
  }
  try {
    void vscode.window.showWarningMessage(message).then(undefined, () => {});
  } catch (_notificationError) {
    // A notification failure must not replace a response that was already generated.
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function saveConversationWithRetry(runtime, conversation, id, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await wait(150 * (2 ** (attempt - 1)));
    }
    try {
      return await saveConversation(runtime.knowledgeRoot, conversation, {
        id,
        projectRoot: runtime.canonicalProjectRoot,
        projectRootIsCanonical: true,
        requireExistingRoot: true
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function syncPendingForRuntime(runtime) {
  if (!runtime.localSpoolEnabled || !pendingQueueRoot) {
    return { considered: 0, synced: 0, failed: 0, remaining: 0 };
  }
  return flushPendingConversations(pendingQueueRoot, {
    knowledgeRoot: runtime.knowledgeRoot,
    async save(entry) {
      await saveConversationWithRetry(runtime, entry.conversation, entry.id, 2);
    }
  });
}

async function handleConversation(request, chatContext, stream, token, questionAt) {
  const conversationId = crypto.randomUUID();
  const question = String(request.prompt || '');
  let runtime;
  let account;
  let responseText = '';
  let status = 'error';
  let errorMessage = '';
  let result;

  try {
    runtime = await getRuntimeSettings();
    account = await resolveAccountName(runtime.configuredAccount, { interactive: true });

    if (!question.trim()) {
      throw new UserFacingError('Enter a question after @collaborare.');
    }

    stream.progress('Searching shared project knowledge...');
    let scan = await scanMarkdownFiles(runtime.knowledgeRoot, {
      maxFiles: runtime.maxKnowledgeFiles,
      maxFileBytes: runtime.maxFileBytes,
      maxTotalBytes: runtime.maxKnowledgeBytes,
      canonicalProjectRoot: runtime.canonicalProjectRoot,
      isCancelled: () => token.isCancellationRequested
    });

    if (token.isCancellationRequested || scan.stats.cancelled) {
      status = 'cancelled';
      return { metadata: { status } };
    }
    if (scan.stats.failedFiles > 0) {
      throw new UserFacingError(
        `Shared knowledge scan was incomplete (${scan.stats.failedFiles} read failure(s)). Check the Z: drive and file permissions before retrying.`
      );
    }
    if (scan.stats.byteLimitReached) {
      throw new UserFacingError(
        `Shared knowledge exceeds the ${runtime.maxKnowledgeBytes}-byte scan limit. Archive old records or raise collaborare.maxKnowledgeBytes before retrying.`
      );
    }
    const pendingSync = await syncPendingForRuntime(runtime);
    if (pendingSync.synced > 0) {
      stream.progress(`Synchronized ${pendingSync.synced} pending conversation log(s).`);
      scan = await scanMarkdownFiles(runtime.knowledgeRoot, {
        maxFiles: runtime.maxKnowledgeFiles,
        maxFileBytes: runtime.maxFileBytes,
        maxTotalBytes: runtime.maxKnowledgeBytes,
        canonicalProjectRoot: runtime.canonicalProjectRoot,
        isCancelled: () => token.isCancellationRequested
      });
      if (token.isCancellationRequested || scan.stats.cancelled) {
        status = 'cancelled';
        return { metadata: { status } };
      }
      if (scan.stats.failedFiles > 0 || scan.stats.byteLimitReached) {
        throw new UserFacingError('Shared knowledge changed or became unavailable while pending logs were synchronized. Retry the request.');
      }
    }
    if (!isCopilotChatInstalled()) {
      throw new UserFacingError(
        'GitHub Copilot Chat is not installed. Install or enable GitHub Copilot Chat, then retry @collaborare.'
      );
    }
    if (!request.model || typeof request.model.sendRequest !== 'function') {
      throw new UserFacingError('No Copilot chat model is available for this request.');
    }

    const historyBudget = Math.floor(runtime.maxContextChars * 0.3);
    const history = formatHistory(chatContext.history, historyBudget);
    const knowledgeBudget = Math.max(1, runtime.maxContextChars - history.length);
    const retrievalQuery = history ? `${question}\n${history}` : question;
    const rankedSelection = selectRelevantDocuments(retrievalQuery, scan.documents, {
      topK: Math.min(runtime.topK, runtime.maxKnowledgeFiles),
      maxChars: knowledgeBudget
    });
    const selected = fitKnowledgeDocuments(rankedSelection, knowledgeBudget);

    for (const document of selected) {
      stream.reference(vscode.Uri.file(document.path));
    }

    const prompt = buildPrompt({ question, history, documents: selected });
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const modelResponse = await request.model.sendRequest(messages, {}, token);

    for await (const fragment of modelResponse.text) {
      if (token.isCancellationRequested) {
        break;
      }
      responseText += fragment;
      stream.markdown(fragment);
    }

    status = token.isCancellationRequested ? 'cancelled' : 'complete';
    result = { metadata: { status, knowledgeFiles: selected.length } };
  } catch (error) {
    if (isCancellation(error, token)) {
      status = 'cancelled';
      result = { metadata: { status } };
    } else {
      status = 'error';
      errorMessage = cleanErrorMessage(error);
      stream.markdown(`\n\n> **Collaborare error:** ${escapeMarkdown(errorMessage)}`);
      result = {
        errorDetails: { message: errorMessage },
        metadata: { status }
      };
    }
  } finally {
    const responseAt = new Date().toISOString();
    if (runtime && account) {
      try {
        const conversation = {
          project: runtime.projectName,
          account: account.name,
          accountSource: account.source,
          machine: machineName(),
          questionAt,
          responseAt,
          model: modelName(request.model),
          status,
          question,
          response: auditResponse(responseText, status, errorMessage)
        };
        await saveConversationWithRetry(runtime, conversation, conversationId);
      } catch (logError) {
        let queued = false;
        let warningError = logError;
        if (runtime.localSpoolEnabled && pendingQueueRoot) {
          try {
            await enqueuePendingConversation(pendingQueueRoot, {
              id: conversationId,
              projectRoot: runtime.projectRoot,
              knowledgeRoot: runtime.knowledgeRoot,
              conversation: {
                project: runtime.projectName,
                account: account.name,
                accountSource: account.source,
                machine: machineName(),
                questionAt,
                responseAt,
                model: modelName(request.model),
                status,
                question,
                response: auditResponse(responseText, status, errorMessage)
              }
            }, {
              maxFiles: runtime.localSpoolMaxFiles,
              maxTotalBytes: runtime.localSpoolMaxBytes
            });
            queued = true;
          } catch (queueError) {
            warningError = new Error(
              `shared publish failed (${cleanErrorMessage(logError)}); local queue failed (${cleanErrorMessage(queueError)})`
            );
          }
        }
        await warnLogFailure(stream, warningError, { queued });
      }
    }
  }

  return result;
}

function inlineCode(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

async function initializeDatabase() {
  const runtime = await getRuntimeSettings();
  await ensureKnowledgeDatabase(runtime.knowledgeRoot, runtime.canonicalProjectRoot, {
    projectRootIsCanonical: true
  });
  return runtime;
}

async function syncPendingLogs() {
  const runtime = await initializeDatabase();
  const stats = await syncPendingForRuntime(runtime);
  return { runtime, stats };
}

async function statusReport() {
  const runtime = await initializeDatabase();
  const account = await resolveAccountName(runtime.configuredAccount);
  const scan = await scanMarkdownFiles(runtime.knowledgeRoot, {
    maxFiles: runtime.maxKnowledgeFiles,
    maxFileBytes: runtime.maxFileBytes,
    maxTotalBytes: runtime.maxKnowledgeBytes,
    canonicalProjectRoot: runtime.canonicalProjectRoot
  });
  await fs.access(runtime.knowledgeRoot, fsConstants.R_OK | fsConstants.W_OK);

  return {
    runtime,
    account,
    scan,
    copilotInstalled: isCopilotChatInstalled()
  };
}

function formatStatusMarkdown(status) {
  return [
    '**Collaborare status**',
    '',
    `- Project root: ${inlineCode(status.runtime.projectRoot)}`,
    `- Knowledge directory: ${inlineCode(status.runtime.knowledgeRoot)}`,
    `- Account: ${inlineCode(status.account.name)} (${status.account.source})`,
    `- GitHub Copilot Chat: ${status.copilotInstalled ? 'installed' : 'not installed'}`,
    `- Markdown files loaded: ${status.scan.stats.loadedFiles}`,
    `- Markdown files considered: ${status.scan.stats.consideredFiles}/${status.runtime.maxKnowledgeFiles}`,
    `- Oversized files skipped: ${status.scan.stats.oversizedFiles}`,
    `- Read failures: ${status.scan.stats.failedFiles}`,
    `- Markdown bytes loaded: ${status.scan.stats.loadedBytes}/${status.runtime.maxKnowledgeBytes}`,
    `- Context budget: ${status.runtime.maxContextChars} characters; top K: ${Math.min(status.runtime.topK, status.runtime.maxKnowledgeFiles)}`
  ].join('\n');
}

async function handleSlashCommand(command, stream) {
  try {
    if (command === 'init') {
      const runtime = await initializeDatabase();
      stream.markdown(`Knowledge database initialized at ${inlineCode(runtime.knowledgeRoot)}.`);
      return { metadata: { command, status: 'complete' } };
    }
    if (command === 'open') {
      const runtime = await initializeDatabase();
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(runtime.knowledgeRoot));
      stream.markdown(`Opened ${inlineCode(runtime.knowledgeRoot)}.`);
      return { metadata: { command, status: 'complete' } };
    }
    if (command === 'status') {
      stream.markdown(formatStatusMarkdown(await statusReport()));
      return { metadata: { command, status: 'complete' } };
    }
    if (command === 'account') {
      const accountName = await configureAccountName();
      stream.markdown(`Copilot account name saved for this VM: ${inlineCode(accountName)}.`);
      return { metadata: { command, status: 'complete' } };
    }
    if (command === 'sync') {
      const { stats } = await syncPendingLogs();
      stream.markdown(
        `Pending log sync finished: ${stats.synced} synchronized, ${stats.failed} failed, ${stats.remaining} remaining.`
      );
      return { metadata: { command, status: stats.failed > 0 ? 'error' : 'complete' } };
    }
    throw new UserFacingError(`Unknown Collaborare command: /${command}`);
  } catch (error) {
    const message = cleanErrorMessage(error);
    stream.markdown(`> **Collaborare error:** ${escapeMarkdown(message)}`);
    return { errorDetails: { message }, metadata: { command, status: 'error' } };
  }
}

async function handler(request, chatContext, stream, token) {
  const questionAt = new Date().toISOString();
  if (request.command) {
    return handleSlashCommand(request.command, stream);
  }
  return handleConversation(request, chatContext, stream, token, questionAt);
}

async function runCommand(action, successMessage) {
  try {
    const value = await action();
    await vscode.window.showInformationMessage(successMessage(value));
  } catch (error) {
    await vscode.window.showErrorMessage(cleanErrorMessage(error));
  }
}

function activate(context) {
  pendingQueueRoot = context.globalStorageUri && context.globalStorageUri.fsPath
    ? path.join(context.globalStorageUri.fsPath, 'pending-conversations')
    : undefined;
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('database');

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand('collaborare.initializeKnowledgeDatabase', () =>
      runCommand(initializeDatabase, (runtime) => `Knowledge database initialized: ${runtime.knowledgeRoot}`)
    ),
    vscode.commands.registerCommand('collaborare.openKnowledgeDatabase', () =>
      runCommand(async () => {
        const runtime = await initializeDatabase();
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(runtime.knowledgeRoot));
        return runtime;
      }, (runtime) => `Knowledge database opened: ${runtime.knowledgeRoot}`)
    ),
    vscode.commands.registerCommand('collaborare.checkStatus', () =>
      runCommand(statusReport, (status) =>
        `Collaborare: ${status.scan.stats.loadedFiles} Markdown file(s), Copilot Chat ${status.copilotInstalled ? 'installed' : 'not installed'}, account ${status.account.name}`
      )
    ),
    vscode.commands.registerCommand('collaborare.configureAccount', () =>
      runCommand(configureAccountName, (accountName) => `Collaborare account saved for this VM: ${accountName}`)
    ),
    vscode.commands.registerCommand('collaborare.syncPendingLogs', () =>
      runCommand(syncPendingLogs, ({ stats }) =>
        `Collaborare pending logs: ${stats.synced} synchronized, ${stats.failed} failed, ${stats.remaining} remaining`
      )
    )
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
