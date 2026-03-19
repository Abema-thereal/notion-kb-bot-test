const { getUserProfile } = require("./slack-profile");
const { resolveUserAccess } = require("./title-resolver");
const { filterChunksByScopes } = require("./access-control");
const { getState, hydrateResultsWithLiveContent, getLivePageText } = require("./notion-indexer");
const { searchChunks } = require("./search");

const ACTION_PATTERNS = [
  "подай", "подать", "заполни", "заполнить", "создай", "создать", "оформи", "оформить",
  "согласуй", "согласовать", "открой", "открыть", "нажми", "нажать", "выбери", "выбрать",
  "укажи", "указать", "добавь", "добавить", "проверь", "проверить", "уведомь", "уведомить",
  "отправь", "отправить", "внеси", "внести", "отметь", "отметить", "прикрепи", "прикрепить",
  "submit", "fill", "open", "click", "choose", "select", "send", "approve", "request", "apply"
];

function formatHelp() {
  return [
    "*Как мной пользоваться*",
    "• Напиши мне вопрос или ключевые слова",
    "• Можно искать точную фразу: `\"испытательный срок\"`",
    "• `status` — показать статус индекса",
    "• `help` — показать эту подсказку"
  ].join("\n");
}

function formatStatus() {
  const state = getState();
  const savedAt = state.lastSavedAt ? new Date(state.lastSavedAt).toLocaleString("ru-RU") : "ещё не сохранялся";
  const syncedAt = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString("ru-RU") : "ещё не синхронизировался";

  return [
    "*Статус бота*",
    `• Корней в индексе: ${state.roots.length}`,
    `• Фрагментов в индексе: ${state.chunks.length}`,
    `• Последнее сохранение: ${savedAt}`,
    `• Последняя синхронизация: ${syncedAt}`
  ].join("\n");
}

function normalizeSimple(text = "") {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/\s+/g, " ").trim();
}

function splitIntoFragments(text = "") {
  return String(text)
    .split(/[\n•]+/g)
    .map((x) => x.trim())
    .flatMap((part) => part.split(/(?<=[.!?])\s+/g))
    .map((x) => x.trim())
    .filter(Boolean);
}

function scoreInstructionLine(line, queryTokens) {
  const norm = normalizeSimple(line);
  if (!norm || norm.length < 10) return 0;

  let score = 0;
  for (const token of queryTokens) {
    if (norm.includes(token)) score += 4;
  }
  for (const action of ACTION_PATTERNS) {
    if (norm.includes(action)) {
      score += 8;
      break;
    }
  }
  if (/^(шаг|step)\b/i.test(line)) score += 6;
  if (line.length >= 20 && line.length <= 220) score += 3;
  if (norm.includes("важно")) score += 2;
  return score;
}

