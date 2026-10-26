#!/usr/bin/env node
// End-to-end test of background.js in Node: a fake `chrome` API, the real
// Frame.io share, and a local mock of the Feishu webhook.
// Usage: node scripts/test-extension.mjs <share-url>

import http from 'node:http';
import assert from 'node:assert/strict';

const shareUrl = process.argv[2];
if (!shareUrl) {
  console.error('用法: node scripts/test-extension.mjs <分享链接>');
  process.exit(1);
}

// ---------- fake chrome ----------
const data = {};
const on = { changed: [], message: [], alarm: [], installed: [], startup: [] };
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const notifications = [];
let badge = '';
const alarms = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = typeof keys === 'string' ? [keys] : keys ?? Object.keys(data);
        return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data[k], newValue: clone(v) };
          data[k] = clone(v);
        }
        on.changed.forEach((f) => f(changes, 'local'));
      },
    },
    onChanged: { addListener: (f) => on.changed.push(f) },
  },
  alarms: {
    async get(name) { return alarms[name]; },
    async create(name, o) { alarms[name] = { name, periodInMinutes: o.periodInMinutes, scheduledTime: Date.now() + o.delayInMinutes * 60_000 }; },
    onAlarm: { addListener: (f) => on.alarm.push(f) },
  },
  notifications: {
    create(_id, o) { notifications.push(o); },
    clear() {},
    onClicked: { addListener() {} },
  },
  action: {
    async setBadgeText({ text }) { badge = text; },
    async setBadgeBackgroundColor() {},
    async openPopup() {},
  },
  runtime: {
    onInstalled: { addListener: (f) => on.installed.push(f) },
    onStartup: { addListener: (f) => on.startup.push(f) },
    onMessage: { addListener: (f) => on.message.push(f) },
    openOptionsPage() {},
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  tabs: { create() {} },
};

function send(type, extra = {}) {
  return new Promise((resolve) => on.message.forEach((f) => f({ type, ...extra }, {}, resolve)));
}
async function sendOk(type, extra) {
  const res = await send(type, extra);
  assert.ok(res.ok, `${type} failed: ${res.error}`);
  return res.result;
}

