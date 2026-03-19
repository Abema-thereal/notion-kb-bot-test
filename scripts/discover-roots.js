require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { searchPageCandidatesByTitle } = require("../src/notion-indexer");
const config = require("../src/config");

(async () => {
  const raw = await fs.readFile(config.accessMapFile, "utf8");
  const accessMap = JSON.parse(raw);

  for (const root of accessMap.roots || []) {
    if (root.id) continue;

    console.log(`\n=== ${root.title} ===`);
    const candidates = await searchPageCandidatesByTitle(root.title);

    if (!candidates.length) {
      console.log("No candidates found");
      continue;
    }

    for (const candidate of candidates) {
      console.log(JSON.stringify(candidate, null, 2));
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