function buildInstructionSummary(query, liveText = "", fallbackSnippet = "") {
  const source = [liveText, fallbackSnippet].filter(Boolean).join(" • ");
  const fragments = splitIntoFragments(source);
  const queryTokens = normalizeSimple(query).split(" ").filter(Boolean);

  const ranked = fragments
    .map((line) => ({ line, score: scoreInstructionLine(line, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const unique = [];
  const seen = new Set();
  for (const item of ranked) {
    const key = normalizeSimple(item.line);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item.line);
    if (unique.length >= 4) break;
  }

  if (!unique.length) return "";
  return ["*Кратко по самому вероятному результату:*", ...unique.map((line) => `• ${line}`)].join("\n");
}

function sanitizeText(text = "") {
  return String(text)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateForPreview(text = "", maxLen = 450) {
  const raw = sanitizeText(text).replace(/\n+/g, " ");
  if (!raw) return "";
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen - 1).trim() + "…";
}

function chunkForModal(text = "", chunkSize = 2900) {
  const clean = sanitizeText(text);
  if (!clean) return [];

  const chunks = [];
  let remaining = clean;

  while (remaining.length > chunkSize) {
    let cut = remaining.lastIndexOf("\n", chunkSize);
    if (cut < Math.floor(chunkSize * 0.5)) {
      cut = remaining.lastIndexOf(" ", chunkSize);
    }
    if (cut < Math.floor(chunkSize * 0.5)) {
      cut = chunkSize;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildResultsBlocks(results) {
  const blocks = [];
  results.slice(0, 3).forEach((item, index) => {
    const safeTitle = item.pageTitle || "Без названия";
    const safeUrl = item.pageUrl || "";
    const section = item.sectionPath ? `\n_Раздел:_ ${item.sectionPath}` : "";
    const preview = truncateForPreview(item.fullText || item.snippet || "");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${index + 1}. <${safeUrl}|${safeTitle}>*${section}${preview ? `\n${preview}` : ""}`
      }
    });

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Показать полный текст",
            emoji: true
          },
          action_id: "show_full_text_modal",
          value: JSON.stringify({
            pageId: item.pageId,
            title: safeTitle,
            pageUrl: safeUrl
          })
        }
      ]
    });
  });

  return blocks;
}

function buildMessagePayload(results, topSummary) {
  const blocks = [];

  if (topSummary) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: topSummary
      }
    });
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Нашёл ${results.length} совпадение(я):*`
    }
  });

  blocks.push(...buildResultsBlocks(results));

  return {
    text: topSummary || `Найдено ${results.length} результатов`,
    blocks
  };
}

function buildPlainTextFallback(results, topSummary) {
  const lines = [];
  if (topSummary) {
    lines.push(topSummary, "");
  }
  lines.push(`Найдено ${results.length} результатов:`, "");
  results.slice(0, 3).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.pageTitle || "Без названия"} — ${item.pageUrl || ""}`);
    if (item.snippet) lines.push(item.snippet);
    lines.push("");
  });
  return lines.join("\n").trim();
}

async function handleQuery({ client, userId, rawText }) {
  const text = (rawText || "").trim();
  if (!text) return { text: "Напиши запрос или ключевые слова." };
  if (/^(help|помощь)$/i.test(text)) return { text: formatHelp() };
  if (/^(status|статус)$/i.test(text)) return { text: formatStatus() };

  const profile = await getUserProfile(client, userId);
  const access = await resolveUserAccess(profile);
  const scopes = access.scopes;
  const state = getState();

  if (!state.chunks.length) {
    return {
      text: [
        "Индекс пока пустой.",
        "Сначала собери его локально командой `node scripts/reindex-local.js`."
      ].join("\n")
    };
  }

  const allowedChunks = await filterChunksByScopes(state.chunks, scopes);
  let results = searchChunks(allowedChunks, text).slice(0, 3);

  if (results.length) {
    try {
      results = await hydrateResultsWithLiveContent(results, text, 3);
    } catch (error) {
      console.error("Live content hydrate failed:", error.message);
    }
  }

  if (!results.length) {
    const diagnostics = [
      `Тайтл в Slack: ${profile.title || "не заполнен"}`,
      `Источник прав: ${access.source}`,
      `Области доступа: ${scopes.join(", ")}`
    ];
    if (access.matchedEmployeeName) diagnostics.push(`Сотрудник в таблице: ${access.matchedEmployeeName}`);
    if (access.matchedTitle) diagnostics.push(`Должность из таблицы: ${access.matchedTitle}`);
    if (access.matchedDepartment) diagnostics.push(`Отдел из таблицы: ${access.matchedDepartment}`);

    return { text: ["Ничего не нашёл.", "", ...diagnostics].join("\n") };
  }

  let topSummary = "";
  try {
    const liveText = await getLivePageText(results[0].pageId, { maxBlocks: 500, maxDepth: 4 });
    topSummary = buildInstructionSummary(text, liveText, results[0].snippet || "");
  } catch (error) {
    console.error("Top result live fetch failed:", error.message);
    topSummary = buildInstructionSummary(text, "", results[0].snippet || "");
  }

  const enrichedResults = [];
  for (const item of results.slice(0, 3)) {
    try {
      const fullText = await getLivePageText(item.pageId, { maxBlocks: 1200, maxDepth: 6 });
      enrichedResults.push({
        ...item,
        fullText: sanitizeText(fullText) || item.snippet || ""
      });
    } catch (error) {
      console.error(`Full text fetch failed for ${item.pageId}:`, error.message);
      enrichedResults.push({ ...item, fullText: item.snippet || "" });
    }
  }

  const payload = buildMessagePayload(enrichedResults, topSummary);
  payload.text = buildPlainTextFallback(enrichedResults, topSummary);
  return payload;
}

async function postReply(client, channel, payload, threadTs = undefined) {
  await client.chat.postMessage({
    channel,
    text: payload.text,
    blocks: payload.blocks,
    thread_ts: threadTs
  });
}

async function openLoadingModal(client, triggerId, title, pageUrl = "") {
  const blocks = [];

  if (pageUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${pageUrl}|Открыть оригинальную страницу в Notion>`
      }
    });
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "Загружаю полный текст..."
    }
  });

  return client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "full_text_modal",
      title: {
        type: "plain_text",
        text: (title || "Полный текст").slice(0, 24),
        emoji: true
      },
      close: {
        type: "plain_text",
        text: "Закрыть",
        emoji: true
      },
      blocks
    }
  });
}

