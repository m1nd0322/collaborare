'use strict';

const elements = {
  accountFilter: document.querySelector('#account-filter'),
  connectionIndicator: document.querySelector('#connection-indicator'),
  connectionLabel: document.querySelector('#connection-label'),
  conversationList: document.querySelector('#conversation-list'),
  emptyState: document.querySelector('#empty-state'),
  knowledgePath: document.querySelector('#knowledge-path'),
  lastUpdated: document.querySelector('#last-updated'),
  projectName: document.querySelector('#project-name'),
  resetFilters: document.querySelector('#reset-filters'),
  resultSummary: document.querySelector('#result-summary'),
  retryButton: document.querySelector('#retry-button'),
  searchInput: document.querySelector('#search-input'),
  serverNotice: document.querySelector('#server-notice'),
  sortOrder: document.querySelector('#sort-order'),
  statusFilter: document.querySelector('#status-filter'),
  template: document.querySelector('#conversation-template'),
  totalCount: document.querySelector('#total-count'),
  visibleCount: document.querySelector('#visible-count'),
};

const state = {
  eventSource: null,
  initialLoaded: false,
  items: new Map(),
  lastUpdatedAt: null,
  mutationQueue: [],
  mutationOverflow: false,
  newUntil: new Map(),
  noticeTimer: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  renderTimer: null,
  revision: 0,
  serverRevision: 0,
  snapshotPending: false,
  snapshotRequested: false,
  snapshotRetryAttempt: 0,
  snapshotRetryTimer: null,
};

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function parseEventData(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    showNotice('서버 이벤트를 해석하지 못했습니다.', 'error');
    return null;
  }
}

function formatDate(value) {
  if (!value) {
    return '미기록';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '미기록';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setConnection(connectionState, label) {
  elements.connectionIndicator.dataset.state = connectionState;
  elements.connectionLabel.textContent = label;
  elements.retryButton.hidden = connectionState === 'live' || connectionState === 'connecting';
}

function showNotice(message, tone = 'warning', timeoutMs = 9000) {
  window.clearTimeout(state.noticeTimer);
  elements.serverNotice.textContent = message;
  elements.serverNotice.dataset.tone = tone;
  elements.serverNotice.hidden = false;

  if (timeoutMs > 0) {
    state.noticeTimer = window.setTimeout(() => {
      elements.serverNotice.hidden = true;
    }, timeoutMs);
  }
}

function updateScope(payload) {
  if (payload.project) {
    elements.projectName.textContent = payload.project;
  }
  if (payload.knowledgePath) {
    elements.knowledgePath.textContent = payload.knowledgePath;
  }
}

function appendInlineMarkdown(target, text) {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__)/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) {
      target.append(document.createTextNode(text.slice(cursor, match.index)));
    }

    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      target.append(code);
    } else {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      target.append(strong);
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    target.append(document.createTextNode(text.slice(cursor)));
  }
}

