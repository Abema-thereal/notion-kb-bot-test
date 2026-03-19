const path = require("path");

module.exports = {
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackAppToken: process.env.SLACK_APP_TOKEN,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
  notionApiKey: process.env.NOTION_API_KEY,

  indexFile:
    process.env.INDEX_FILE || path.join(__dirname, "..", "data", "notion-index.json"),
  accessMapFile: path.join(__dirname, "..", "data", "access-map.json"),
  titleMapFile: path.join(__dirname, "..", "data", "title-map.json"),
  employeeDirectoryFile:
    process.env.EMPLOYEE_DIRECTORY_FILE || path.join(__dirname, "..", "job_titles.xlsx"),

  indexRefreshMs: Number(process.env.INDEX_REFRESH_MS || 604800000),
  maxResults: Number(process.env.MAX_RESULTS || 3),
  maxSnippetLength: Number(process.env.MAX_SNIPPET_LENGTH || 320),
  profileCacheMs: Number(process.env.PROFILE_CACHE_MS || 86400000),
};
