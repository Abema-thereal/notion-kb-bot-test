# Notion KB Bot (final no-Notion-access version)

Slack bot on Bolt JS that searches a role-filtered Notion index and returns:
- a short summary for the best match
- **3 results max**
- a link to each Notion page
- the **full fetched text** of each matching page under the link

## Main behavior
- access is determined by Slack title first
- if Slack title is unusable, the bot falls back to `job_titles.xlsx`
- page-level overrides are configured in `data/access-map.json` inside `pageScopeOverrides`
- indexing runs weekly and **does not** run automatically on startup
- users **cannot** trigger reindex from Slack

## Important
Users may lose Notion access completely. This version is designed for that scenario: it returns the page text in Slack, not just a link.

## Quick start
1. Copy `.env.example` to `.env`
2. Fill in Slack and Notion tokens
3. Make sure `job_titles.xlsx` is in the project root
4. Check `data/access-map.json`
5. Install dependencies:
   ```bash
   npm install
   ```
6. Build the index:
   ```bash
   node scripts/reindex-local.js
   ```
7. Start the bot:
   ```bash
   node index.js
   ```

## How to make one page public even if it lives inside HR
Open `data/access-map.json` and add the page id to `pageScopeOverrides`.

Example:
```json
"pageScopeOverrides": {
  "1234567890abcdef1234567890abcdef": ["public"],
  "abcdefabcdefabcdefabcdefabcdefab": ["public", "office"]
}
```

## Useful commands
```bash
node scripts/reindex-local.js
node scripts/check-user-scope.js U12345678
node scripts/discover-roots.js
```


## Скрытие полного текста в Slack

У Slack нет нативного "спойлера" для сообщений, но в этой версии бот прячет полный текст за кнопкой **«Показать полный текст»**.
После нажатия бот открывает модальное окно Slack с полным текстом страницы. Это работает через Block Kit interactivity и Socket Mode, без публичного Request URL.

Важно:
- в Slack app должна быть включена **Interactivity & Shortcuts**
- для Socket Mode Request URL не нужен
- в основном сообщении бот показывает только summary и 3 результата
- полный текст открывается по кнопке