function isBlockStart(line) {
  return /^\s*(`{3,}|~{3,})/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  const source = String(markdown || '').replace(/\r\n?/g, '\n');

  if (!source.trim()) {
    const missing = document.createElement('p');
    missing.className = 'missing-copy';
    missing.textContent = '기록된 내용이 없습니다.';
    container.append(missing);
    return;
  }

  const lines = source.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (fenceMatch) {
      const markerCharacter = fenceMatch[1][0];
      const markerLength = fenceMatch[1].length;
      const language = fenceMatch[2];
      const codeLines = [];
      index += 1;

      while (index < lines.length) {
        const closing = lines[index].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (closing && closing[1][0] === markerCharacter && closing[1].length >= markerLength) {
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }

      if (language) {
        const languageLabel = document.createElement('span');
        languageLabel.className = 'code-language';
        languageLabel.textContent = language;
        container.append(languageLabel);
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.append(code);
      container.append(pre);
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const heading = document.createElement('div');
      heading.className = 'md-heading';
      appendInlineMarkdown(heading, headingMatch[1]);
      container.append(heading);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.append(document.createElement('hr'));
      index += 1;
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      const list = document.createElement(unorderedMatch ? 'ul' : 'ol');
      const matcher = unorderedMatch ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;

      while (index < lines.length) {
        const itemMatch = lines[index].match(matcher);
        if (!itemMatch) {
          break;
        }
        const item = document.createElement('li');
        appendInlineMarkdown(item, itemMatch[1]);
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const quoteLines = [];
      while (index < lines.length) {
        const quoteMatch = lines[index].match(/^\s*>\s?(.*)$/);
        if (!quoteMatch) {
          break;
        }
        quoteLines.push(quoteMatch[1]);
        index += 1;
      }
      appendInlineMarkdown(quote, quoteLines.join(' '));
      container.append(quote);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    const paragraph = document.createElement('p');
    paragraphLines.forEach((paragraphLine, lineIndex) => {
      if (lineIndex > 0) {
        paragraph.append(document.createElement('br'));
      }
      appendInlineMarkdown(paragraph, paragraphLine);
    });
    container.append(paragraph);
  }
}

function statusTone(status) {
  const normalized = String(status || '').toLocaleLowerCase('en-US');
  if (['complete', 'completed', 'done', 'success', 'resolved'].includes(normalized)) {
    return 'success';
  }
  if (['pending', 'running', 'active', 'in_progress', 'partial'].includes(normalized)) {
    return 'active';
  }
  if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(normalized)) {
    return 'danger';
  }
  return 'neutral';
}

function setRoleText(fragment, role, value) {
  const node = fragment.querySelector(`[data-role="${role}"]`);
  node.textContent = value || 'unknown';
  node.title = value || 'unknown';
}

function createConversationNode(item, index) {
  const fragment = elements.template.content.cloneNode(true);
  const transmission = fragment.querySelector('.transmission');
  const status = fragment.querySelector('[data-role="status"]');
  const questionTime = fragment.querySelector('[data-role="question-time"]');
  const responseTime = fragment.querySelector('[data-role="response-time"]');
  const newFlag = fragment.querySelector('[data-role="new-flag"]');

  transmission.dataset.path = item.relativePath;
  setRoleText(fragment, 'sequence', String(index + 1).padStart(3, '0'));
  setRoleText(fragment, 'filename', item.filename);
  setRoleText(fragment, 'relative-path', item.relativePath);
  setRoleText(
    fragment,
    'account',
    item.accountSource && item.accountSource !== 'unspecified'
      ? `${item.account} · ${item.accountSource}`
      : item.account,
  );
  setRoleText(fragment, 'machine', item.machine);
  setRoleText(fragment, 'model', item.model);
  setRoleText(fragment, 'size', formatFileSize(item.size));

  status.textContent = item.status || 'unknown';
  status.dataset.tone = statusTone(item.status);
  questionTime.textContent = formatDate(item.questionAt);
  questionTime.dateTime = item.questionAt || '';
  responseTime.textContent = formatDate(item.responseAt);
  responseTime.dateTime = item.responseAt || '';

  renderMarkdown(fragment.querySelector('[data-role="question"]'), item.question);
  renderMarkdown(fragment.querySelector('[data-role="response"]'), item.response);

  const expiresAt = state.newUntil.get(item.relativePath) || 0;
  const isNew = expiresAt > Date.now();
  transmission.classList.toggle('is-new', isNew);
  newFlag.hidden = !isNew;

  if (!item.parsed) {
    const details = fragment.querySelector('[data-role="parse-details"]');
    const warningList = fragment.querySelector('[data-role="warnings"]');
    details.hidden = false;
    for (const warningText of item.parseWarnings || []) {
      const warning = document.createElement('li');
      warning.textContent = warningText;
      warningList.append(warning);
    }
    fragment.querySelector('[data-role="raw-text"]').textContent = item.rawText || '';
  }

  return fragment;
}

function updateSelectOptions(select, values, allLabel) {
  const selectedValue = select.value;
  const fragment = document.createDocumentFragment();
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = allLabel;
  fragment.append(allOption);

  for (const [value, count] of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value} (${count})`;
    fragment.append(option);
  }

  select.replaceChildren(fragment);
  select.value = values.some(([value]) => value === selectedValue) ? selectedValue : '';
}

function countedValues(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = String(item[key] || 'unknown');
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'ko'));
}

function searchableText(item) {
  return [
    item.filename,
    item.relativePath,
    item.project,
    item.account,
    item.accountSource,
    item.machine,
    item.model,
    item.status,
    item.question,
    item.response,
  ].join('\n').toLocaleLowerCase('ko');
}

function render() {
  const allItems = [...state.items.values()];
  updateSelectOptions(elements.accountFilter, countedValues(allItems, 'account'), '전체 계정');
  updateSelectOptions(elements.statusFilter, countedValues(allItems, 'status'), '전체 상태');

  const account = elements.accountFilter.value;
  const status = elements.statusFilter.value;
  const query = elements.searchInput.value.trim().toLocaleLowerCase('ko');
  const direction = elements.sortOrder.value === 'oldest' ? 1 : -1;
  const visibleItems = allItems
    .filter((item) => (!account || item.account === account) && (!status || item.status === status))
    .filter((item) => !query || searchableText(item).includes(query))
    .sort((left, right) => {
      const timeDifference = ((left.sortTime || 0) - (right.sortTime || 0)) * direction;
      return timeDifference || left.relativePath.localeCompare(right.relativePath, 'en');
    });

  const listFragment = document.createDocumentFragment();
  visibleItems.forEach((item, index) => {
    listFragment.append(createConversationNode(item, index));
  });
  elements.conversationList.replaceChildren(listFragment);

  elements.totalCount.textContent = String(allItems.length);
  elements.visibleCount.textContent = String(visibleItems.length);
  elements.resultSummary.textContent = `전체 ${allItems.length}건 중 ${visibleItems.length}건을 표시합니다.`;
  elements.emptyState.hidden = visibleItems.length !== 0 || !state.initialLoaded;
  elements.conversationList.setAttribute('aria-busy', String(state.snapshotPending));

  if (state.lastUpdatedAt) {
    elements.lastUpdated.textContent = formatDate(state.lastUpdatedAt);
    elements.lastUpdated.dateTime = state.lastUpdatedAt;
  }
}

