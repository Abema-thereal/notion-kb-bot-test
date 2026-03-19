const { loadJson, normalizeNotionId } = require("./utils");
const config = require("./config");

let cachedAccessMap = null;

async function getAccessMap() {
  if (cachedAccessMap) return cachedAccessMap;

  const data = await loadJson(config.accessMapFile, { roots: [], pageScopeOverrides: {} });

  const normalizedRoots = Array.isArray(data.roots)
    ? data.roots.map((root) => ({
        ...root,
        id: root.id ? normalizeNotionId(root.id) : root.id,
        allowedScopes: Array.isArray(root.allowedScopes) ? root.allowedScopes : []
      }))
    : [];

  const normalizedPageScopeOverrides = {};
  const rawOverrides = data.pageScopeOverrides && typeof data.pageScopeOverrides === "object"
    ? data.pageScopeOverrides
    : {};

  for (const [pageId, scopes] of Object.entries(rawOverrides)) {
    try {
      normalizedPageScopeOverrides[normalizeNotionId(pageId)] = Array.isArray(scopes) ? scopes : [];
    } catch (_) {}
  }

  cachedAccessMap = {
    roots: normalizedRoots,
    pageScopeOverrides: normalizedPageScopeOverrides
  };

  return cachedAccessMap;
}

function clearAccessMapCache() {
  cachedAccessMap = null;
}

function hasScopeAccess(chunkScopes = [], userScopes = []) {
  const chunkSet = new Set(chunkScopes || []);
  for (const scope of userScopes || []) {
    if (chunkSet.has(scope)) return true;
  }
  return false;
}

async function filterChunksByScopes(chunks, scopes) {
  const accessMap = await getAccessMap();
  const safeScopes = Array.isArray(scopes) ? scopes : [];
  const pageScopeOverrides = accessMap.pageScopeOverrides || {};

  return (chunks || []).filter((chunk) => {
    const pageId = normalizeNotionId(chunk.pageId || "");
    const overrideScopes = pageScopeOverrides[pageId];
    if (overrideScopes && overrideScopes.length > 0) {
      return hasScopeAccess(overrideScopes, safeScopes);
    }
    return hasScopeAccess(chunk.allowedScopes || [], safeScopes);
  });
}

async function getAllowedRootKeys(scopes) {
  const accessMap = await getAccessMap();
  const safeScopes = new Set(scopes || []);

  return (accessMap.roots || [])
    .filter((root) => root.enabled && Array.isArray(root.allowedScopes) && root.allowedScopes.some((scope) => safeScopes.has(scope)))
    .map((root) => root.key);
}

module.exports = {
  getAccessMap,
  clearAccessMapCache,
  filterChunksByScopes,
  getAllowedRootKeys
};
