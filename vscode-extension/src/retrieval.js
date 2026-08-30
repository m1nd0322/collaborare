'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESHNESS_HALF_LIFE_DAYS = 180;

function contentForRetrieval(content) {
  return String(content ?? '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
    .replace(/^#{1,2}\s+(?:Conversation|User|Copilot)\s*$/gim, '');
}

function tokenize(text) {
  const words = String(text ?? '').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = new Set();

  for (const word of words) {
    tokens.add(word);

    if (/^\p{Script=Hangul}+$/u.test(word)) {
      const characters = Array.from(word);
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.add(`ko:${characters[index]}${characters[index + 1]}`);
      }
    }
  }

  return tokens;
}

function scoreDocument(questionTokens, document, nowMs) {
  const documentTokens = tokenize(contentForRetrieval(document.content));
  let overlap = 0;

  for (const token of questionTokens) {
    if (documentTokens.has(token)) {
      overlap += 1;
    }
  }

  const overlapRatio = questionTokens.size === 0 ? 0 : overlap / questionTokens.size;
  const mtimeMs = Number.isFinite(document.mtimeMs) ? document.mtimeMs : 0;
  const ageDays = Math.max(0, nowMs - mtimeMs) / DAY_MS;
  const freshness = Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);

  return {
    ...document,
    overlap,
    freshness,
    score: overlap * 10 + overlapRatio * 5 + freshness
  };
}

function rankDocuments(question, documents, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const questionTokens = tokenize(question);

  return documents
    .map((document) => scoreDocument(questionTokens, document, nowMs))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }
      return String(left.relativePath || left.path).localeCompare(String(right.relativePath || right.path), 'en');
    });
}

function findFirstMatch(content, questionTokens) {
  const lower = content.toLocaleLowerCase('en-US');
  let matchIndex = -1;

  for (const token of questionTokens) {
    if (token.startsWith('ko:')) {
      continue;
    }
    const index = lower.indexOf(token);
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index;
    }
  }

  return matchIndex;
}

function makeExcerpt(content, questionTokens, maxChars) {
  const value = String(content ?? '');
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 12) {
    return value.slice(0, maxChars);
  }

  const matchIndex = findFirstMatch(value, questionTokens);
  const marker = '[...]';
  const start = matchIndex > 0
    ? Math.max(0, matchIndex - Math.floor(maxChars / 4))
    : 0;
  const prefix = start > 0 ? `${marker}\n` : '';
  const needsSuffix = start + maxChars < value.length;
  const suffix = needsSuffix ? `\n${marker}` : '';
  const bodyLength = Math.max(0, maxChars - prefix.length - suffix.length);
  const adjustedStart = Math.min(start, Math.max(0, value.length - bodyLength));

  return `${prefix}${value.slice(adjustedStart, adjustedStart + bodyLength)}${suffix}`.slice(0, maxChars);
}

function selectRelevantDocuments(question, documents, options = {}) {
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 8;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 24000;
  const questionTokens = tokenize(question);
  const minOverlap = Number.isInteger(options.minOverlap) && options.minOverlap >= 0
    ? options.minOverlap
    : 1;
  const ranked = rankDocuments(question, documents, options)
    .filter((document) => questionTokens.size > 0 && document.overlap >= minOverlap)
    .slice(0, topK);
  const selected = [];
  let remaining = maxChars;

  for (let index = 0; index < ranked.length && remaining > 0; index += 1) {
    const documentsRemaining = ranked.length - index;
    const allocation = Math.max(1, Math.floor(remaining / documentsRemaining));
    const excerpt = makeExcerpt(ranked[index].content, questionTokens, allocation);
    if (excerpt.length === 0) {
      continue;
    }

    selected.push({ ...ranked[index], excerpt });
    remaining -= excerpt.length;
  }

  return selected;
}

module.exports = {
  contentForRetrieval,
  makeExcerpt,
  rankDocuments,
  selectRelevantDocuments,
  tokenize
};
