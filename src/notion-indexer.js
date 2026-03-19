const { Client } = require("@notionhq/client");
const config = require("./config");
const {
  extractRichTextPlain,
  getRichTextArray,
  buildSearchFields,
  hydrateChunk,
  loadJson,
  saveJsonAtomic,
  normalize,
  normalizeNotionId,
  tokenize,
  extractQuotedPhrases
} = require("./utils");
const { getAccessMap } = require("./access-control");

const notion = new Client({ auth: config.notionApiKey });

const state = {
  roots: [],
  chunks: [],
  lastSavedAt: 0,
  lastSyncAt: 0,
  syncPromise: null,
  livePageCache: new Map()
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const status = error?.status || error?.statusCode;
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();

  return [429, 500, 502, 503, 504].includes(status)
    || code.includes("timeout")
    || message.includes("status: 429")
    || message.includes("status: 500")
    || message.includes("status: 502")
    || message.includes("status: 503")
    || message.includes("status: 504")
    || message.includes("bad gateway")
    || message.includes("gateway timeout")
    || message.includes("request timeout")
    || message.includes("decryption failed")
    || message.includes("ssl")
    || message.includes("rate limited");
}

async function withRetry(fn, label, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts) throw error;
      const delay = attempt === 1 ? 600 : attempt === 2 ? 1500 : attempt === 3 ? 3000 : 5000;
      console.warn(`${label} failed, retry ${attempt}/${maxAttempts} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        results[current] = { __error: error };
      }
    }
  }

  const workers = [];
  const safeLimit = Math.max(1, Math.min(limit || 1, items.length || 1));
  for (let i = 0; i < safeLimit; i++) workers.push(run());
  await Promise.all(workers);
  return results;
}

function getRootMode(root) {
  if (root.indexMode) return root.indexMode;
  if (root.type === "database") return "metadata";
  return "content";
}

function getRootConcurrency(root) {
  const value = Number(root?.concurrency);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  if (root.type === "database") return 2;
  return 1;
}

function getMaxTopLevelBlocks(root) {
  const value = Number(root?.maxTopLevelBlocks);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return 200;
}

function getPageTitle(page) {
  const properties = page.properties || {};
  for (const value of Object.values(properties)) {
    if (value && value.type === "title") {
      const title = (value.title || []).map((t) => t.plain_text || "").join("").trim();
      if (title) return title;
    }
  }
  return `Untitled (${page.id})`;
}

function getBlockText(block) {
  switch (block.type) {
    case "paragraph":
      return extractRichTextPlain(getRichTextArray(block, "paragraph"));
    case "heading_1":
      return extractRichTextPlain(getRichTextArray(block, "heading_1"));
    case "heading_2":
      return extractRichTextPlain(getRichTextArray(block, "heading_2"));
    case "heading_3":
      return extractRichTextPlain(getRichTextArray(block, "heading_3"));
    case "bulleted_list_item":
      return extractRichTextPlain(getRichTextArray(block, "bulleted_list_item"));
    case "numbered_list_item":
      return extractRichTextPlain(getRichTextArray(block, "numbered_list_item"));
    case "to_do":
      return extractRichTextPlain(getRichTextArray(block, "to_do"));
    case "toggle":
      return extractRichTextPlain(getRichTextArray(block, "toggle"));
    case "quote":
      return extractRichTextPlain(getRichTextArray(block, "quote"));
    case "callout":
      return extractRichTextPlain(getRichTextArray(block, "callout"));
    case "code":
      return extractRichTextPlain(getRichTextArray(block, "code"));
    case "table_row": {
      const cells = block.table_row?.cells || [];
      return cells.flat().map((cell) => cell.plain_text || "").join(" | ").trim();
    }
    case "child_page":
      return block.child_page?.title || "";
    default:
      return "";
  }
}

function isHeadingBlock(block) {
  return block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3";
}

function headingLevel(block) {
  if (block.type === "heading_1") return 1;
  if (block.type === "heading_2") return 2;
  if (block.type === "heading_3") return 3;
  return 0;
}

function updateHeadingTrail(headings, level, text) {
  const next = [...headings];
  next[level - 1] = text;
  next.length = level;
  return next;
}

function chunkFromText(root, pageMeta, blockId, blockType, sectionPath, text) {
  return buildSearchFields({
    rootKey: root.key,
    rootTitle: root.title,
    allowedScopes: root.allowedScopes || [],
    pageId: pageMeta.pageId,
    pageTitle: pageMeta.pageTitle,
    pageUrl: pageMeta.pageUrl,
    lastEditedTime: pageMeta.lastEditedTime,
    blockId,
    blockType,
    sectionPath: sectionPath || "",
    text
  });
}

function dedupeChunks(chunks) {
  const uniqueChunks = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const key = `${chunk.rootKey}::${chunk.pageId}::${chunk.blockId}::${chunk.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueChunks.push(chunk);
    }
  }
  return uniqueChunks;
}

