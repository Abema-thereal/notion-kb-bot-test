require("dotenv").config();
const { syncIndex, loadIndexFromDisk } = require("../src/notion-indexer");

(async () => {
  await loadIndexFromDisk();
  const result = await syncIndex();
  console.log("Reindex complete:");
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
