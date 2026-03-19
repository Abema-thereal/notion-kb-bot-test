require("dotenv").config();
const { App, LogLevel } = require("@slack/bolt");
const config = require("./src/config");
const { loadIndexFromDisk, syncIndex } = require("./src/notion-indexer");
const { registerHandlers } = require("./src/handlers");

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  signingSecret: config.slackSigningSecret,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

registerHandlers(app);

(async () => {
  await loadIndexFromDisk();
  await app.start();

  console.log("⚡️ Slack bot is running in Socket Mode");

  const timer = setInterval(() => {
    syncIndex().catch((error) => {
      console.error("Scheduled sync failed:", error.message);
    });
  }, config.indexRefreshMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
})();