// ---------- mock Feishu webhook ----------
const received = [];
let failNext = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (failNext > 0) {
      failNext--;
      res.end(JSON.stringify({ code: 800005649, msg: '未通过凭证校验', data: {} }));
      return;
    }
    received.push({ headers: req.headers, body: JSON.parse(body) });
    res.end(JSON.stringify({ code: 0, msg: '', data: {} }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const webhookUrl = `http://127.0.0.1:${server.address().port}/hook`;


// ---------- mock Lark Base v3 API ----------
// fetch() calls to open.larksuite.com are rerouted here.
const lark = { records: new Map(), nextId: 1, uploads: 0, appends: 0, createdWithShot: 0, failUpload: 0, failRead: null, tokenCalls: 0 };
// Signed-in user (OAuth v2): the current access / refresh token, rotated on refresh.
Object.assign(lark, { userAccess: null, refreshToken: null, issued: 0, refreshCalls: 0, refreshFail: false, lastAuth: null });
function issueUserTokens() {
  lark.issued++;
  lark.userAccess = `u-${lark.issued}`;
  lark.refreshToken = `r-${lark.issued}`;
  return { code: 0, access_token: lark.userAccess, expires_in: 7200, refresh_token: lark.refreshToken, refresh_token_expires_in: 604800, token_type: 'Bearer', scope: 'base:record:read offline_access' };
}
// The table's fields, as the README lays them out. Writing any other field
// fails like the real API does.
const NUMBER_FIELDS = new Set(['编号', '回复对象', '开始秒数']);
const SELECT_FIELDS = new Set(['类型', '已完成']);
const unknownField = (rec) => Object.keys(rec).find((f) => !lark.schema.has(f));
const larkServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const ok = (data) => res.end(JSON.stringify({ code: 0, msg: 'success', data }));
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      lark.tokenCalls++;
      return res.end(JSON.stringify({ code: 0, tenant_access_token: 't-123', expire: 7200 }));
    }
    if (url.pathname === '/open-apis/authen/v2/oauth/token') {
      const b = JSON.parse(raw.toString());
      assert.equal(b.client_id, 'cli_test');
      assert.equal(b.client_secret, 'secret');
      const invalid = { code: 20037, error: 'invalid_grant', error_description: 'The refresh token is invalid or expired.' };
      if (b.grant_type === 'authorization_code') {
        assert.equal(b.code, 'good-code');
        assert.ok(b.redirect_uri);
        return res.end(JSON.stringify(issueUserTokens()));
      }
      assert.equal(b.grant_type, 'refresh_token');
      lark.refreshCalls++;
      // A rotated (already used) refresh token is rejected, as Lark does.
      if (lark.refreshFail || b.refresh_token !== lark.refreshToken) return res.end(JSON.stringify(invalid));
      return res.end(JSON.stringify(issueUserTokens()));
    }
    const authz = req.headers.authorization;
    assert.ok(authz === 'Bearer t-123' || authz === `Bearer ${lark.userAccess}`, `unexpected token ${authz}`);
    lark.lastAuth = authz;
    if (url.pathname === '/open-apis/authen/v1/user_info') return ok({ name: '测试用户', open_id: 'ou_test' });
    if (url.pathname === '/open-apis/wiki/v2/spaces/get_node') {
      assert.equal(url.searchParams.get('token'), 'WIKI');
      return ok({ node: { obj_type: 'bitable', obj_token: 'BASE', node_token: 'WIKI' } });
    }
    const base = '/open-apis/base/v3/bases/BASE';
    if (url.pathname === `${base}/tables`) return ok({ tables: [{ id: 'tblT', name: '批注' }] });
    if (url.pathname === `${base}/tables/tblT/records` && req.method === 'GET') {
      if (lark.failRead) return res.end(JSON.stringify(lark.failRead));
      const asked = url.searchParams.getAll('field_id');
      const fields = asked.length ? asked.filter((f) => lark.schema.has(f)) : [...lark.schema.keys()];
      const all = [...lark.records.entries()];
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      const page = all.slice(offset, offset + limit);
      return ok({
        fields,
        field_type_list: fields.map((f) => lark.schema.get(f)),
        record_id_list: page.map(([id]) => id),
        data: page.map(([, r]) => fields.map((f) => r[f] ?? null)),
        has_more: offset + limit < all.length,
      });
    }
    const body = () => JSON.parse(raw.toString());
    const notFound = () => res.end(JSON.stringify({ code: 800030201, msg: 'not_found: not_found' }));
    if (url.pathname === `${base}/tables/tblT/records/batch_create`) {
      if (body().create_records.some(unknownField)) return notFound();
      for (const r of body().create_records.filter((x) => x['截图'])) {
        assert.ok(r['截图'].every((a) => /^file\d+$/.test(a.file_token) && a.image_width > 0), 'screenshot cells carry uploaded file tokens');
        lark.createdWithShot++;
      }
      const ids = body().create_records.map((r) => { const id = `rec${lark.nextId++}`; lark.records.set(id, r); return id; });
      return ok({ record_id_list: ids });
    }
    if (url.pathname === `${base}/tables/tblT/records/batch_update`) {
      if (Object.values(body().update_records).some(unknownField)) return notFound();
      for (const [id, f] of Object.entries(body().update_records)) Object.assign(lark.records.get(id), f);
      return ok({});
    }
    if (url.pathname === '/open-apis/drive/v1/medias/upload_all') {
      const text = raw.toString('latin1');
      assert.match(text, /name="parent_type"\r\n\r\nbitable_file/);
      assert.match(text, /name="parent_node"\r\n\r\nBASE/);
      assert.ok(raw.includes(Buffer.from([0xff, 0xd8, 0xff])), 'JPEG bytes uploaded');
      if (lark.failUpload > 0) {
        lark.failUpload--;
        return res.end(JSON.stringify({ code: 1061045, msg: 'mock upload failure' }));
      }
      return ok({ file_token: `file${++lark.uploads}` });
    }
    if (url.pathname === `${base}/tables/tblT/append_attachments`) {
      lark.appends++;
      for (const [id, f] of Object.entries(body().attachments)) {
        const rec = lark.records.get(id);
        rec['截图'] = [...(rec['截图'] || []), ...f['截图']];
      }
      return ok({});
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 404, msg: `mock: no route ${req.method} ${url.pathname}` }));
  });
});
await new Promise((r) => larkServer.listen(0, '127.0.0.1', r));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.startsWith('https://open.larksuite.com/')) return realFetch(u.replace('https://open.larksuite.com', `http://127.0.0.1:${larkServer.address().port}`), init);
  return realFetch(input, init);
};

