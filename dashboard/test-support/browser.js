'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

class FakeNode {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.classList = { toggle() {} };
    this.hidden = false;
    this.value = '';
    this.listeners = new Map();
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
    this.replaceChildrenCount = (this.replaceChildrenCount || 0) + 1;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatchEvent(event) {
    this.listeners.get(event.type)?.(event);
  }

  querySelector() {
    return new FakeNode();
  }

  cloneNode() {
    return new FakeNode();
  }
}

class FakeEventSource {
  static instances = [];

  constructor() {
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, data) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
  }
}

function createBrowserHarness() {
  FakeEventSource.instances = [];
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const ids = [
    'account-filter', 'connection-indicator', 'connection-label', 'conversation-list',
    'empty-state', 'knowledge-path', 'last-updated', 'project-name', 'reset-filters',
    'result-summary', 'retry-button', 'search-input', 'server-notice', 'sort-order',
    'status-filter', 'conversation-template', 'total-count', 'visible-count',
  ];
  const nodes = new Map(ids.map((id) => [id, new FakeNode(id === 'conversation-template' ? 'template' : 'div')]));
  nodes.get('server-notice').hidden = true;
  nodes.get('conversation-template').content = new FakeNode('template-content');
  const document = {
    querySelector(selector) {
      return nodes.get(selector.slice(1)) || new FakeNode();
    },
    createElement(tagName) {
      return new FakeNode(tagName);
    },
    createDocumentFragment() {
      return new FakeNode('fragment');
    },
    createTextNode(text) {
      const node = new FakeNode('#text');
      node.textContent = text;
      return node;
    },
  };
  const window = {
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener() {},
  };
  const context = vm.createContext({
    console,
    Date: class extends Date {
      static now() { return now; }
    },
    Intl,
    JSON,
    Map,
    Set,
    String,
    Number,
    Math,
    Error,
    Promise,
    document,
    window,
    navigator: { onLine: true },
    EventSource: FakeEventSource,
    fetch: async () => ({ ok: true, json: async () => ({ items: [], revision: 0 }) }),
  });
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  vm.runInContext(`${source}\nthis.__test = { state, receiveMutation, render, connectEvents, scheduleRender };`, context);

  function advance(ms) {
    now += ms;
    let dueTimer;
    while ([...timers.entries()].some(([, timer]) => timer.due <= now)) {
      dueTimer = [...timers.entries()].filter(([, timer]) => timer.due <= now).sort((left, right) => left[1].due - right[1].due)[0];
      timers.delete(dueTimer[0]);
      dueTimer[1].callback();
    }
  }

  return { context, nodes, advance, eventSources: FakeEventSource.instances };
}

module.exports = { createBrowserHarness };
