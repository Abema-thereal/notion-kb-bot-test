const config = require("./config");
const { normalize, loadJson, unique } = require("./utils");
const { findEmployeeBySlackProfile, getDepartmentScopes } = require("./employee-directory");

let cachedTitleMap = null;

async function getTitleMap() {
  if (!cachedTitleMap) {
    cachedTitleMap = await loadJson(config.titleMapFile, {
      fallbackScopes: ["public"],
      exact: {},
      contains: []
    });
  }
  return cachedTitleMap;
}

async function resolveScopesFromTitle(title, { useFallback = true } = {}) {
  const titleMap = await getTitleMap();
  const normalizedTitle = normalize(title);

  if (!normalizedTitle) {
    return useFallback ? (titleMap.fallbackScopes || ["public"]) : [];
  }

  if (titleMap.exact && titleMap.exact[normalizedTitle]) {
    return unique(titleMap.exact[normalizedTitle]);
  }

  const found = [];
  for (const rule of titleMap.contains || []) {
    if (normalizedTitle.includes(normalize(rule.needle))) {
      found.push(...(rule.scopes || []));
    }
  }

  if (found.length > 0) return unique(found);
  return useFallback ? (titleMap.fallbackScopes || ["public"]) : [];
}

async function resolveUserAccess(profile) {
  const titleMap = await getTitleMap();
  const slackTitleScopes = await resolveScopesFromTitle(profile?.title || "", { useFallback: false });
  const employee = await findEmployeeBySlackProfile(profile);

  let scopes = [];
  let source = "fallback";
  let matchedTitle = "";
  let matchedDepartment = "";
  let matchedEmployeeName = "";

  if (slackTitleScopes.length > 0) {
    scopes = slackTitleScopes;
    source = "slack-title";
  } else if (employee?.jobTitle) {
    const employeeTitleScopes = await resolveScopesFromTitle(employee.jobTitle, { useFallback: false });
    if (employeeTitleScopes.length > 0) {
      scopes = employeeTitleScopes;
      source = "directory-title";
      matchedTitle = employee.jobTitle;
      matchedDepartment = employee.department;
      matchedEmployeeName = employee.fullName;
    }
  }

  if (scopes.length === 0 && employee?.department) {
    const departmentScopes = getDepartmentScopes(employee.department);
    if (departmentScopes?.length) {
      scopes = departmentScopes;
      source = "directory-department";
      matchedTitle = employee.jobTitle;
      matchedDepartment = employee.department;
      matchedEmployeeName = employee.fullName;
    }
  }

  if (scopes.length === 0) {
    scopes = titleMap.fallbackScopes || ["public"];
  }

  return {
    scopes: unique(["public", ...scopes]),
    source,
    matchedEmployeeName,
    matchedTitle,
    matchedDepartment
  };
}

async function resolveScopesByTitle(title) {
  return resolveScopesFromTitle(title, { useFallback: true });
}

module.exports = {
  getTitleMap,
  resolveScopesByTitle,
  resolveUserAccess
};
