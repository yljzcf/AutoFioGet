// chrome.storage.local layout:
//   settings  { intervalMinutes, notify, larkEnabled, larkAuthMode, larkAppId, larkAppSecret, larkBaseUrl,
//               maxShotsPerRun, webhookUrl, webhookToken, batchSize, maxBatchesPerRun, pushEnabled }
//   larkUser  { accessToken, expiresAt, refreshToken, refreshExpiresAt, appId, apiBase, name, openId, expired }
//             the Lark account signed in for larkAuthMode 'user' (lib/oauth.js)
//   shares    [{ shareId, url, name, addedAt }]
//   comments  { [comment_id]: row + { first_seen_at, synced_at, removed } }
//   unseenIds [comment_id]   new since the popup was last opened (badge count)
//   lastRun   { startedAt, finishedAt, ok, error, newCount, progress, pushed, pushError, lark }
//   lastExportAt  ISO time of the last "export new" CSV

export const DEFAULT_SETTINGS = {
  intervalMinutes: 180,
  notify: true,
  // Lark / Feishu app (Base v3 API): records + screenshots.
  larkEnabled: false,
  // 'app': write as the app (tenant token). 'user': as the signed-in Lark
  // account, e.g. into a Base another organization shared with it.
  larkAuthMode: 'app',
  larkAppId: '',
  larkAppSecret: '',
  larkBaseUrl: '',
  // Each screenshot takes a few seconds to render; the rest go next check.
  maxShotsPerRun: 100,
  // Webhook alternative: text only.
  webhookUrl: '',
  webhookToken: '',
  batchSize: 5,
  // Caps workflow runs per check so a big backlog doesn't burn the monthly
  // quota (Free plan: 200 runs) in one go; the rest goes out next check.
  maxBatchesPerRun: 20,
  pushEnabled: false,
};

const local = chrome.storage.local;

export async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await local.set({ settings });
  return settings;
}

export async function getLarkUser() {
  return (await local.get('larkUser')).larkUser || null;
}

export async function saveLarkUser(larkUser) {
  await local.set({ larkUser });
}

export async function getShares() {
  return (await local.get('shares')).shares || [];
}

export async function saveShares(shares) {
  await local.set({ shares });
}

export async function getComments() {
  return (await local.get('comments')).comments || {};
}

export async function saveComments(comments) {
  await local.set({ comments });
}

export async function getLastRun() {
  return (await local.get('lastRun')).lastRun || null;
}

export async function setLastRun(patch) {
  const lastRun = { ...(await getLastRun()), ...patch };
  await local.set({ lastRun });
  return lastRun;
}

export async function getUnseen() {
  return (await local.get('unseenIds')).unseenIds || [];
}

export async function setUnseen(unseenIds) {
  await local.set({ unseenIds });
}

// Merges freshly fetched rows for one share into the stored map.
// Comments missing from files that loaded fine are marked removed (kept so a
// comment that comes back is not treated as new and pushed twice).
// Returns the ids of comments seen for the first time.
export function mergeShareRows(comments, shareId, rows, failedAssetIds, now) {
  const added = [];
  const present = new Set();
  for (const row of rows) {
    present.add(row.comment_id);
    const prev = comments[row.comment_id];
    if (prev) {
      comments[row.comment_id] = { ...prev, ...row, first_seen_at: prev.first_seen_at, synced_at: prev.synced_at, removed: false };
    } else {
      comments[row.comment_id] = { ...row, first_seen_at: now, synced_at: null, removed: false };
      added.push(row.comment_id);
    }
  }
  const failed = new Set(failedAssetIds);
  for (const [id, c] of Object.entries(comments)) {
    if (c.share_id === shareId && !present.has(id) && !failed.has(c.asset_id)) c.removed = true;
  }
  return added;
}
