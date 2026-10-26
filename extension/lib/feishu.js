// Pushes rows to a Feishu / Lark Bitable workflow that starts with the
// "接收到 webhook 时" trigger. Body: { source, sent_at, count, items: [...] };
// the workflow loops over `items` and adds one record per item.
//
// Limits (Feishu help center): 1 request/s per workflow without a Bearer
// token (5/s with one), 4 MB body, and a per-plan cap on loop iterations
// (5 / 100 / 1000) — hence the configurable batch size.

import { COLUMNS } from './rows.js';

const GAP_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toItem(row) {
  const item = {};
  for (const { key } of COLUMNS) item[key] = row[key] ?? '';
  // Numbers stay numbers so they can map to Bitable number fields.
  item.number = row.number === '' || row.number == null ? 0 : Number(row.number);
  item.reply_to = row.reply_to === '' || row.reply_to == null ? 0 : Number(row.reply_to);
  item.start_seconds = row.start_seconds === '' || row.start_seconds == null ? 0 : Number(row.start_seconds);
  return item;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function postBatch(rows, { webhookUrl, webhookToken }) {
  const headers = { 'content-type': 'application/json' };
  if (webhookToken) headers.authorization = `Bearer ${webhookToken}`;
  // Same batch → same token, so a retry after a lost response is not run twice
  // (Feishu ignores a repeated Client-Token for 3 hours).
  headers['client-token'] = (await sha256Hex(rows.map((r) => r.comment_id).join(','))).slice(0, 32);
  const body = { source: 'frameio-comments', sent_at: new Date().toISOString(), count: rows.length, items: rows.map(toItem) };
  let res;
  try {
    res = await fetch(webhookUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, error: `网络错误：${e.message}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (res.ok && json && json.code === 0) return { ok: true };
  const msg = json?.msg || `HTTP ${res.status}`;
  return { ok: false, error: json?.code ? `${msg}（错误码 ${json.code}）` : msg, code: json?.code };
}

// Sends rows in batches, oldest first. `onBatchDone(ids)` runs after each
// accepted batch so progress survives an interrupted run. Stops at the first
// failure; the rest stay unsynced for the next run.
export async function pushRows(rows, { webhookUrl, webhookToken, batchSize = 5, maxBatches = Infinity, onBatchDone }) {
  const size = Math.max(1, Number(batchSize) || 5);
  let pushed = 0;
  let batches = 0;
  for (let i = 0; i < rows.length && batches < maxBatches; i += size) {
    if (batches > 0) await sleep(GAP_MS);
    const batch = rows.slice(i, i + size);
    let result = await postBatch(batch, { webhookUrl, webhookToken });
    if (!result.ok && result.code === 800005652) { // rate limited
      await sleep(5000);
      result = await postBatch(batch, { webhookUrl, webhookToken });
    }
    if (!result.ok) return { pushed, remaining: rows.length - pushed, error: result.error };
    batches++;
    pushed += batch.length;
    await onBatchDone?.(batch.map((r) => r.comment_id));
  }
  return { pushed, remaining: rows.length - pushed, error: null };
}

// One fake comment, for "通过发送请求设置" when building the workflow.
export function sampleRow() {
  return {
    comment_id: `sample-${Date.now()}`, // unique, so Client-Token never dedups a test
    share_name: '示例分享',
    folder: '1st Delivery',
    video: 'EXAMPLE_EP01_v01.mov',
    number: 1,
    kind: '批注',
    reply_to: '',
    tc_start: '00:00:12:05',
    tc_end: '00:00:15:00',
    start_seconds: 12.2,
    author: '示例作者',
    text: '这是一条测试批注，用来让飞书生成请求体结构。',
    created_at: '2026-01-01 10:00:00',
    edited_at: '',
    completed: '否',
    link: 'https://next.frame.io/share/00000000-0000-0000-0000-000000000000/view/00000000-0000-0000-0000-000000000000',
    first_seen_at: '2026-01-01 10:05:00',
  };
}
