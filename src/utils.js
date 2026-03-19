const fs = require("fs/promises");
const path = require("path");

const STOPWORDS = new Set([
  "и", "в", "во", "на", "с", "со", "к", "ко", "по", "о", "об", "от", "до", "за",
  "из", "у", "не", "ни", "а", "но", "или", "что", "как", "это", "этот", "эта",
  "эти", "для", "без", "под", "над", "при", "же", "ли", "бы", "то", "я", "мы",
  "ты", "вы", "он", "она", "они", "the", "a", "an", "and", "or", "but", "to",
  "of", "in", "on", "for", "with", "by", "from", "at", "is", "are", "be"
]);

const SYNONYMS = {
  отпуск: ["vacation", "pto", "leave", "отпуска", "отпусков"],
  онбординг: ["onboarding", "адаптация", "адаптации"],
  зарплата: ["salary", "compensation", "pay", "оклад"],
  бонус: ["bonus", "bonuses", "премия", "премии"],
  увольнение: ["termination", "offboarding", "exit"],
  грейд: ["grade", "level", "seniority"],
  разработчик: ["developer", "engineer", "dev"],
  фронтенд: ["frontend", "front-end", "fe"],
  бэкенд: ["backend", "back-end", "be"],
  hr: ["human", "recruiting", "people"],
  kpi: ["okr", "metric", "metrics", "цель", "цели"]
};

function escapeMrkdwn(text = "") {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalize(text = "") {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text = "") {
  return normalize(text)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function unique(arr) {
  return [...new Set(arr)];
}

function expandTokens(tokens = []) {
  const out = [...tokens];
  for (const token of tokens) {
    if (SYNONYMS[token]) out.push(...SYNONYMS[token]);
  }
  return unique(out.map(normalize).filter(Boolean));
}

function extractQuotedPhrases(query = "") {
  const matches = [...query.matchAll(/"([^"]+)"/g)].map((m) => normalize(m[1]));
  return matches.filter(Boolean);
}

function extractRichTextPlain(richText = []) {
  return richText.map((item) => item.plain_text || "").join("").trim();
}

function getRichTextArray(block, typeName) {
  const typed = block[typeName] || {};
  return typed.rich_text || typed.text || [];
}

function buildSearchFields(chunk) {
  const normTitle = normalize(chunk.pageTitle || "");
  const normSection = normalize(chunk.sectionPath || "");
  const normText = normalize(chunk.text || "");

  return {
    ...chunk,
    _normTitle: normTitle,
    _normSection: normSection,
    _normText: normText,
    _tokenBag: unique([
      ...tokenize(chunk.pageTitle || ""),
      ...tokenize(chunk.sectionPath || ""),
      ...tokenize(chunk.text || "")
    ])
  };
}

function hydrateChunk(chunk) {
  if (chunk && chunk._normText && Array.isArray(chunk._tokenBag)) return chunk;
  return buildSearchFields(chunk);
}

function levenshtein(a = "", b = "", maxDistance = 2) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let minInRow = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < minInRow) minInRow = curr[j];
    }
    if (minInRow > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function normalizeNotionId(input = "") {
  const value = String(input).trim();
  if (!value) return "";

  let candidate = value;
  try {
    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
      const url = new URL(candidate);
      const parts = url.pathname.split("/").filter(Boolean);
      candidate = parts[parts.length - 1] || "";
    }
  } catch (_) {}

  candidate = candidate.split("?")[0].split("#")[0];

  const dashed = candidate.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (dashed) return dashed[0].replace(/-/g, "").toLowerCase();

  const plainAtEnd = candidate.match(/([0-9a-fA-F]{32})$/);
  if (plainAtEnd) return plainAtEnd[1].toLowerCase();

  const anyPlain = candidate.match(/[0-9a-fA-F]{32}/);
  if (anyPlain) return anyPlain[0].toLowerCase();

  throw new Error(`Cannot parse Notion ID from: ${input}`);
}

async function loadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function saveJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

module.exports = {
  STOPWORDS,
  SYNONYMS,
  escapeMrkdwn,
  normalize,
  tokenize,
  unique,
  expandTokens,
  extractQuotedPhrases,
  extractRichTextPlain,
  getRichTextArray,
  buildSearchFields,
  hydrateChunk,
  levenshtein,
  normalizeNotionId,
  loadJson,
  saveJsonAtomic
};
