const fs = require("fs/promises");
const path = require("path");
const { findEmployeeMatch } = require("./employee-directory");

let titleMapCache = null;

function normalizeText(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function isMeaningful(scopes = [], fallbackScopes = ["public"]) {
  const a = [...new Set(scopes)].sort().join("|");
  const b = [...new Set(fallbackScopes)].sort().join("|");
  return a !== b;
}

async function loadTitleMap() {
  if (titleMapCache) return titleMapCache;

  const filePath = path.join(process.cwd(), "data", "title-map.json");
  const raw = await fs.readFile(filePath, "utf8");
  titleMapCache = JSON.parse(raw);
  return titleMapCache;
}

function resolveScopesFromTitle(title, titleMap) {
  const fallbackScopes = Array.isArray(titleMap.fallbackScopes)
    ? titleMap.fallbackScopes
    : ["public"];

  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return fallbackScopes;

  const exact = titleMap.exact || {};
  if (exact[normalizedTitle]) {
    return unique(exact[normalizedTitle]);
  }

  const contains = Array.isArray(titleMap.contains) ? titleMap.contains : [];
  for (const rule of contains) {
    const needle = normalizeText(rule.needle || "");
    if (needle && normalizedTitle.includes(needle)) {
      return unique(rule.scopes || fallbackScopes);
    }
  }

  return fallbackScopes;
}

function resolveScopesFromDepartment(department = "") {
  const normalizedDepartment = normalizeText(department);

  const map = {
    "development": ["public", "development"],
    "customer care": ["public", "customer-care"],
    "customer-care": ["public", "customer-care"],
    "green team": ["public", "green-team"],
    "green-team": ["public", "green-team"],
    "black team": ["public", "black-team"],
    "black-team": ["public", "black-team"],
    "gold team": ["public", "gold-team"],
    "gold-team": ["public", "gold-team"],
    "game leads": ["public", "gameleads"],
    "gameleads": ["public", "gameleads"],
    "head office": ["public", "office"],
    "office": ["public", "office"],
    "marketing": ["public", "marketing"],
    "content": ["public", "content"],
    "sales": ["public", "sales"],
    "product": ["public", "product"],
    "hr": ["public", "office", "hr"],
    "salesforce": ["public", "salesforce"],
    "qa": ["public", "qa"]
  };

  return map[normalizedDepartment] || ["public"];
}

async function resolveUserAccess(profile = {}) {
  const titleMap = await loadTitleMap();
  const fallbackScopes = Array.isArray(titleMap.fallbackScopes)
    ? titleMap.fallbackScopes
    : ["public"];

  const directoryMatch = await findEmployeeMatch(profile);

  if (directoryMatch?.employee) {
    const employee = directoryMatch.employee;

    const titleScopes = resolveScopesFromTitle(employee.title || "", titleMap);
    const departmentScopes = resolveScopesFromDepartment(employee.department || "");

    let scopes;
    if (isMeaningful(titleScopes, fallbackScopes) && isMeaningful(departmentScopes, fallbackScopes)) {
      scopes = unique([...titleScopes, ...departmentScopes]);
    } else if (isMeaningful(titleScopes, fallbackScopes)) {
      scopes = titleScopes;
    } else if (isMeaningful(departmentScopes, fallbackScopes)) {
      scopes = departmentScopes;
    } else {
      scopes = fallbackScopes;
    }

    return {
      scopes,
      source: directoryMatch.source,
      matchedEmployeeName: employee.name || "",
      matchedTitle: employee.title || "",
      matchedDepartment: employee.department || "",
      matchedEmail: employee.email || "",
    };
  }

  const slackTitleScopes = resolveScopesFromTitle(profile.title || "", titleMap);

  return {
    scopes: slackTitleScopes,
    source: profile.title ? "slack_title" : "fallback_public",
    matchedEmployeeName: "",
    matchedTitle: profile.title || "",
    matchedDepartment: "",
    matchedEmail: profile.email || "",
  };
}

async function resolveScopesByTitle(title = "") {
  const titleMap = await loadTitleMap();
  return resolveScopesFromTitle(title, titleMap);
}

module.exports = {
  resolveUserAccess,
  resolveScopesByTitle,
};