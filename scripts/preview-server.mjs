#!/usr/bin/env node
// Serves extension/ for a visual check of popup.html and options.html in a
// normal browser tab. A fake `chrome` API is injected, seeded with the share
// fetched by `node scripts/probe.mjs <url> --json` (out/share-*.json).
// Usage: node scripts/preview-server.mjs [port]

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { buildRows, formatTime } from '../extension/lib/rows.js';

const ROOT = new URL('../extension/', import.meta.url).pathname;
const PORT = Number(process.argv[2]) || 5179;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

async function seed() {
  const file = (await readdir('out').catch(() => [])).find((f) => /^share-.*\.json$/.test(f));
  if (!file) return {};
  const share = JSON.parse(await readFile(join('out', file), 'utf8'));
  const now = new Date();
  const rows = buildRows(share);
  const comments = {};
  rows.forEach((r, i) => {
    // Pretend the 6 most recent comments arrived in the latest check.
    comments[r.comment_id] = { ...r, first_seen_at: formatTime(now.toISOString()), synced_at: i % 3 ? formatTime(now.toISOString()) : null, removed: false };
  });
  const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6).map((r) => r.comment_id);
  return {
    shares: [{ shareId: share.shareId, url: `https://next.frame.io/share/${share.shareId}`, name: share.shareName, addedAt: now.toISOString(), lastOkAt: now.toISOString(), lastError: null }],
    comments,
    unseenIds: newest,
    lastRun: { startedAt: now.toISOString(), finishedAt: now.toISOString(), running: false, ok: true, error: null, newCount: newest.length, total: rows.length, pushed: 5, pushError: null },
    settings: {
      intervalMinutes: 180, notify: true, webhookUrl: 'https://example.feishu.cn/base/automation/webhook/event/xxxx', webhookToken: '', batchSize: 5, maxBatchesPerRun: 20, pushEnabled: true,
      larkAuthMode: 'user', larkAppId: 'cli_example', larkBaseUrl: 'https://example.larksuite.com/wiki/WIKI?table=tblExample',
    },
    larkUser: { name: '示例账号', appId: 'cli_example', apiBase: 'https://open.larksuite.com', expiresAt: now.getTime() + 3600e3, refreshExpiresAt: now.getTime() + 7 * 86400e3, expired: false },
  };
}

const MOCK = `
(() => {
  const seeded = fetch('/__seed.json').then((r) => r.json());
  const listeners = [];
  let data = null;
  const ready = () => seeded.then((s) => (data ??= s));
  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          await ready();
          const list = typeof keys === 'string' ? [keys] : keys ?? Object.keys(data);
          return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
        },
        async set(obj) {
          await ready();
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: v }; data[k] = structuredClone(v); }
          listeners.forEach((f) => f(changes, 'local'));
        },
      },
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    alarms: { async get() { return { scheduledTime: Date.now() + 3 * 3600e3 }; } },
    runtime: {
      async sendMessage(msg) {
        console.log('[mock] sendMessage', JSON.stringify(msg));
        // Mirror the background's unread-list handlers so the popup updates.
        if (msg.type === 'mark-read') {
          const read = new Set(msg.ids);
          await window.chrome.storage.local.set({ unseenIds: data.unseenIds.filter((id) => !read.has(id)) });
        }
        if (msg.type === 'clear-unseen') await window.chrome.storage.local.set({ unseenIds: [] });
        if (msg.type === 'mark-unread') await window.chrome.storage.local.set({ unseenIds: [...new Set([...data.unseenIds, ...msg.ids])] });
        return { ok: true, result: msg.type === 'add-share' ? { name: '示例分享' } : 0 };
      },
      openOptionsPage() { location.href = '/options.html'; },
    },
    identity: {
      getRedirectURL: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
      async launchWebAuthFlow() { throw new Error('预览里不能真正授权'); },
    },
    tabs: { create({ url }) { console.log('[mock] open tab', url); (window.__opened ??= []).push(url); } },
  };
})();
`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__mock.js') return res.writeHead(200, { 'content-type': TYPES['.js'] }).end(MOCK);
  if (url.pathname === '/__seed.json') return res.writeHead(200, { 'content-type': TYPES['.json'] }).end(JSON.stringify(await seed()));
  const path = normalize(join(ROOT, url.pathname === '/' ? 'popup.html' : url.pathname));
  if (!path.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    let body = await readFile(path);
    if (extname(path) === '.html') body = body.toString().replace('<head>', '<head>\n  <script src="/__mock.js"></script>');
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`preview on http://localhost:${PORT}/popup.html`));
