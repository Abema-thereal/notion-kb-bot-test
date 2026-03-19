const fs = require("fs");
const ExcelJS = require("exceljs");
const config = require("./config");
const { normalize, unique } = require("./utils");

let cachedDirectory = null;
let cachedMtimeMs = 0;
let loadingPromise = null;

const CYR_TO_LAT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya"
};

const DEPARTMENT_SCOPE_MAP = {
  "product": ["public", "product"],
  "black team": ["public", "black-team"],
  "sales": ["public", "sales"],
  "green team": ["public", "green-team"],
  "customer care": ["public", "customer-care"],
  "development": ["public", "development"],
  "content": ["public", "content"],
  "marketing": ["public", "marketing"],
  "game leads": ["public", "gameleads"],
  "gold team": ["public", "gold-team"],
  "head office": ["public", "office"],
  "hr": ["public", "hr"]
};

function transliterateCyrillic(text = "") {
  return String(text)
    .split("")
    .map((char) => CYR_TO_LAT[char.toLowerCase()] || char)
    .join("");
}

function normalizeName(text = "") {
  return normalize(
    transliterateCyrillic(String(text))
      .replace(/[_.,()"'`]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function buildNameKeys(name = "") {
  const raw = normalize(String(name));
  const latin = normalizeName(name);
  const rawTokens = raw.split(" ").filter(Boolean);
  const latinTokens = latin.split(" ").filter(Boolean);
  const keys = [];

  if (raw) keys.push(raw);
  if (latin) keys.push(latin);

  if (rawTokens.length >= 2) {
    keys.push(rawTokens.join(" "));
    keys.push([...rawTokens].reverse().join(" "));
    keys.push(`${rawTokens[0]} ${rawTokens[rawTokens.length - 1]}`);
  }

  if (latinTokens.length >= 2) {
    keys.push(latinTokens.join(" "));
    keys.push([...latinTokens].reverse().join(" "));
    keys.push(`${latinTokens[0]} ${latinTokens[latinTokens.length - 1]}`);
  }

  return unique(keys.filter(Boolean));
}

function scoreNameMatch(candidateKeys, entry) {
  let best = 0;

  for (const key of candidateKeys) {
    if (!key) continue;
    if (entry.keys.includes(key)) best = Math.max(best, 100);

    const candidateTokens = key.split(" ").filter(Boolean);
    const entryTokens = entry.normalizedLatin.split(" ").filter(Boolean);

    if (candidateTokens.length >= 2 && entryTokens.length >= 2) {
      const sameFirst = candidateTokens[0] === entryTokens[0];
      const sameLast = candidateTokens[candidateTokens.length - 1] === entryTokens[entryTokens.length - 1];
      const reverseFirst = candidateTokens[0] === entryTokens[entryTokens.length - 1];
      const reverseLast = candidateTokens[candidateTokens.length - 1] === entryTokens[0];

      if (sameFirst && sameLast) best = Math.max(best, 95);
      if (reverseFirst && reverseLast) best = Math.max(best, 92);
    }
  }

  return best;
}

function cellToString(cellValue) {
  if (cellValue === null || cellValue === undefined) return "";

  if (typeof cellValue === "object") {
    if (cellValue.text) return String(cellValue.text).trim();
    if (cellValue.richText && Array.isArray(cellValue.richText)) {
      return cellValue.richText.map((part) => part.text || "").join("").trim();
    }
    if (cellValue.result !== undefined && cellValue.result !== null) {
      return String(cellValue.result).trim();
    }
    if (cellValue.formula && cellValue.result !== undefined) {
      return String(cellValue.result).trim();
    }
    if (cellValue.hyperlink) {
      return String(cellValue.text || cellValue.hyperlink || "").trim();
    }
    return String(cellValue.toString ? cellValue.toString() : "").trim();
  }

  return String(cellValue).trim();
}

async function loadWorkbookRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const rows = [];

  worksheet.eachRow((row) => {
    const fullName = cellToString(row.getCell(1).value);
    const department = cellToString(row.getCell(2).value);
    const jobTitle = cellToString(row.getCell(3).value);

    if (!fullName || !department || !jobTitle) return;

    rows.push({ fullName, department, jobTitle });
  });

  return rows;
}

async function getEmployeeDirectory() {
  const stat = fs.statSync(config.employeeDirectoryFile);
  if (cachedDirectory && cachedMtimeMs === stat.mtimeMs) return cachedDirectory;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const rows = await loadWorkbookRows(config.employeeDirectoryFile);

    cachedDirectory = rows.map((row) => ({
      ...row,
      normalizedLatin: normalizeName(row.fullName),
      keys: buildNameKeys(row.fullName)
    }));

    cachedMtimeMs = stat.mtimeMs;
    return cachedDirectory;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

function getDepartmentScopes(department = "") {
  return DEPARTMENT_SCOPE_MAP[normalize(department)] || null;
}

async function findEmployeeBySlackProfile(profile) {
  const entries = await getEmployeeDirectory();
  const candidateNames = unique([
    profile?.realName,
    profile?.displayName,
    profile?.realNameNormalized,
    profile?.displayNameNormalized
  ].filter(Boolean).map((x) => String(x).trim()));

  if (!candidateNames.length) return null;
  const candidateKeys = unique(candidateNames.flatMap((name) => buildNameKeys(name)));

  for (const entry of entries) {
    const score = scoreNameMatch(candidateKeys, entry);
    if (score >= 95) return entry;
  }

  let bestEntry = null;
  let bestScore = 0;
  for (const entry of entries) {
    const score = scoreNameMatch(candidateKeys, entry);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestScore >= 90 ? bestEntry : null;
}

module.exports = {
  getEmployeeDirectory,
  findEmployeeBySlackProfile,
  getDepartmentScopes
};
