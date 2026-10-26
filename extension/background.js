import { fetchShare, getShareName, resolveShareUrl } from './lib/frameio.js';
import { buildRows, failedAssetIds, formatTime } from './lib/rows.js';
import { sortRows } from './lib/csv.js';
import { postBatch, pushRows, sampleRow } from './lib/feishu.js';
import { fetchTransport, parseBaseUrl, readIndex, readSchema, resolveBaseToken, resolveTable, syncToLark, tenantToken } from './lib/lark.js';
import { userToken } from './lib/oauth.js';
import * as store from './lib/store.js';

const ALARM = 'poll';
let running = null; // the in-flight check, so overlapping triggers share it

// ---------- scheduling ----------

async function ensureAlarm({ force = false } = {}) {
  const { intervalMinutes } = await store.getSettings();
  const period = Math.max(1, Number(intervalMinutes) || store.DEFAULT_SETTINGS.intervalMinutes);
  const existing = await chrome.alarms.get(ALARM);
  if (existing && existing.periodInMinutes === period && !force) return;
  const last = await store.getLastRun();
  const lastAt = last?.finishedAt ? Date.parse(last.finishedAt) : 0;
  const dueIn = Math.max(0.5, (lastAt + period * 60_000 - Date.now()) / 60_000);
  await chrome.alarms.create(ALARM, { delayInMinutes: dueIn, periodInMinutes: period });
}

async function isOverdue() {
  const [{ intervalMinutes }, last] = await Promise.all([store.getSettings(), store.getLastRun()]);
  if (!last?.finishedAt) return true;
  return Date.now() - Date.parse(last.finishedAt) >= intervalMinutes * 60_000;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarm({ force: true });
  await refreshBadge();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBadge();
  if ((await store.getShares()).length && (await isOverdue())) runCheck();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runCheck();
});

// ---------- unread list, badge & notifications ----------

// Every change to the unread list goes through this queue, so a check that
// adds new ids can't overwrite an item the user just marked read.
let unseenTail = Promise.resolve();
function updateUnseen(fn) {
  const run = unseenTail.then(async () => {
    await store.setUnseen(await fn(await store.getUnseen()));
    await refreshBadge();
  });
  unseenTail = run.catch(() => {});
  return run;
}

async function refreshBadge() {
  const n = (await store.getUnseen()).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#5b53ff' });
  await chrome.action.setBadgeText({ text: n ? (n > 999 ? '999+' : String(n)) : '' });
}

function notifyNew(rows, firstRun) {
  const title = firstRun ? `首次抓取完成：共 ${rows.length} 条批注` : `Frame.io：${rows.length} 条新批注`;
  const lines = sortRows(rows).slice(0, 3).map((r) => `${r.video} ${r.tc_start} ${r.author}：${r.text.replace(/\s+/g, ' ')}`);
  if (rows.length > 3) lines.push(`…还有 ${rows.length - 3} 条`);
  chrome.notifications.create(`new-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: lines.join('\n'),
    priority: 1,
  });
}

function notifyAuthExpired() {
  chrome.notifications.create(`auth-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Lark 账号授权已失效',
    message: '多维表格同步已暂停。请打开插件设置页，点「用 Lark 账号授权」重新授权。',
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  if (id.startsWith('auth-')) return chrome.runtime.openOptionsPage();
  try {
    await chrome.action.openPopup();
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
  }
});

// ---------- the check ----------

function runCheck() {
  if (!running) running = doCheck().finally(() => { running = null; });
  return running;
}

