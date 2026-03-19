const config = require("./config");

const profileCache = new Map();

async function getUserProfile(client, userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < config.profileCacheMs) {
    return cached.profile;
  }

  const response = await client.users.profile.get({ user: userId });
  const profile = {
    userId,
    title: (response?.profile?.title || "").trim(),
    realName: (response?.profile?.real_name || "").trim(),
    realNameNormalized: (response?.profile?.real_name_normalized || "").trim(),
    displayName: (response?.profile?.display_name || "").trim(),
    displayNameNormalized: (response?.profile?.display_name_normalized || "").trim()
  };

  profileCache.set(userId, { profile, fetchedAt: Date.now() });
  return profile;
}

async function getUserTitle(client, userId) {
  const profile = await getUserProfile(client, userId);
  return profile.title;
}

module.exports = {
  getUserProfile,
  getUserTitle
};