// ---------- run ----------
const { COLUMNS } = await import('../extension/lib/rows.js');
const { toCsv } = await import('../extension/lib/csv.js');
lark.schema = new Map([...COLUMNS.map(({ label }) => [label, NUMBER_FIELDS.has(label) ? 'number' : SELECT_FIELDS.has(label) ? 'select' : 'text']), ['截图', 'attachment']]);
await import('../extension/background.js');
const step = (s) => console.log(`\n▶ ${s}`);
const live = () => Object.values(data.comments || {}).filter((c) => !c.removed);
const pending = () => live().filter((c) => !c.synced_at).length;

step('install');
await Promise.all(on.installed.map((f) => f({ reason: 'install' })));
assert.equal(alarms.poll.periodInMinutes, 180);
console.log('  alarm every', alarms.poll.periodInMinutes, 'min');

step('add share + first crawl');
const added = await sendOk('add-share', { url: shareUrl });
let run = await sendOk('check-now');
console.log(`  share "${added.name}", ${run.total} comments, new ${run.newCount}, ok=${run.ok}`, run.error || '');
assert.ok(run.ok);
assert.ok(run.total > 0);
assert.equal(run.newCount, run.total);
assert.equal(badge, String(run.total));
assert.equal(notifications.length, 1);
assert.match(notifications[0].title, /首次抓取完成/);
const total = run.total;
assert.equal((await send('add-share', { url: shareUrl })).ok, false, 'duplicate share rejected');

step('second crawl: nothing new');
await sendOk('clear-unseen');
run = await sendOk('check-now');
assert.equal(run.newCount, 0);
assert.equal(notifications.length, 1);
assert.equal(badge, '');
console.log('  new 0, no notification, badge cleared');

step('two comments "appear"');
const [a, b] = Object.keys(data.comments);
delete data.comments[a];
delete data.comments[b];
run = await sendOk('check-now');
assert.equal(run.newCount, 2);
assert.equal(badge, '2');
assert.match(notifications.at(-1).title, /2 条新批注/);
console.log(`  notification: ${notifications.at(-1).title}\n  ${notifications.at(-1).message.replace(/\n/g, '\n  ')}`);

step('mark one read; the other stays unread across a check');
await sendOk('mark-read', { ids: [a] });
assert.deepEqual(data.unseenIds, [b]);
assert.equal(badge, '1');
await sendOk('mark-read', { ids: [a] });
assert.equal(badge, '1', 'marking twice is harmless');
run = await sendOk('check-now');
assert.deepEqual(data.unseenIds, [b], 'a check does not bring back read items or clear unread ones');
assert.equal(badge, '1');
await sendOk('mark-unread', { ids: [a] });
assert.equal(badge, '2');
await sendOk('mark-read', { ids: [a] });
console.log('  badge 2 → 1, unread item kept after the next check; mark-unread brings it back');

step('auto push during a check is capped (batch 5 × 3)');
await chrome.storage.local.set({ settings: { ...data.settings, webhookUrl, pushEnabled: true, batchSize: 5, maxBatchesPerRun: 3 } });
run = await sendOk('check-now');
assert.equal(run.pushed, 15);
assert.equal(received.length, 3);
assert.ok(received.every((r) => r.body.items.length === 5));
assert.equal(pending(), total - 15);
console.log(`  pushed ${run.pushed}, pending ${pending()}`);

step('webhook failure leaves rows unsynced');
failNext = 1;
let push = await sendOk('push-now');
assert.equal(push.pushed, 0);
assert.match(push.error, /800005649/);
assert.equal(pending(), total - 15);
console.log('  error:', push.error);

