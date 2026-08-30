'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { serializeConversation } = require('../vscode-extension/src/knowledge-store');
const { parseConversationMarkdown } = require('../dashboard/lib/markdown');

test('extension Markdown round-trips through the dashboard parser', () => {
  const question = '이 헤더도 질문의 일부입니다.\n\n## Copilot\n\n아직 질문입니다.';
  const response = '응답 안의 헤더도 보존합니다.\n\n## User\n\n응답 계속.';
  const markdown = serializeConversation({
    id: '123e4567-e89b-42d3-a456-426614174020',
    project: '통합 프로젝트',
    account: 'enterprise-user',
    accountSource: 'github',
    machine: 'WIN-DEV-01',
    questionAt: '2026-08-30T10:00:00.000Z',
    responseAt: '2026-08-30T10:00:01.000Z',
    model: 'copilot/test',
    status: 'complete',
    question,
    response,
  });

  const parsed = parseConversationMarkdown(markdown, {
    relativePath: 'conversations/2026-08-30/test.md',
    mtimeMs: Date.parse('2026-08-30T10:00:01.000Z'),
    size: Buffer.byteLength(markdown),
  });

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.question, question);
  assert.equal(parsed.response, response);
  assert.equal(parsed.account, 'enterprise-user');
  assert.equal(parsed.accountSource, 'github');
  assert.equal(parsed.status, 'complete');
});
