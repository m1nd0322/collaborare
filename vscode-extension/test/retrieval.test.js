'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  contentForRetrieval,
  rankDocuments,
  selectRelevantDocuments,
  tokenize
} = require('../src/retrieval');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 30);

function document(relativePath, content, ageDays) {
  return {
    path: `/knowledge/${relativePath}`,
    relativePath,
    content,
    mtimeMs: NOW - ageDays * DAY_MS,
    size: Buffer.byteLength(content)
  };
}

test('tokenize supports case-insensitive English and Hangul overlap tokens', () => {
  const tokens = tokenize('Deploy API 배포방법');
  assert.ok(tokens.has('deploy'));
  assert.ok(tokens.has('api'));
  assert.ok(tokens.has('배포방법'));
  assert.ok(tokens.has('ko:배포'));
});

test('token overlap outweighs freshness for an unrelated document', () => {
  const ranked = rankDocuments('How do we rotate the deployment key?', [
    document('old-relevant.md', 'Deployment key rotation runbook and rollback steps', 365),
    document('new-unrelated.md', 'Notes from today about office snacks', 0)
  ], { nowMs: NOW });

  assert.equal(ranked[0].relativePath, 'old-relevant.md');
  assert.ok(ranked[0].overlap > ranked[1].overlap);
});

test('Hangul overlap ranks a relevant Korean document first', () => {
  const ranked = rankDocuments('서비스 배포 방법을 알려주세요', [
    document('relevant.md', '서비스의 안전한 배포방법과 롤백 절차', 90),
    document('recent.md', '오늘 회의실 예약 내용', 0)
  ], { nowMs: NOW });

  assert.equal(ranked[0].relativePath, 'relevant.md');
});

test('freshness breaks ties between equally relevant documents', () => {
  const ranked = rankDocuments('release checklist', [
    document('old.md', 'release checklist', 300),
    document('new.md', 'release checklist', 1)
  ], { nowMs: NOW });

  assert.equal(ranked[0].relativePath, 'new.md');
});

test('selection obeys top K and aggregate excerpt character budget', () => {
  const selected = selectRelevantDocuments('deployment', [
    document('one.md', `deployment ${'a'.repeat(100)}`, 1),
    document('two.md', `deployment ${'b'.repeat(100)}`, 2),
    document('three.md', `deployment ${'c'.repeat(100)}`, 3)
  ], { topK: 2, maxChars: 61, nowMs: NOW });

  assert.equal(selected.length, 2);
  assert.ok(selected.reduce((total, item) => total + item.excerpt.length, 0) <= 61);
  assert.equal(selected.some((item) => item.relativePath === 'three.md'), false);
});

test('selection excludes documents with no lexical overlap', () => {
  const selected = selectRelevantDocuments('quantum zebra', [
    document('latest.md', 'deployment rollback procedure', 999)
  ], { nowMs: 1000, topK: 8, maxChars: 1000 });

  assert.deepEqual(selected, []);
});

test('retrieval ignores Collaborare frontmatter and structural headings', () => {
  const markdown = `---
schema: "collaborare/conversation/v1"
project: "project"
account: "account"
---

# Conversation

## User

deployment question

## Copilot

rollback answer`;

  assert.equal(contentForRetrieval(markdown).includes('schema:'), false);
  assert.deepEqual(
    selectRelevantDocuments('schema account Conversation User Copilot', [
      document('record.md', markdown, 1)
    ]),
    []
  );
});
