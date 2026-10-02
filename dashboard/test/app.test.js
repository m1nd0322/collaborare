'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserHarness } = require('../test-support/browser');

function item(relativePath) {
  return {
    relativePath,
    filename: relativePath,
    account: 'test',
    status: 'complete',
    sortTime: 1,
    question: '',
    response: '',
  };
}

test('coalesces a burst of live mutations into one render', () => {
  const harness = createBrowserHarness();
  const { state, receiveMutation } = harness.context.__test;
  state.initialLoaded = true;
  harness.nodes.get('search-input').value = 'no-match';
  const list = harness.nodes.get('conversation-list');
  const initialRenderCount = list.replaceChildrenCount || 0;

  for (let index = 0; index < 100; index += 1) {
    receiveMutation('upsert', { revision: index + 1, item: item(`item-${index}.md`) });
  }

  assert.equal(list.replaceChildrenCount || 0, initialRenderCount, 'mutations should be queued before the render window closes');
  harness.advance(100);
  assert.equal(list.replaceChildrenCount, initialRenderCount + 1);
  assert.equal(harness.nodes.get('total-count').textContent, '100');
  assert.equal(harness.nodes.get('visible-count').textContent, '0');
  assert.equal(harness.nodes.get('search-input').value, 'no-match');
});

test('renders during a continuous mutation stream instead of starving the UI', () => {
  const harness = createBrowserHarness();
  const { state, receiveMutation } = harness.context.__test;
  state.initialLoaded = true;
  harness.nodes.get('search-input').value = 'no-match';
  const list = harness.nodes.get('conversation-list');

  for (let index = 0; index < 5; index += 1) {
    receiveMutation('upsert', { revision: index + 1, item: item(`stream-${index}.md`) });
    harness.advance(50);
  }

  assert.equal(list.replaceChildrenCount, 1, 'max wait flushes a continuously active stream');
});

test('ignores mutations emitted by a stale EventSource', () => {
  const harness = createBrowserHarness();
  const { state } = harness.context.__test;
  const first = harness.eventSources[0];
  harness.context.__test.connectEvents();
  const second = harness.eventSources[1];
  state.initialLoaded = true;

  second.emit('upsert', { revision: 1, item: item('active.md') });
  first.emit('delete', { revision: 2, relativePath: 'stale.md' });
  first.emit('upsert', { revision: 3, item: item('stale.md') });
  first.emit('error', { message: 'stale warning' });

  assert.equal(state.items.size, 1);
  assert.ok(state.items.has('active.md'));
  assert.equal(state.revision, 1);
  assert.equal(harness.nodes.get('server-notice').hidden, true);
  assert.equal(second.closed, false);
});

test('coalesces new-item expiry renders', () => {
  const harness = createBrowserHarness();
  const { state, receiveMutation } = harness.context.__test;
  state.initialLoaded = true;
  harness.nodes.get('search-input').value = 'no-match';
  const list = harness.nodes.get('conversation-list');

  for (let index = 0; index < 100; index += 1) {
    receiveMutation('upsert', { revision: index + 1, item: item(`expiry-${index}.md`) });
  }
  harness.advance(100);
  assert.equal(list.replaceChildrenCount, 1);
  harness.advance(8050);
  harness.advance(100);
  assert.equal(list.replaceChildrenCount, 2);
});

test('direct renders cancel pending scheduled renders', () => {
  const harness = createBrowserHarness();
  const { state, receiveMutation, render } = harness.context.__test;
  state.initialLoaded = true;
  harness.nodes.get('search-input').value = 'no-match';
  const list = harness.nodes.get('conversation-list');

  receiveMutation('upsert', { revision: 1, item: item('direct.md') });
  render();
  assert.equal(list.replaceChildrenCount, 1);
  harness.advance(300);
  assert.equal(list.replaceChildrenCount, 1);
});
