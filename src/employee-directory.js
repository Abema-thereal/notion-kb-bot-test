const path = require("path");
const ExcelJS = require("exceljs");

const FILE_NAME = "job_titles.xlsx";

let cache = null;

function normalizeText(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeName(value = "") {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function getFilePath() {
  return path.join(process.cwd(), FILE_NAME);
}

function buildHeaderMap(headerRow) {
  const map = new Map();

  headerRow.eachCell((cell, colNumber) => {
    const header = normalizeText(cell.value || "");
    if (header) {
      map.set(header, colNumber);
    }
  });

  return map;
}

function getCellByPossibleHeaders(row, headerMap, possibleHeaders = [], fallbackCol = null) {
  for (const header of possibleHeaders) {
    const col = headerMap.get(normalizeText(header));
    if (col) {
      const value = row.getCell(col).value;
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }

  if (fallbackCol) {
    const value = row.getCell(fallbackCol).value;
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

async function loadDirectory() {
  if (cache) return cache;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(getFilePath());

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    cache = [];
    return cache;
  }

  const headerRow = worksheet.getRow(1);
  const headerMap = buildHeaderMap(headerRow);

  const employees = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);

    const name = firstNonEmpty(
      getCellByPossibleHeaders(row, headerMap, ["name", "employee", "full name", "имя", "сотрудник"], 1)
    );

    const title = firstNonEmpty(
      getCellByPossibleHeaders(row, headerMap, ["title", "position", "role", "должность"], 2)
    );

    const department = firstNonEmpty(
      getCellByPossibleHeaders(row, headerMap, ["department", "dept", "team", "отдел"], 3)
    );

    // Пользователь сказал, что email у него в столбце D с названием "email"
    const email = firstNonEmpty(
      getCellByPossibleHeaders(row, headerMap, ["email", "e-mail", "mail"], 4)
    );

    if (!name && !title && !department && !email) {
      continue;
    }

    employees.push({
      name,
      normalizedName: normalizeName(name),
      title,
      department,
      email: normalizeEmail(email),
    });
  }

  cache = employees;
  return cache;
}

function clearDirectoryCache() {
  cache = null;
}

async function findEmployeeByEmail(email) {
  const employees = await loadDirectory();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return employees.find((employee) => employee.email === normalizedEmail) || null;
}

async function findEmployeeByName(...names) {
  const employees = await loadDirectory();
  const normalizedCandidates = names
    .map((name) => normalizeName(name))
    .filter(Boolean);

  if (!normalizedCandidates.length) return null;

  for (const candidate of normalizedCandidates) {
    const exact = employees.find((employee) => employee.normalizedName === candidate);
    if (exact) return exact;
  }

  for (const candidate of normalizedCandidates) {
    const partial = employees.find((employee) => {
      return (
        employee.normalizedName &&
        (employee.normalizedName.includes(candidate) || candidate.includes(employee.normalizedName))
      );
    });
    if (partial) return partial;
  }

  return null;
}

async function findEmployeeMatch(profile = {}) {
  const byEmail = await findEmployeeByEmail(profile.email || "");
  if (byEmail) {
    return {
      source: "directory_email",
      employee: byEmail,
    };
  }

  const byName = await findEmployeeByName(
    profile.realName || "",
    profile.displayName || "",
    [profile.firstName, profile.lastName].filter(Boolean).join(" ")
  );

  if (byName) {
    return {
      source: "directory_name",
      employee: byName,
    };
  }

  return null;
}

module.exports = {
  loadDirectory,
  clearDirectoryCache,
  findEmployeeByEmail,
  findEmployeeByName,
  findEmployeeMatch,
};