step('manual push sends the rest (batch 100, no cap)');
await chrome.storage.local.set({ settings: { ...data.settings, batchSize: 100 } });
push = await sendOk('push-now');
assert.equal(push.error, null);
assert.equal(push.pushed, total - 15);
assert.equal(pending(), 0);
push = await sendOk('push-now');
assert.equal(push.pushed, 0);
console.log(`  pushed ${total - 15} in ${received.length - 3} requests; second push sent nothing`);

step('payload shape');
const items = received.flatMap((r) => r.body.items);
assert.equal(items.length, total);
assert.equal(new Set(items.map((i) => i.comment_id)).size, total, 'no duplicates');
assert.deepEqual(Object.keys(items[0]).sort(), COLUMNS.map((c) => c.key).sort());
assert.ok(items.every((i) => typeof i.number === 'number' && typeof i.start_seconds === 'number'));
const tokens = received.map((r) => r.headers['client-token']);
assert.ok(tokens.every((t) => /^[0-9a-f]{32}$/.test(t)));
assert.equal(new Set(tokens).size, tokens.length);
console.log('  sample item:', JSON.stringify(items.find((i) => i.tc_end)).slice(0, 400));

step('test payload + mark synced + CSV');
await sendOk('push-test');
assert.match(received.at(-1).body.items[0].comment_id, /^sample-/);
assert.equal(await sendOk('mark-all-synced'), 0);
const csv = toCsv(live());
assert.ok(csv.startsWith('﻿分享名称,'));
console.log(`  CSV ${csv.length} chars`);


step('Lark app mode: records + screenshots, webhook skipped');
const hooksBefore = received.length;
await chrome.storage.local.set({ settings: { ...data.settings, larkEnabled: true, larkAppId: 'cli_test', larkAppSecret: 'secret', larkBaseUrl: 'https://x.jp.larksuite.com/base/BASE', maxShotsPerRun: 3 } });
let test = await sendOk('lark-test');
assert.equal(test.tableId, 'tblT');
assert.equal(test.records, 0);
run = await sendOk('check-now');
assert.equal(run.lark?.error ?? null, null, run.lark?.error);
assert.equal(run.lark.created, total);
assert.equal(run.lark.shots, 3);
assert.equal(received.length, hooksBefore, 'webhook not used in Lark mode');
assert.equal(lark.records.size, total);
const withShots = [...lark.records.values()].filter((r) => r['截图']);
assert.equal(withShots.length, 3);
for (const r of withShots) assert.equal(r['截图'].length, r['结束时间码'] ? 2 : 1, 'range comments get start + end');
assert.equal(lark.createdWithShot, 3, 'new records are created with their screenshots');
assert.equal(lark.appends, 0, 'no screenshot appended after creation');
const anyRec = [...lark.records.values()][0];
assert.ok(Array.isArray(anyRec['类型']) && Array.isArray(anyRec['已完成']), 'selects sent as arrays');
console.log(`  created ${run.lark.created}, shots ${run.lark.shots} (${lark.uploads} images), remaining ${run.lark.shotsRemaining}`);

step('second sync: no duplicates, edit pushed back, more screenshots');
const [editedId, editedRec] = [...lark.records.entries()].find(([, r]) => !r['截图']);
editedRec['内容'] = 'stale text in Lark';
run = await sendOk('check-now');
assert.equal(run.lark.created, 0);
assert.ok(run.lark.updated >= 1);
assert.notEqual(lark.records.get(editedId)['内容'], 'stale text in Lark');
assert.equal(lark.records.size, total);
assert.equal([...lark.records.values()].filter((r) => r['截图']).length, 6);
assert.ok(lark.appends > 0, 'older records get screenshots appended');
console.log(`  created 0, updated ${run.lark.updated}, shots now 6`);