async function doCheck() {
  const startedAt = new Date().toISOString();
  const nowLabel = formatTime(startedAt);
  const shares = await store.getShares();
  await store.setLastRun({ startedAt, running: true, progress: '' });

  const comments = await store.getComments();
  const firstRun = Object.keys(comments).length === 0;
  const newIds = [];
  const errors = [];
  const status = {}; // shareId -> { name, lastOkAt, lastError }

  for (const s of shares) {
    const label = s.name || s.shareId.slice(0, 8);
    try {
      const share = await fetchShare(s.shareId, {
        onProgress: ({ done, total }) => store.setLastRun({ progress: `${label}：${done}/${total} 个文件` }),
      });
      newIds.push(...store.mergeShareRows(comments, s.shareId, buildRows(share), failedAssetIds(share), nowLabel));
      const failed = share.files.filter((f) => f.error);
      if (failed.length) errors.push(`${label}：${failed.length} 个文件读取失败（${failed[0].error}）`);
      status[s.shareId] = { name: share.shareName || s.name, lastOkAt: startedAt, lastError: null };
    } catch (e) {
      errors.push(`${label}：${e.message}`);
      status[s.shareId] = { lastError: e.message };
    }
  }

  await store.saveComments(comments);
  // Re-read so a share added or removed in the options page meanwhile is kept.
  await store.saveShares((await store.getShares()).map((s) => ({ ...s, ...status[s.shareId] })));

  if (newIds.length) {
    await updateUnseen((ids) => [...new Set([...ids, ...newIds])]);
    if ((await store.getSettings()).notify) notifyNew(newIds.map((id) => comments[id]), firstRun);
  }

  // Lark API mode replaces the webhook when it is enabled.
  const lark = await syncLark(comments, { auto: true }).catch(async (e) => {
    const failed = { at: new Date().toISOString(), error: e.message };
    await store.setLastRun({ lark: failed });
    return failed;
  });
  const push = lark ? null : await pushPending(comments, { auto: true });
  return store.setLastRun({
    finishedAt: new Date().toISOString(),
    running: false,
    progress: '',
    ok: errors.length === 0,
    error: errors.join('\n') || null,
    newCount: newIds.length,
    total: Object.values(comments).filter((c) => !c.removed).length,
    pushed: push?.pushed ?? null,
    pushError: push?.error ?? null,
  });
}

// ---------- Lark / Feishu app (records + screenshots) ----------

async function larkTarget(settings) {
  const target = parseBaseUrl(settings.larkBaseUrl);
  if (!target) throw new Error('请填写多维表格链接');
  if (!target.apiBase) throw new Error('多维表格链接需要是 feishu.cn 或 larksuite.com 的地址');
  if (!settings.larkAppId || !settings.larkAppSecret) throw new Error('请填写 App ID 和 App Secret');
  const creds = { apiBase: target.apiBase, appId: settings.larkAppId, appSecret: settings.larkAppSecret };
  const asUser = settings.larkAuthMode === 'user';
  const token = asUser
    ? userToken({ ...creds, load: store.getLarkUser, save: store.saveLarkUser, onExpired: notifyAuthExpired })
    : tenantToken(creds);
  const call = fetchTransport({ apiBase: target.apiBase, token, asUser });
  const baseToken = await resolveBaseToken(call, target);
  return { call, baseToken, tableId: await resolveTable(call, { ...target, baseToken }) };
}

// One sync at a time: two overlapping runs would both create the same
// missing records.
let larkTail = Promise.resolve();
function syncLark(comments, opts) {
  const run = larkTail.then(() => doSyncLark(comments, opts));
  larkTail = run.catch(() => {});
  return run;
}

// With `auto`, only runs when Lark sync is enabled.
async function doSyncLark(comments, { auto = false } = {}) {
  const settings = await store.getSettings();
  if (auto && !settings.larkEnabled) return null;
  comments ??= await store.getComments();
  const { call, baseToken, tableId } = await larkTarget(settings);
  const rows = sortRows(Object.values(comments).filter((c) => !c.removed));
  const result = await syncToLark(call, {
    baseToken,
    tableId,
    rows,
    maxShots: Math.max(0, Number(settings.maxShotsPerRun) || 0),
    onProgress: (progress) => store.setLastRun({ progress }),
  });
  const label = formatTime(new Date().toISOString());
  for (const id of result.syncedIds) if (comments[id] && !comments[id].synced_at) comments[id].synced_at = label;
  await store.saveComments(comments);
  const summary = {
    at: new Date().toISOString(),
    created: result.created,
    updated: result.updated,
    shots: result.shots,
    shotsRemaining: result.shotsRemaining,
    shotErrorCount: result.shotErrors.length,
    shotErrors: result.shotErrors.slice(0, 5),
    skippedFields: result.skippedFields,
    error: null,
  };
  await store.setLastRun({ lark: summary, progress: '' });
  return summary;
}

