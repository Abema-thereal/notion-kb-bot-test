const config = require("./config");
const {
  normalize,
  tokenize,
  expandTokens,
  extractQuotedPhrases,
  escapeMrkdwn,
  levenshtein,
  unique,
} = require("./utils");

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = haystack.match(new RegExp(escaped, "g"));
  return matches ? matches.length : 0;
}

function fuzzyMatchToken(queryToken, tokenBag) {
  if (!queryToken || !tokenBag?.length) return false;

  const maxDistance = queryToken.length >= 8 ? 2 : 1;

  for (const token of tokenBag) {
    if (token === queryToken) return true;
    if (token.startsWith(queryToken) || queryToken.startsWith(token)) return true;
    if (Math.abs(token.length - queryToken.length) > maxDistance) continue;
    if (levenshtein(queryToken, token, maxDistance) <= maxDistance) return true;
  }

  return false;
}

function makeSnippet(text, queryTokens) {
  const raw = (text || "").replace(/\s+/g, " ").trim();
  if (raw.length <= config.maxSnippetLength) return raw;

  const lowerRaw = raw.toLowerCase();
  let pos = -1;

  for (const token of queryTokens) {
    pos = lowerRaw.indexOf(token.toLowerCase());
    if (pos >= 0) break;
  }

  if (pos < 0) {
    return raw.slice(0, config.maxSnippetLength - 1) + "…";
  }

  const start = Math.max(0, pos - Math.floor(config.maxSnippetLength / 3));
  const end = Math.min(raw.length, start + config.maxSnippetLength);

  let snippet = raw.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < raw.length) snippet += "…";

  return snippet;
}

function scoreChunk(chunk, rawQuery, queryTokens, quotedPhrases) {
  const title = chunk._normTitle || "";
  const section = chunk._normSection || "";
  const text = chunk._normText || "";
  const tokenBag = chunk._tokenBag || [];

  let score = 0;
  let matched = 0;
  const wholePhrase = normalize(rawQuery);

  for (const phrase of quotedPhrases) {
    if (title.includes(phrase)) score += 80;
    if (section.includes(phrase)) score += 50;
    if (text.includes(phrase)) score += 35;
  }

  if (wholePhrase) {
    if (title.includes(wholePhrase)) score += 60;
    if (section.includes(wholePhrase)) score += 30;
    if (text.includes(wholePhrase)) score += 20;
  }

  for (const token of queryTokens) {
    let tokenScore = 0;

    if (title.includes(token)) tokenScore += 14;
    else if (fuzzyMatchToken(token, tokenBag)) tokenScore += 7;

    if (section.includes(token)) tokenScore += 8;

    const occurrences = countOccurrences(text, token);
    if (occurrences > 0) tokenScore += Math.min(occurrences, 5) * 3;
    else if (fuzzyMatchToken(token, tokenBag)) tokenScore += 4;

    if (tokenScore > 0) matched += 1;
    score += tokenScore;
  }

  if (queryTokens.length > 0 && matched === queryTokens.length) score += 20;
  if (queryTokens.length > 1 && matched >= Math.ceil(queryTokens.length * 0.7)) score += 8;
  if ((chunk.text || "").length < 500) score += 2;

  return score;
}

function searchChunks(chunks, query) {
  const baseTokens = tokenize(query);
  const queryTokens = unique(expandTokens(baseTokens));
  const quotedPhrases = extractQuotedPhrases(query);

  if (!queryTokens.length && !quotedPhrases.length) return [];

  const scored = [];
  for (const chunk of chunks) {
    const score = scoreChunk(chunk, query, queryTokens, quotedPhrases);
    if (score > 0) {
      scored.push({
        ...chunk,
        score,
        snippet: makeSnippet(chunk.text, queryTokens),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const byPage = new Map();
  for (const item of scored) {
    const key = item.pageId;
    if (!byPage.has(key) || (item.score || 0) > (byPage.get(key).score || 0)) {
      byPage.set(key, item);
    }
  }

  return [...byPage.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, config.maxResults);
}

function formatResults(results) {
  const lines = [`*Нашёл ${results.length} совпадение(я):*`, ""];

  results.forEach((item, index) => {
    const title = escapeMrkdwn(item.pageTitle);
    const section = item.sectionPath ? `\n_Раздел:_ ${escapeMrkdwn(item.sectionPath)}` : "";
    const snippet = escapeMrkdwn(item.snippet);

    lines.push(`*${index + 1}. <${item.pageUrl}|${title}>*${section}`);
    lines.push(`>${snippet}`);
    lines.push("");
  });

  return lines.join("\n");
}

module.exports = {
  searchChunks,
  formatResults,
};
