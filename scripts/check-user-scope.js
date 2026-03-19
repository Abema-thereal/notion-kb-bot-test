require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { getUserProfile } = require("../src/slack-profile");
const { resolveUserAccess } = require("../src/title-resolver");
const { getAllowedRootKeys } = require("../src/access-control");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

(async () => {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: node scripts/check-user-scope.js U12345678");
    process.exit(1);
  }

  const profile = await getUserProfile(slack, userId);
  const access = await resolveUserAccess(profile);
  const rootKeys = await getAllowedRootKeys(access.scopes);

  console.log(JSON.stringify({
    userId,
    profile,
    access,
    rootKeys,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