async function updateFullTextModal(client, viewId, title, fullText, pageUrl = "") {
  const chunks = chunkForModal(fullText, 2900).slice(0, 90);
  const blocks = [];

  if (pageUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${pageUrl}|Открыть оригинальную страницу в Notion>`
      }
    });
    blocks.push({ type: "divider" });
  }

  if (!chunks.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Полный текст не найден."
      }
    });
  } else {
    for (const chunk of chunks) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: chunk
        }
      });
    }
  }

  await client.views.update({
    view_id: viewId,
    view: {
      type: "modal",
      callback_id: "full_text_modal",
      title: {
        type: "plain_text",
        text: (title || "Полный текст").slice(0, 24),
        emoji: true
      },
      close: {
        type: "plain_text",
        text: "Закрыть",
        emoji: true
      },
      blocks: blocks.slice(0, 100)
    }
  });
}

async function openFullTextModal({ client, triggerId, title, pageId, pageUrl = "" }) {
  const openResult = await openLoadingModal(client, triggerId, title, pageUrl);
  const viewId = openResult?.view?.id;
  if (!viewId) return;

  let fullText = "";
  try {
    fullText = await getLivePageText(pageId, { maxBlocks: 1500, maxDepth: 8 });
  } catch (error) {
    fullText = `Не удалось загрузить полный текст.\n\nОшибка: ${error.message}`;
  }

  await updateFullTextModal(client, viewId, title, fullText, pageUrl);
}

function registerHandlers(app) {
  app.action("show_full_text_modal", async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const raw = body.actions?.[0]?.value || "{}";
      const parsed = JSON.parse(raw);
      const pageId = parsed.pageId;
      const title = parsed.title || "Полный текст";
      const pageUrl = parsed.pageUrl || "";

      await openFullTextModal({
        client,
        triggerId: body.trigger_id,
        title,
        pageId,
        pageUrl
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.event("app_mention", async ({ event, client, logger }) => {
    try {
      const query = (event.text || "").replace(/<@[^>]+>/g, " ").trim();
      const answer = await handleQuery({ client, userId: event.user, rawText: query });
      await postReply(client, event.channel, answer, event.thread_ts || event.ts);
    } catch (error) {
      logger.error(error);
      await postReply(client, event.channel, { text: "Ошибка при поиске по Notion." }, event.thread_ts || event.ts);
    }
  });

  app.message(async ({ message, client, logger }) => {
    try {
      if (!message || message.subtype || message.bot_id) return;
      if (message.channel_type !== "im") return;
      if (!message.text) return;

      const answer = await handleQuery({ client, userId: message.user, rawText: message.text });
      await postReply(client, message.channel, answer);
    } catch (error) {
      logger.error(error);
      await postReply(client, message.channel, { text: "Ошибка при поиске по Notion." });
    }
  });
}

module.exports = { registerHandlers };