step('new record whose screenshot fails: created anyway, screenshot appended next run');
const [shotId, shotRec] = [...lark.records.entries()].find(([, r]) => r['截图']);
lark.records.delete(shotId);
lark.failUpload = 1;
const appendsBefore = lark.appends;
run = await sendOk('check-now');
assert.equal(run.lark.created, 1);
assert.equal(run.lark.shotErrorCount, 1);
assert.match(run.lark.shotErrors[0], /mock upload failure/);
const shotError = run.lark.shotErrors[0];
const again = () => [...lark.records.values()].find((r) => r['批注ID'] === shotRec['批注ID']);
assert.ok(again() && !again()['截图'], 'record created without the failed screenshot');
run = await sendOk('check-now');
assert.equal(run.lark.created, 0);
assert.equal(run.lark.shotErrorCount, 0);
assert.ok(again()['截图'], 'screenshot appended on the next run');
assert.ok(lark.appends > appendsBefore);
console.log(`  ${shotError} → appended on the next check`);

step('renamed / removed / formula columns: written by the table\'s own fields');
// 作者 renamed to 批注者, 结束时间码 deleted, 已完成 now a checkbox, plus a
// formula column: the writes that used to fail with not_found.
lark.schema.delete('作者');
lark.schema.set('批注者', 'text');
lark.schema.delete('结束时间码');
lark.schema.set('已完成', 'checkbox');
lark.schema.set('批注点', 'formula');
for (const r of lark.records.values()) {
  r['批注者'] = r['作者'];
  r['已完成'] = r['已完成'][0] === '是';
  delete r['作者'];
  delete r['结束时间码'];
}
const [droppedId] = lark.records.keys();
const droppedComment = lark.records.get(droppedId)['批注ID'];
lark.records.delete(droppedId); // one record missing → must be recreated
run = await sendOk('check-now');
assert.equal(run.lark?.error ?? null, null, run.lark?.error);
assert.equal(run.lark.created, 1);
assert.equal(run.lark.updated, 0, 'checkbox / select cells compare equal, nothing rewritten');
assert.deepEqual(run.lark.skippedFields, ['结束时间码']);
const recreated = [...lark.records.values()].find((r) => r['批注ID'] === droppedComment);
assert.ok(typeof recreated['批注者'] === 'string' && recreated['批注者'], 'author written to 批注者');
assert.equal(typeof recreated['已完成'], 'boolean');
assert.ok(!('作者' in recreated) && !('结束时间码' in recreated) && !('批注点' in recreated));
const [flipId, flipRec] = [...lark.records.entries()].find(([, r]) => r['已完成'] === false);
flipRec['已完成'] = true;
run = await sendOk('check-now');
assert.equal(run.lark.updated, 1);
assert.equal(lark.records.get(flipId)['已完成'], false, 'checkbox follows Frame.io');
test = await sendOk('lark-test');
assert.deepEqual(test.skippedFields, ['结束时间码']);
// A single-select author column can't take new names: skipped, not failed.
lark.schema.set('批注者', 'select');
run = await sendOk('check-now');
assert.equal(run.lark?.error ?? null, null, run.lark?.error);
assert.match(run.lark.skippedFields.join(), /批注者（单选列/);
lark.schema.set('批注者', 'text');
console.log(`  recreated 1 record, skipped ${run.lark.skippedFields.join(', ')}, checkbox update ok`);

step('Lark permission error is reported, not thrown');
lark.failRead = { code: 91403, msg: 'Forbidden' };
run = await sendOk('check-now');
assert.match(run.lark.error, /协作者/);
lark.failRead = null;
console.log('  error:', run.lark.error);