// ---------- Feishu webhook (text only) ----------

function pendingRows(comments) {
  const rows = Object.values(comments).filter((c) => !c.synced_at && !c.removed);
  // Oldest first, then in panel order.
  return sortRows(rows).sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
}

// With `auto`, only runs when pushing is enabled and respects the per-run cap.
async function pushPending(comments, { auto = false } = {}) {
  const settings = await store.getSettings();
  if (!settings.webhookUrl || (auto && !settings.pushEnabled)) return null;
  comments ??= await store.getComments();
  const rows = pendingRows(comments);
  if (!rows.length) return { pushed: 0, remaining: 0, error: null };
  const label = formatTime(new Date().toISOString());
  const result = await pushRows(rows, {
    webhookUrl: settings.webhookUrl,
    webhookToken: settings.webhookToken,
    batchSize: settings.batchSize,
    maxBatches: auto ? settings.maxBatchesPerRun : Infinity,
    onBatchDone: async (ids) => {
      for (const id of ids) comments[id].synced_at = label;
      await store.saveComments(comments);
    },
  });
  await store.setLastRun({ pushed: result.pushed, pushError: result.error, pushAt: new Date().toISOString() });
  return result;
}

// ---------- messages from popup / options ----------

const handlers = {
  async 'check-now'() {
    return runCheck();
  },
  async 'settings-changed'() {
    await ensureAlarm({ force: true });
    return true;
  },
  async 'clear-unseen'() {
    await updateUnseen(() => []);
    return true;
  },
  async 'mark-unread'({ ids }) {
    await updateUnseen((unseen) => [...new Set([...unseen, ...ids])]);
    return true;
  },
  async 'mark-read'({ ids }) {
    const read = new Set(ids);
    await updateUnseen((unseen) => unseen.filter((id) => !read.has(id)));
    return true;
  },
  async 'add-share'({ url }) {
    const parsed = await resolveShareUrl(url);
    if (!parsed) throw new Error('无法识别这个链接，请粘贴 next.frame.io/share/... 或 f.io/... 形式的分享链接');
    const shares = await store.getShares();
    if (shares.some((s) => s.shareId === parsed.shareId)) throw new Error('这个分享已经添加过了');
    const name = await getShareName(parsed.shareId);
    shares.push({ shareId: parsed.shareId, url: String(url).trim(), name, addedAt: new Date().toISOString() });
    await store.saveShares(shares);
    runCheck(); // first crawl right away
    return { name };
  },
  async 'remove-share'({ shareId }) {
    await running; // don't race a check that is writing comments
    await store.saveShares((await store.getShares()).filter((s) => s.shareId !== shareId));
    const comments = await store.getComments();
    for (const [id, c] of Object.entries(comments)) if (c.share_id === shareId) delete comments[id];
    await store.saveComments(comments);
    const kept = new Set(Object.keys(comments));
    await updateUnseen((unseen) => unseen.filter((id) => kept.has(id)));
    return true;
  },
  async 'push-now'() {
    await running;
    return pushPending(null);
  },
  async 'push-test'() {
    const settings = await store.getSettings();
    if (!settings.webhookUrl) throw new Error('请先填写 webhook 地址');
    const result = await postBatch([sampleRow()], settings);
    // A workflow that is still being set up answers "disabled", but Feishu
    // still records the request for "通过发送请求设置".
    if (!result.ok && result.code === 800004509) return { disabled: true };
    if (!result.ok) throw new Error(result.error);
    return { disabled: false };
  },
  async 'lark-test'() {
    const { call, baseToken, tableId } = await larkTarget(await store.getSettings());
    const { skipped } = await readSchema(call, baseToken, tableId);
    const index = await readIndex(call, baseToken, tableId);
    return { tableId, records: index.size, withShots: [...index.values()].filter((e) => e.hasShot).length, skippedFields: skipped };
  },
  async 'lark-sync-now'() {
    await running;
    return syncLark(null);
  },
  async 'mark-all-synced'() {
    await running;
    const comments = await store.getComments();
    const label = formatTime(new Date().toISOString());
    let n = 0;
    for (const c of Object.values(comments)) if (!c.synced_at) { c.synced_at = label; n++; }
    await store.saveComments(comments);
    return n;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});
