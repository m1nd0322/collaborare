'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const temporaryRoot = path.join(__dirname, '..', 'test', '.tmp');

async function createTestDirectory(prefix) {
  await fs.mkdir(temporaryRoot, { recursive: true });
  return fs.mkdtemp(path.join(temporaryRoot, `${prefix}-`));
}

async function removeTestDirectory(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}

function conversationMarkdown(id, overrides = {}) {
  const values = {
    schema: 'collaborare/conversation/v1',
    id,
    project: 'Test Project',
    account: 'test@example.local',
    machine: 'WIN-TEST-01',
    question_at: '2026-08-30T01:00:00Z',
    response_at: '2026-08-30T01:01:00Z',
    model: 'test-model',
    status: 'complete',
    question: `Question ${id}`,
    response: `Response ${id}`,
    ...overrides,
  };

  return `---
schema: ${values.schema}
id: ${values.id}
project: ${values.project}
account: ${values.account}
machine: ${values.machine}
question_at: ${values.question_at}
response_at: ${values.response_at}
model: ${values.model}
status: ${values.status}
---
# Conversation
## User
${values.question}
## Copilot
${values.response}
`;
}

module.exports = {
  conversationMarkdown,
  createTestDirectory,
  removeTestDirectory,
};
