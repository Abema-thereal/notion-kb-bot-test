const CACHE_TTL_MS = 10 * 60 * 1000;
const profileCache = new Map();

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function buildProfile(userId, user = {}) {
  const profile = user.profile || {};

  return {
    userId,
    email: normalizeEmail(profile.email || ""),
    title: String(profile.title || "").trim(),
    realName: String(user.real_name || profile.real_name || "").trim(),
    displayName: String(profile.display_name || "").trim(),
    firstName: String(profile.first_name || "").trim(),
    lastName: String(profile.last_name || "").trim(),
  };
}

async function getUserProfile(client, userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  let value;

  try {
    const info = await client.users.info({ user: userId });
    value = buildProfile(userId, info.user || {});
  } catch (error) {
    // fallback на users.profile.get, если users.info по какой-то причине не сработал
    const result = await client.users.profile.get({ user: userId });
    const profile = result.profile || {};

    value = {
      userId,
      email: normalizeEmail(profile.email || ""),
      title: String(profile.title || "").trim(),
      realName: String(profile.real_name || "").trim(),
      displayName: String(profile.display_name || "").trim(),
      firstName: String(profile.first_name || "").trim(),
      lastName: String(profile.last_name || "").trim(),
    };
  }

  profileCache.set(userId, { ts: Date.now(), value });
  return value;
}

async function getUserTitle(client, userId) {
  const profile = await getUserProfile(client, userId);
  return profile.title || "";
}

module.exports = {
  getUserProfile,
  getUserTitle,
};