function getRootChunks(rootKey) {
  return state.chunks.filter((chunk) => chunk.rootKey === rootKey);
}

function replaceChunksForPages(rootKey, nextPageChunks, pageIdsToReplace) {
  const pageIds = new Set((pageIdsToReplace || []).map((x) => normalizeNotionId(x)));
  const kept = state.chunks.filter(
    (chunk) => !(chunk.rootKey === rootKey && pageIds.has(normalizeNotionId(chunk.pageId)))
  );
  return kept.concat(nextPageChunks);
}

async function listBlockChildrenPage(blockId, startCursor = undefined, pageSize = 100) {
  const cleanId = normalizeNotionId(blockId);
  return withRetry(
    () => notion.blocks.children.list({ block_id: cleanId, start_cursor: startCursor, page_size: pageSize }),
    `blocks.children.list(${cleanId})`
  );
}

async function listAllBlockChildren(blockId) {
  const cleanId = normalizeNotionId(blockId);
  let results = [];
  let cursor = undefined;
  do {
    const response = await listBlockChildrenPage(cleanId, cursor, 100);
    results = results.concat(response.results || []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function listSomeTopLevelChildren(blockId, maxItems = 200) {
  const cleanId = normalizeNotionId(blockId);
  let results = [];
  let cursor = undefined;
  while (results.length < maxItems) {
    const pageSize = Math.min(100, maxItems - results.length);
    const response = await listBlockChildrenPage(cleanId, cursor, pageSize);
    results = results.concat(response.results || []);
    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }
  return results;
}

async function retrievePageMeta(pageId, fallbackTitle = "") {
  const cleanId = normalizeNotionId(pageId);
  try {
    const page = await withRetry(
      () => notion.pages.retrieve({ page_id: cleanId }),
      `pages.retrieve(${cleanId})`
    );
    return {
      pageId: cleanId,
      pageTitle: getPageTitle(page) || fallbackTitle || `Untitled (${cleanId})`,
      pageUrl: page.url || "",
      lastEditedTime: page.last_edited_time || null
    };
  } catch (_) {
    return {
      pageId: cleanId,
      pageTitle: fallbackTitle || `Untitled (${cleanId})`,
      pageUrl: "",
      lastEditedTime: null
    };
  }
}

async function retrieveDatabase(databaseId) {
  const cleanId = normalizeNotionId(databaseId);
  return withRetry(
    () => notion.databases.retrieve({ database_id: cleanId }),
    `databases.retrieve(${cleanId})`
  );
}

async function queryAllDatabasePages(databaseId, options = {}) {
  const cleanId = normalizeNotionId(databaseId);
  let results = [];
  let cursor = undefined;
  const filter = options.editedAfter
    ? { timestamp: "last_edited_time", last_edited_time: { on_or_after: options.editedAfter } }
    : undefined;

  do {
    const response = await withRetry(
      () => notion.databases.query({ database_id: cleanId, start_cursor: cursor, page_size: 100, ...(filter ? { filter } : {}) }),
      `databases.query(${cleanId})`
    );
    results = results.concat((response.results || []).filter((item) => item.object === "page"));
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function walkBlocks(blocks, root, pageMeta, headings, chunks) {
  let currentHeadings = [...headings];

  for (const block of blocks) {
    const text = getBlockText(block);

    if (isHeadingBlock(block) && text) {
      currentHeadings = updateHeadingTrail(currentHeadings, headingLevel(block), text);
    }

    const cleanText = (text || "").replace(/\s+/g, " ").trim();

    if (block.type === "child_page") {
      const childTitle = block.child_page?.title || cleanText;
      if (childTitle) {
        chunks.push(chunkFromText(root, pageMeta, `child-page-title:${block.id}`, "child_page_title", currentHeadings.join(" > "), childTitle));
      }
      if (root.skipChildPages) continue;
      try {
        const childMeta = await retrievePageMeta(block.id, childTitle || "");
        const childBlocks = await listAllBlockChildren(block.id);
        await walkBlocks(childBlocks, root, childMeta, [], chunks);
      } catch (error) {
        console.error(`Cannot read child page ${block.id}:`, error.message);
      }
      continue;
    }

    if (cleanText) {
      chunks.push(chunkFromText(root, pageMeta, block.id, block.type, currentHeadings.join(" > "), cleanText));
    }

    if (root.indexMode === "shallow") continue;

    if (block.has_children) {
      try {
        const children = await listAllBlockChildren(block.id);
        await walkBlocks(children, root, pageMeta, currentHeadings, chunks);
      } catch (error) {
        console.error(`Cannot read children for block ${block.id}:`, error.message);
      }
    }
  }
}

async function indexSinglePage(root, pageId, fallbackTitle = "") {
  const cleanId = normalizeNotionId(pageId);
  const pageMeta = await retrievePageMeta(cleanId, fallbackTitle);
  const chunks = [];

  if (root.indexMode === "shallow") {
    const topBlocks = await listSomeTopLevelChildren(cleanId, getMaxTopLevelBlocks(root));
    await walkBlocks(topBlocks, root, pageMeta, [], chunks);
  } else {
    const topBlocks = await listAllBlockChildren(cleanId);
    await walkBlocks(topBlocks, root, pageMeta, [], chunks);
  }

  return {
    pageId: cleanId,
    chunks: dedupeChunks(chunks),
    pageMeta
  };
}

function extractPlainTextFromPropertyValue(value) {
  if (!value || !value.type) return "";

  switch (value.type) {
    case "title":
      return (value.title || []).map((x) => x.plain_text || "").join(" ").trim();
    case "rich_text":
      return (value.rich_text || []).map((x) => x.plain_text || "").join(" ").trim();
    case "select":
      return value.select?.name || "";
    case "multi_select":
      return (value.multi_select || []).map((x) => x.name || "").join(" ").trim();
    case "status":
      return value.status?.name || "";
    case "people":
      return (value.people || []).map((x) => x.name || x.person?.email || "").filter(Boolean).join(" ").trim();
    case "relation":
      return (value.relation || []).map((x) => x.id || "").filter(Boolean).join(" ").trim();
    case "date":
      return [value.date?.start || "", value.date?.end || ""].filter(Boolean).join(" ").trim();
    case "checkbox":
      return value.checkbox ? "true yes checked" : "false no unchecked";
    case "number":
      return value.number !== null && value.number !== undefined ? String(value.number) : "";
    case "url":
      return value.url || "";
    case "email":
      return value.email || "";
    case "phone_number":
      return value.phone_number || "";
    default:
      return "";
  }
}

function buildDatabaseRowMetadataText(row, root) {
  const props = row.properties || {};
  const parts = [];
  const allowedPropertyNames = Array.isArray(root.metadataProperties) && root.metadataProperties.length
    ? new Set(root.metadataProperties)
    : null;

  for (const [propName, propValue] of Object.entries(props)) {
    if (allowedPropertyNames && !allowedPropertyNames.has(propName)) continue;
    const text = extractPlainTextFromPropertyValue(propValue);
    if (text) parts.push(`${propName}: ${text}`);
  }

  return parts.join(" • ").trim();
}

function makeMetadataChunk(root, row) {
  const pageId = normalizeNotionId(row.id);
  const pageTitle = getPageTitle(row);
  const metadataText = buildDatabaseRowMetadataText(row, root);

  return buildSearchFields({
    rootKey: root.key,
    rootTitle: root.title,
    allowedScopes: root.allowedScopes || [],
    pageId,
    pageTitle,
    pageUrl: row.url || "",
    lastEditedTime: row.last_edited_time || null,
    blockId: `meta:${pageId}`,
    blockType: "database_row_metadata",
    sectionPath: "",
    text: [pageTitle, metadataText].filter(Boolean).join(" • ")
  });
}

async function indexDatabaseMetadataRoot(root) {
  const databaseId = normalizeNotionId(root.id);
  await retrieveDatabase(databaseId);
  const rows = await queryAllDatabasePages(databaseId);
  const chunks = [];
  for (const row of rows) {
    try {
      chunks.push(makeMetadataChunk(root, row));
    } catch (error) {
      console.error(`Cannot index database row metadata ${row.id}:`, error.message);
    }
  }
  return { chunks: dedupeChunks(chunks), rowCount: rows.length };
}

async function indexDatabaseContentRoot(root, previousRootMeta) {
  const databaseId = normalizeNotionId(root.id);
  await retrieveDatabase(databaseId);

  const editedAfter = previousRootMeta?.lastIndexedAt && !root.forceFullReindex
    ? previousRootMeta.lastIndexedAt
    : null;
  const rows = await queryAllDatabasePages(databaseId, editedAfter ? { editedAfter } : {});
  const concurrency = getRootConcurrency(root);

  if (editedAfter && rows.length === 0) {
    return {
      chunks: getRootChunks(root.key),
      rowCount: previousRootMeta?.rowCount || 0,
      updatedRows: 0,
      mode: "incremental-noop"
    };
  }

  const results = await mapWithConcurrency(rows, concurrency, async (row) => {
    const pageId = normalizeNotionId(row.id);
    const result = await indexSinglePage(root, pageId, getPageTitle(row));
    return { pageId, chunks: result.chunks };
  });

  const successful = [];
  const changedPageIds = [];
  for (const result of results) {
    if (!result) continue;
    if (result.__error) {
      console.error(`Cannot index one database row in root "${root.title}":`, result.__error.message);
      continue;
    }
    successful.push(...result.chunks);
    changedPageIds.push(result.pageId);
  }

  if (editedAfter) {
    const nextChunks = replaceChunksForPages(root.key, successful, changedPageIds)
      .filter((chunk) => chunk.rootKey === root.key);
    return {
      chunks: dedupeChunks(nextChunks),
      rowCount: previousRootMeta?.rowCount || 0,
      updatedRows: changedPageIds.length,
      mode: "incremental"
    };
  }

  return {
    chunks: dedupeChunks(successful),
    rowCount: rows.length,
    updatedRows: rows.length,
    mode: "full"
  };
}

async function indexPageRoot(root) {
  const result = await indexSinglePage(root, root.id, root.title);
  return { chunks: result.chunks };
}

async function loadIndexFromDisk() {
  const data = await loadJson(config.indexFile, null);
  if (!data) {
    console.log("Index file not found, starting with empty index");
    return;
  }

  state.roots = Array.isArray(data.roots) ? data.roots : [];
  state.chunks = Array.isArray(data.chunks) ? data.chunks.map(hydrateChunk) : [];
  state.lastSavedAt = data.savedAt ? new Date(data.savedAt).getTime() : 0;
  state.lastSyncAt = data.lastSyncAt ? new Date(data.lastSyncAt).getTime() : 0;

  console.log(`Loaded index: ${state.roots.length} roots, ${state.chunks.length} chunks`);
}

async function saveIndexToDisk() {
  const payload = {
    version: 8,
    savedAt: new Date().toISOString(),
    lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
    roots: state.roots,
    chunks: state.chunks
  };

  await saveJsonAtomic(config.indexFile, payload);
  state.lastSavedAt = Date.now();
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = haystack.match(new RegExp(escaped, "g"));
  return matches ? matches.length : 0;
}

function makeLiveSnippet(text, queryTokens, quotedPhrases, maxLen = config.maxSnippetLength || 320) {
  const raw = (text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const lowerRaw = raw.toLowerCase();
  let pos = -1;
  for (const phrase of quotedPhrases || []) {
    pos = lowerRaw.indexOf(phrase.toLowerCase());
    if (pos >= 0) break;
  }
  if (pos < 0) {
    for (const token of queryTokens || []) {
      pos = lowerRaw.indexOf(token.toLowerCase());
      if (pos >= 0) break;
    }
  }

  if (pos < 0) return raw.length <= maxLen ? raw : raw.slice(0, maxLen - 1) + "…";

  const start = Math.max(0, pos - Math.floor(maxLen / 3));
  const end = Math.min(raw.length, start + maxLen);
  let snippet = raw.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < raw.length) snippet += "…";
  return snippet;
}

function scoreLiveText(text, query) {
  const tokens = tokenize(query || "");
  const phrases = extractQuotedPhrases(query || "");
  const normText = normalize(text || "");
  let score = 0;
  let matched = 0;

  for (const phrase of phrases) if (normText.includes(phrase)) score += 20;
  for (const token of tokens) {
    const hits = countOccurrences(normText, token);
    if (hits > 0) {
      matched += 1;
      score += Math.min(hits, 6) * 4;
    }
  }
  if (tokens.length > 0 && matched === tokens.length) score += 12;
  if (tokens.length > 1 && matched >= Math.ceil(tokens.length * 0.7)) score += 6;

  return { score, tokens, phrases };
}

async function collectLivePageText(pageId, options = {}, depth = 0, collected = [], visited = new Set()) {
  const cleanId = normalizeNotionId(pageId);
  const maxBlocks = options.maxBlocks || 240;
  const maxDepth = options.maxDepth || 2;

  if (visited.has(cleanId)) return collected;
  visited.add(cleanId);
  if (collected.length >= maxBlocks) return collected;

  const pageSize = Math.min(100, maxBlocks - collected.length);
  const children = await listBlockChildrenPage(cleanId, undefined, pageSize);

  for (const block of children.results || []) {
    if (collected.length >= maxBlocks) break;
    const text = getBlockText(block).replace(/\s+/g, " ").trim();
    if (text) collected.push(text);
    if (block.type === "child_page") continue;
    if (block.has_children && depth < maxDepth) {
      await collectLivePageText(block.id, options, depth + 1, collected, visited);
    }
  }

  return collected;
}

async function getLivePageText(pageId, options = {}) {
  const cleanId = normalizeNotionId(pageId);
  const maxBlocks = Number(options.maxBlocks || 260);
  const maxDepth = Number(options.maxDepth || 2);
  const cacheKey = `${cleanId}::${maxBlocks}::${maxDepth}`;

  if (state.livePageCache.has(cacheKey)) {
    return state.livePageCache.get(cacheKey);
  }

  const promise = (async () => {
    const parts = await collectLivePageText(cleanId, { maxBlocks, maxDepth });
    return parts.join("\n").trim();  })();

  state.livePageCache.set(cacheKey, promise);
  try {
    const value = await promise;
    state.livePageCache.set(cacheKey, Promise.resolve(value));
    return value;
  } catch (error) {
    state.livePageCache.delete(cacheKey);
    throw error;
  }
}

async function hydrateResultsWithLiveContent(results, query, maxItems = 3) {
  const items = Array.isArray(results) ? results : [];
  if (!items.length) return items;

  const uniquePageIds = [];
  const seen = new Set();
  for (const item of items) {
    const pageId = normalizeNotionId(item.pageId);
    if (!seen.has(pageId)) {
      seen.add(pageId);
      uniquePageIds.push(pageId);
    }
    if (uniquePageIds.length >= maxItems) break;
  }

  const fetched = await mapWithConcurrency(uniquePageIds, 2, async (pageId) => {
    const liveText = await getLivePageText(pageId);
    const liveScore = scoreLiveText(liveText, query);
    return { pageId, liveText, liveScore };
  });

  const liveByPageId = new Map();
  for (const item of fetched) {
    if (!item || item.__error) continue;
    liveByPageId.set(item.pageId, item);
  }

  const enriched = items.map((item) => {
    const pageId = normalizeNotionId(item.pageId);
    const live = liveByPageId.get(pageId);
    if (!live || live.liveScore.score <= 0 || !live.liveText) return item;

    return {
      ...item,
      snippet: makeLiveSnippet(live.liveText, live.liveScore.tokens, live.liveScore.phrases),
      score: (item.score || 0) + Math.min(live.liveScore.score, 40),
      liveBoost: true
    };
  });

  enriched.sort((a, b) => (b.score || 0) - (a.score || 0));
  return enriched;
}

async function syncIndex() {
  if (state.syncPromise) return state.syncPromise;

  state.syncPromise = (async () => {
    const accessMap = await getAccessMap();
    const enabledRoots = (accessMap.roots || []).filter(
      (root) => root.enabled && root.id && (root.type === "page" || root.type === "database")
    );

    const previousRootMetaByKey = new Map((state.roots || []).map((root) => [root.key, root]));
    const nextChunks = [];
    const nextRoots = [];

    for (const root of enabledRoots) {
      try {
        console.log(`Indexing root: ${root.title}`);
        const normalizedRoot = { ...root, id: normalizeNotionId(root.id) };
        const previousRootMeta = previousRootMetaByKey.get(normalizedRoot.key) || null;
        const rootMode = getRootMode(normalizedRoot);

        let result;
        if (normalizedRoot.type === "database" && rootMode === "metadata") {
          result = await indexDatabaseMetadataRoot(normalizedRoot);
        } else if (normalizedRoot.type === "database") {
          result = await indexDatabaseContentRoot(normalizedRoot, previousRootMeta);
        } else {
          result = await indexPageRoot({ ...normalizedRoot, indexMode: rootMode });
        }

        const rootChunks = result.chunks || [];
        nextChunks.push(...rootChunks);
        nextRoots.push({
          key: normalizedRoot.key,
          title: normalizedRoot.title,
          type: normalizedRoot.type,
          id: normalizedRoot.id,
          allowedScopes: normalizedRoot.allowedScopes || [],
          indexMode: rootMode,
          skipChildPages: !!normalizedRoot.skipChildPages,
          maxTopLevelBlocks: getMaxTopLevelBlocks(normalizedRoot),
          chunkCount: rootChunks.length,
          rowCount: result.rowCount || 0,
          updatedRows: result.updatedRows || 0,
          lastIndexedAt: new Date().toISOString(),
          concurrency: getRootConcurrency(normalizedRoot),
          lastRunMode: result.mode || "full"
        });
      } catch (error) {
        console.error(`Failed to index root "${root.title}":`, error.message);
        const previousRootMeta = previousRootMetaByKey.get(root.key);
        const previousChunks = getRootChunks(root.key);
        if (previousRootMeta && previousChunks.length > 0) {
          console.warn(`Keeping previous index for root "${root.title}"`);
          nextRoots.push(previousRootMeta);
          nextChunks.push(...previousChunks);
        }
      }
    }

    state.roots = nextRoots;
    state.chunks = dedupeChunks(nextChunks);
    state.lastSyncAt = Date.now();
    state.livePageCache.clear();
    await saveIndexToDisk();

    return { indexedRoots: nextRoots.length, totalChunks: state.chunks.length };
  })().finally(() => {
    state.syncPromise = null;
  });

  return state.syncPromise;
}

async function searchPageCandidatesByTitle(title) {
  const response = await withRetry(
    () => notion.search({ query: title, filter: { property: "object", value: "page" }, page_size: 10 }),
    `search("${title}")`
  );

  return (response.results || []).map((page) => ({
    id: page.id,
    title: getPageTitle(page),
    url: page.url,
    lastEditedTime: page.last_edited_time,
    scoreExact: normalize(getPageTitle(page)) === normalize(title)
  }));
}

function getState() {
  return state;
}

module.exports = {
  loadIndexFromDisk,
  saveIndexToDisk,
  syncIndex,
  getState,
  searchPageCandidatesByTitle,
  hydrateResultsWithLiveContent,
  getLivePageText
};