step('oauth helpers: sign-in URL, redirect check, code exchange; wiki links');
const oauth = await import('../extension/lib/oauth.js');
const { parseBaseUrl, resolveBaseToken } = await import('../extension/lib/lark.js');
const redirectUri = 'https://abcdef.chromiumapp.org/';
const authUrl = new URL(oauth.authorizeUrl({ apiBase: 'https://open.larksuite.com', appId: 'cli_test', redirectUri, state: 's1' }));
assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.larksuite.com/open-apis/authen/v1/authorize');
assert.equal(authUrl.searchParams.get('client_id'), 'cli_test');
assert.equal(authUrl.searchParams.get('redirect_uri'), redirectUri);
assert.match(authUrl.searchParams.get('scope'), /(^| )offline_access( |$)/);
assert.match(authUrl.searchParams.get('scope'), /wiki:node:read/);
assert.throws(() => oauth.codeFromRedirect(`${redirectUri}?code=c&state=forged`, 's1'), /校验失败/);
assert.throws(() => oauth.codeFromRedirect(`${redirectUri}?error=access_denied&state=s1`, 's1'), /取消了授权/);
const signedIn = await oauth.exchangeCode({
  apiBase: 'https://open.larksuite.com', appId: 'cli_test', appSecret: 'secret', redirectUri,
  code: oauth.codeFromRedirect(`${redirectUri}?code=good-code&state=s1`, 's1'),
});
assert.equal(signedIn.name, '测试用户');
assert.equal(signedIn.accessToken, lark.userAccess);
assert.ok(signedIn.refreshExpiresAt > Date.now() + 6 * 86400e3);
assert.deepEqual(parseBaseUrl('https://x.usttp.larksuite.com/wiki/WIKI?table=tblT&view=vew1'), { apiBase: 'https://open.larksuite.com', wikiToken: 'WIKI', tableId: 'tblT' });
await assert.rejects(resolveBaseToken(async () => ({ node: { obj_type: 'docx', obj_token: 'X' } }), { wikiToken: 'DOC' }), /不是多维表格/);
console.log(`  signed in as ${signedIn.name}; wiki link parsed; non-Base wiki page rejected`);

step('user identity: wiki link, one refresh shared by concurrent syncs, writes as the user');
// As saved by the options page, with the access token already expired.
await chrome.storage.local.set({ larkUser: { ...signedIn, expiresAt: Date.now() - 1000 } });
await chrome.storage.local.set({ settings: { ...data.settings, larkAuthMode: 'user', larkBaseUrl: 'https://x.usttp.larksuite.com/wiki/WIKI?table=tblT' } });
const [userTest, userSync] = await Promise.all([sendOk('lark-test'), sendOk('lark-sync-now')]);
assert.equal(lark.refreshCalls, 1, 'one refresh for both');
assert.equal(userTest.records, lark.records.size);
assert.equal(userSync.created, 0);
assert.equal(lark.lastAuth, `Bearer ${lark.userAccess}`, 'requests use the user token');
assert.equal(data.larkUser.accessToken, lark.userAccess);
assert.equal(data.larkUser.refreshToken, lark.refreshToken, 'rotated refresh token saved');
await sendOk('lark-test');
assert.equal(lark.refreshCalls, 1, 'fresh token reused');
lark.failRead = { code: 91403, msg: 'Forbidden' };
const denied = await send('lark-test');
assert.match(denied.error, /你授权的 Lark 账号/);
lark.failRead = null;
console.log(`  refreshed once (${data.larkUser.accessToken}), ${userTest.records} records read via the wiki link; permission error: ${denied.error.slice(0, 30)}…`);

step('user identity: rejected refresh pauses sync, notifies once, no retries');
lark.refreshFail = true;
await chrome.storage.local.set({ larkUser: { ...data.larkUser, expiresAt: Date.now() - 1000 } });
const notesBefore = notifications.length;
run = await sendOk('check-now');
assert.match(run.lark.error, /授权已失效/);
assert.equal(data.larkUser.expired, true);
assert.equal(notifications.length, notesBefore + 1);
assert.match(notifications.at(-1).title, /授权已失效/);
const refreshesSoFar = lark.refreshCalls;
run = await sendOk('check-now');
assert.match(run.lark.error, /授权已失效/);
assert.equal(lark.refreshCalls, refreshesSoFar, 'no refresh once expired');
assert.equal(notifications.length, notesBefore + 1, 'notified once');
lark.refreshFail = false;
await chrome.storage.local.set({ larkUser: null });
assert.match((await send('lark-test')).error, /还没有用 Lark 账号授权/);
console.log('  error:', run.lark.error);

step('remove share');
await sendOk('remove-share', { shareId: data.shares[0].shareId });
assert.equal(data.shares.length, 0);
assert.equal(Object.keys(data.comments).length, 0);
assert.equal(badge, '');
console.log('  shares and comments cleared');

server.close();
larkServer.close();
console.log('\n✅ all checks passed');