function scheduleRender() {
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(render, 100);
}

function markNew(relativePath) {
  const expiresAt = Date.now() + 8000;
  state.newUntil.set(relativePath, expiresAt);
  window.setTimeout(() => {
    if ((state.newUntil.get(relativePath) || 0) <= Date.now()) {
      state.newUntil.delete(relativePath);
      render();
    }
  }, 8050);
}

function applyMutation(type, payload, shouldRender = true) {
  const eventRevision = Number(payload.revision) || 0;
  if (eventRevision && eventRevision <= state.revision) {
    return;
  }

  if (type === 'upsert' && payload.item?.relativePath) {
    const isNew = state.initialLoaded && !state.items.has(payload.item.relativePath);
    state.items.set(payload.item.relativePath, payload.item);
    if (isNew) {
      markNew(payload.item.relativePath);
    }
  } else if (type === 'delete' && payload.relativePath) {
    state.items.delete(payload.relativePath);
    state.newUntil.delete(payload.relativePath);
  } else {
    return;
  }

  state.revision = Math.max(state.revision, eventRevision);
  state.serverRevision = Math.max(state.serverRevision, eventRevision);
  state.lastUpdatedAt = new Date().toISOString();
  if (shouldRender) {
    render();
  }
}

function receiveMutation(type, payload) {
  const eventRevision = Number(payload.revision) || 0;
  state.serverRevision = Math.max(state.serverRevision, eventRevision);

  if (state.snapshotPending || !state.initialLoaded) {
    state.mutationQueue.push({ type, payload });
    if (state.mutationQueue.length > 10_000) {
      state.mutationQueue.length = 0;
      state.mutationOverflow = true;
      state.snapshotRequested = true;
      showNotice('실시간 변경 queue가 가득 차 전체 snapshot을 다시 요청합니다.', 'warning');
    }
    if (!state.snapshotPending) {
      void refreshSnapshot();
    }
    return;
  }

  if (state.initialLoaded && eventRevision > state.revision + 1) {
    state.mutationQueue.push({ type, payload });
    void refreshSnapshot();
    return;
  }

  applyMutation(type, payload);
}

function scheduleSnapshotRetry() {
  window.clearTimeout(state.snapshotRetryTimer);
  state.snapshotRetryAttempt += 1;
  const delay = Math.min(30_000, 1000 * (2 ** Math.min(state.snapshotRetryAttempt - 1, 5)));
  state.snapshotRetryTimer = window.setTimeout(() => void refreshSnapshot(), delay);
}

