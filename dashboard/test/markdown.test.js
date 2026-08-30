'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseConversationMarkdown } = require('../lib/markdown');

test('parses quoted frontmatter, Korean text, and fenced code', () => {
  const source = `---
schema: "conversation/v1"
id: 'conv-001'
project: "프로젝트: 알파"
account: "개발 계정"
machine: WIN-DEV-01
question_at: "2026-08-30T09:10:11+09:00"
response_at: "2026-08-30T09:11:12+09:00"
model: "GPT-5 Copilot"
status: completed
---
# Conversation

## User

이 코드를 설명해 주세요.

## Copilot

다음처럼 실행합니다.

\`\`\`js
console.log("안전합니다");
\`\`\`
`;

  const conversation = parseConversationMarkdown(source, {
    relativePath: 'conversations/2026-08-30/conv-001.md',
    mtimeMs: Date.parse('2026-08-30T00:12:00Z'),
    size: Buffer.byteLength(source),
  });

  assert.equal(conversation.parsed, true);
  assert.equal(conversation.project, '프로젝트: 알파');
  assert.equal(conversation.account, '개발 계정');
  assert.equal(conversation.question, '이 코드를 설명해 주세요.');
  assert.match(conversation.response, /```js\nconsole\.log\("안전합니다"\);\n```/);
  assert.equal(conversation.filename, 'conv-001.md');
  assert.equal(conversation.rawText, null);
});

test('keeps safe fallback text when frontmatter is malformed', () => {
  const source = `---
schema: conversation/v1
id without a colon
status: completed
# Conversation
## User
수동으로 작성한 질문 <script>alert(1)</script>
`;

  const conversation = parseConversationMarkdown(source, {
    relativePath: 'conversations/2026-08-30/manual.md',
    mtimeMs: 1000,
    size: Buffer.byteLength(source),
  });

  assert.equal(conversation.parsed, false);
  assert.equal(conversation.filename, 'manual.md');
  assert.equal(conversation.rawText, source);
  assert.match(conversation.question, /수동으로 작성한 질문/);
  assert.ok(conversation.parseWarnings.length > 0);
});

test('parses useful sections while flagging malformed frontmatter lines', () => {
  const source = `---
schema: conversation/v1
id: manual-2
this is not frontmatter
account: 'O''Brien 팀'
status: partial
---
# Conversation
## User
질문입니다.
## Copilot
응답입니다.
`;

  const conversation = parseConversationMarkdown(source, {
    relativePath: 'manual-2.md',
    mtimeMs: 2000,
    size: Buffer.byteLength(source),
  });

  assert.equal(conversation.parsed, false);
  assert.equal(conversation.account, "O'Brien 팀");
  assert.equal(conversation.question, '질문입니다.');
  assert.equal(conversation.response, '응답입니다.');
  assert.match(conversation.parseWarnings.join(' '), /line/i);
});

test('plain Markdown remains visible as raw fallback content', () => {
  const source = '# 운영 메모\n\n연결이 끊기면 다시 시도합니다.';
  const conversation = parseConversationMarkdown(source, {
    relativePath: 'notes/operations.md',
    mtimeMs: 3000,
    size: Buffer.byteLength(source),
  });

  assert.equal(conversation.parsed, false);
  assert.equal(conversation.question, source);
  assert.equal(conversation.response, '');
  assert.equal(conversation.status, 'unknown');
  assert.equal(conversation.rawText, source);
});

test('length fields preserve section-like headings inside the user question', () => {
  const question = 'Why is this heading allowed?\n\n## Copilot\n\nThis is still the user question.';
  const response = 'The explicit character counts preserve it.';
  const source = `---
schema: "collaborare/conversation/v1"
id: "length-test"
project: "project"
account: "account"
machine: "machine"
question_at: "2026-08-30T09:10:11Z"
response_at: "2026-08-30T09:10:12Z"
model: "model"
status: "complete"
question_chars: "${question.length}"
response_chars: "${response.length}"
---

# Conversation

## User

${question}

## Copilot

${response}
`;

  const conversation = parseConversationMarkdown(source, { relativePath: 'length-test.md' });

  assert.equal(conversation.parsed, true);
  assert.equal(conversation.question, question);
  assert.equal(conversation.response, response);
});

test('invalid character lengths remain visible as a parse warning', () => {
  const source = `---
schema: collaborare/conversation/v1
id: invalid-length
question_chars: 999
response_chars: 8
---
# Conversation
## User
Question
## Copilot
Response
`;

  const conversation = parseConversationMarkdown(source, { relativePath: 'invalid-length.md' });

  assert.equal(conversation.parsed, false);
  assert.ok(conversation.rawText);
  assert.match(conversation.parseWarnings.join(' '), /length-delimited/i);
});
