'use strict';

const REQUIRED_FIELDS = [
  'schema',
  'id',
  'project',
  'account',
  'machine',
  'question_at',
  'response_at',
  'model',
  'status',
];

function parseScalar(rawValue, lineNumber, warnings) {
  const value = rawValue.trim();

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      warnings.push(`Unterminated double quote on frontmatter line ${lineNumber}`);
      return value.slice(1);
    }

    try {
      return JSON.parse(value);
    } catch {
      warnings.push(`Invalid double-quoted value on frontmatter line ${lineNumber}`);
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      warnings.push(`Unterminated single quote on frontmatter line ${lineNumber}`);
      return value.slice(1);
    }

    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value.replace(/\s+#.*$/, '').trim();
}

function parseFrontmatter(normalizedText) {
  const lines = normalizedText.split('\n');
  const fields = Object.create(null);
  const warnings = [];

  if (lines[0].trim() !== '---') {
    return {
      body: normalizedText,
      fields,
      valid: false,
      warnings: ['Missing frontmatter block'],
    };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    return {
      body: normalizedText,
      fields,
      valid: false,
      warnings: ['Frontmatter block is not closed'],
    };
  }

  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      warnings.push(`Invalid frontmatter line ${index + 1}`);
      continue;
    }

    fields[match[1]] = String(parseScalar(match[2], index + 1, warnings));
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(fields, field) || fields[field] === '') {
      warnings.push(`Missing frontmatter field: ${field}`);
    }
  }

  return {
    body: lines.slice(closingIndex + 1).join('\n'),
    fields,
    valid: warnings.length === 0,
    warnings,
  };
}

function parseCharacterCount(value) {
  if (!/^\d+$/.test(String(value || ''))) {
    return null;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function findLengthDelimitedSections(body, fields) {
  const hasQuestionLength = Object.hasOwn(fields, 'question_chars');
  const hasResponseLength = Object.hasOwn(fields, 'response_chars');
  if (!hasQuestionLength && !hasResponseLength) {
    return null;
  }

  const questionLength = parseCharacterCount(fields.question_chars);
  const responseLength = parseCharacterCount(fields.response_chars);
  if (questionLength === null || responseLength === null) {
    return { error: 'Invalid question_chars or response_chars frontmatter field' };
  }

  const prefix = '# Conversation\n\n## User\n\n';
  const separator = '\n\n## Copilot\n\n';
  const prefixIndex = body.indexOf(prefix);
  if (prefixIndex < 0) {
    return { error: 'Length-delimited conversation prefix is missing' };
  }

  const questionStart = prefixIndex + prefix.length;
  const questionEnd = questionStart + questionLength;
  if (body.slice(questionEnd, questionEnd + separator.length) !== separator) {
    return { error: 'Length-delimited Copilot separator is missing' };
  }

  const responseStart = questionEnd + separator.length;
  const responseEnd = responseStart + responseLength;
  if (responseEnd > body.length || body.slice(responseEnd).trim() !== '') {
    return { error: 'Length-delimited response size does not match the Markdown body' };
  }

  return {
    complete: true,
    question: body.slice(questionStart, questionEnd),
    response: body.slice(responseStart, responseEnd),
  };
}

function findSections(body, fields, warnings) {
  const lengthDelimited = findLengthDelimitedSections(body, fields);
  if (lengthDelimited && !lengthDelimited.error) {
    return lengthDelimited;
  }
  if (lengthDelimited && lengthDelimited.error) {
    warnings.push(lengthDelimited.error);
  }

  const lines = body.split('\n');
  let conversationIndex = -1;
  let userIndex = -1;
  let copilotIndex = -1;
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (fence) {
      continue;
    }

    if (conversationIndex === -1 && /^#\s+Conversation\s*$/i.test(line)) {
      conversationIndex = index;
    } else if (userIndex === -1 && /^##\s+User\s*$/i.test(line)) {
      userIndex = index;
    } else if (userIndex !== -1 && copilotIndex === -1 && /^##\s+Copilot\s*$/i.test(line)) {
      copilotIndex = index;
    }
  }

  let question = '';
  let response = '';

  if (userIndex !== -1) {
    const questionEnd = copilotIndex === -1 ? lines.length : copilotIndex;
    question = lines.slice(userIndex + 1, questionEnd).join('\n').trim();
  } else {
    question = body.trim();
  }

  if (copilotIndex !== -1) {
    response = lines.slice(copilotIndex + 1).join('\n').trim();
  }

  return {
    complete: conversationIndex !== -1 && userIndex !== -1 && copilotIndex !== -1,
    question,
    response,
  };
}

function validTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || 'conversation.md')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function parseConversationMarkdown(source, metadata = {}) {
  const rawText = typeof source === 'string' ? source : String(source ?? '');
  const normalizedText = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const frontmatter = parseFrontmatter(normalizedText);
  const warnings = [...frontmatter.warnings];
  const sections = findSections(frontmatter.body, frontmatter.fields, warnings);

  if (!sections.complete) {
    warnings.push('Expected # Conversation, ## User, and ## Copilot sections');
  }

  const parsed = warnings.length === 0 && sections.complete;
  const fields = frontmatter.fields;
  const relativePath = normalizeRelativePath(metadata.relativePath);
  const filename = relativePath.split('/').pop() || 'conversation.md';
  const mtimeMs = Number.isFinite(metadata.mtimeMs) ? metadata.mtimeMs : 0;
  const responseTime = validTimestamp(fields.response_at);
  const questionTime = validTimestamp(fields.question_at);
  const sortTime = responseTime ?? questionTime ?? mtimeMs;

  return {
    relativePath,
    filename,
    schema: fields.schema || '',
    id: fields.id || relativePath,
    project: fields.project || '',
    account: fields.account || 'unknown',
    accountSource: fields.account_source || 'unspecified',
    machine: fields.machine || 'unknown',
    questionAt: fields.question_at || '',
    responseAt: fields.response_at || '',
    model: fields.model || 'unknown',
    status: fields.status || 'unknown',
    question: sections.question || frontmatter.body.trim() || normalizedText.trim(),
    response: sections.response,
    parsed,
    parseWarnings: warnings,
    rawText: parsed ? null : rawText,
    fileModifiedAt: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '',
    size: Number.isFinite(metadata.size) ? metadata.size : Buffer.byteLength(rawText),
    sortTime,
  };
}

module.exports = {
  parseConversationMarkdown,
};