async function refreshSnapshot() {
  if (state.snapshotPending) {
    state.snapshotRequested = true;
    return;
  }

  state.snapshotPending = true;
  state.snapshotRequested = false;
  window.clearTimeout(state.snapshotRetryTimer);
  elements.conversationList.setAttribute('aria-busy', 'true');
  let snapshotSucceeded = false;

  try {
    const response = await fetch('/api/conversations', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const previousPaths = new Set(state.items.keys());
    const nextItems = new Map();
    for (const item of payload.items || []) {
      if (item?.relativePath) {
        nextItems.set(item.relativePath, item);
      }
    }

    if (state.initialLoaded) {
      for (const relativePath of nextItems.keys()) {
        if (!previousPaths.has(relativePath)) {
          markNew(relativePath);
        }
      }
    }

    state.items = nextItems;
    state.revision = Number(payload.revision) || 0;
    state.serverRevision = Math.max(state.serverRevision, state.revision);
    state.lastUpdatedAt = payload.generatedAt || new Date().toISOString();
    state.initialLoaded = true;
    state.snapshotRetryAttempt = 0;
    window.clearTimeout(state.snapshotRetryTimer);
    snapshotSucceeded = true;
    updateScope(payload);

    const overflowed = state.mutationOverflow;
    state.mutationOverflow = false;
    const queued = state.mutationQueue
      .splice(0)
      .sort((left, right) => (Number(left.payload.revision) || 0) - (Number(right.payload.revision) || 0));
    if (overflowed) {
      state.snapshotRequested = true;
    } else {
      for (const mutation of queued) {
        const mutationRevision = Number(mutation.payload.revision) || 0;
        if (mutationRevision > state.revision + 1) {
          state.snapshotRequested = true;
          break;
        }
        applyMutation(mutation.type, mutation.payload, false);
      }
    }
    render();
  } catch (error) {
    render();
    showNotice(`초기 대화 목록을 불러오지 못했습니다: ${error.message}`, 'error', 0);
    scheduleSnapshotRetry();
  } finally {
    state.snapshotPending = false;
    elements.conversationList.setAttribute('aria-busy', 'false');

    if (snapshotSucceeded && (state.snapshotRequested || state.serverRevision > state.revision)) {
      window.setTimeout(() => void refreshSnapshot(), 0);
    } else if (!snapshotSucceeded && state.snapshotRequested) {
      scheduleSnapshotRetry();
    }
  }
}

function scheduleReconnect() {
  window.clearTimeout(state.reconnectTimer);
  state.reconnectAttempt += 1;
  const delay = Math.min(30_000, 1000 * (2 ** Math.min(state.reconnectAttempt - 1, 5)));
  setConnection(
    navigator.onLine ? 'retrying' : 'offline',
    navigator.onLine ? `${Math.ceil(delay / 1000)}초 후 재연결` : '네트워크 오프라인',
  );
  state.reconnectTimer = window.setTimeout(connectEvents, delay);
}

function connectEvents() {
  window.clearTimeout(state.reconnectTimer);
  state.eventSource?.close();
  setConnection('connecting', '실시간 채널 연결 중');

  const eventSource = new EventSource('/api/events');
  state.eventSource = eventSource;

  eventSource.addEventListener('ready', (event) => {
    if (state.eventSource !== eventSource) {
      return;
    }
    const payload = parseEventData(event);
    if (!payload) {
      return;
    }
    state.reconnectAttempt = 0;
    state.serverRevision = Number(payload.revision) || 0;
    updateScope(payload);
    setConnection('live', '실시간 연결');
    void refreshSnapshot();
  });

  eventSource.addEventListener('upsert', (event) => {
    const payload = parseEventData(event);
    if (payload) {
      receiveMutation('upsert', payload);
    }
  });

  eventSource.addEventListener('delete', (event) => {
    const payload = parseEventData(event);
    if (payload) {
      receiveMutation('delete', payload);
    }
  });

  eventSource.addEventListener('resync', (event) => {
    const payload = parseEventData(event);
    if (payload && state.eventSource === eventSource) {
      state.serverRevision = Math.max(state.serverRevision, Number(payload.revision) || 0);
      void refreshSnapshot();
    }
  });

  eventSource.addEventListener('heartbeat', (event) => {
    const payload = parseEventData(event);
    if (payload && state.eventSource === eventSource) {
      const heartbeatRevision = Number(payload.revision) || 0;
      state.serverRevision = Math.max(state.serverRevision, heartbeatRevision);
      if (state.initialLoaded && heartbeatRevision > state.revision) {
        void refreshSnapshot();
      }
      setConnection('live', '실시간 연결');
    }
  });

  eventSource.addEventListener('error', (event) => {
    if (typeof event.data === 'string' && event.data) {
      const payload = parseEventData(event);
      if (payload) {
        showNotice(payload.message || '스캔 중 경고가 발생했습니다.', 'warning');
      }
      return;
    }

    if (state.eventSource !== eventSource) {
      return;
    }
    eventSource.close();
    state.eventSource = null;
    setConnection(navigator.onLine ? 'retrying' : 'offline', navigator.onLine ? '연결 끊김' : '네트워크 오프라인');
    scheduleReconnect();
  });
}

elements.retryButton.addEventListener('click', () => {
  state.reconnectAttempt = 0;
  connectEvents();
});

elements.searchInput.addEventListener('input', scheduleRender);
elements.accountFilter.addEventListener('change', render);
elements.statusFilter.addEventListener('change', render);
elements.sortOrder.addEventListener('change', render);
elements.resetFilters.addEventListener('click', () => {
  elements.searchInput.value = '';
  elements.accountFilter.value = '';
  elements.statusFilter.value = '';
  elements.sortOrder.value = 'newest';
  render();
});

window.addEventListener('online', () => {
  state.reconnectAttempt = 0;
  connectEvents();
});
window.addEventListener('offline', () => {
  setConnection('offline', '네트워크 오프라인');
});

connectEvents();
window.setTimeout(() => {
  if (!state.initialLoaded) {
    void refreshSnapshot();
  }
}, 1200);
