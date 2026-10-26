// Sync to a Lark / Feishu Base through the Base v3 OpenAPI (the endpoints
// lark-cli uses). Unlike the webhook, this can upload screenshots, dedupes by
// 批注ID against the table itself, and updates edited comments.
//
// Every function takes `call(method, path, { params, body, form })`, which
// sends one request and returns the response's `data` (throwing LarkError
// when `code` is not 0). The extension uses fetchTransport() with the app's
// tenant token or a signed-in user's token (lib/oauth.js);
// scripts/sync-lark.mjs goes through lark-cli instead.

import { COLUMNS } from './rows.js';
import { toItem } from './feishu.js';
import { fetchFrame, mapLimit } from './frameio.js';

export const SHOT_FIELD = '截图';
const ID_FIELD = '批注ID';
const WRITE_BATCH = 200;
// New records per create call; their screenshots are rendered first.
const CREATE_BATCH = 20;
const SHOT_CONCURRENCY = 3;

// Other names a column may have in the table.
const ALIASES = { author: ['批注者'] };
// Columns that follow edits in Frame.io.
const UPDATE_KEYS = ['text', 'edited_at', 'completed'];
// The API can't add options to a single select, so only columns with a fixed
// set of values may be one; a new author would fail the whole batch.
const SELECT_KEYS = new Set(['kind', 'completed']);

// toItem() value → cell value, per Base field type. Columns whose field has
// another type (formula, datetime, …) are left out instead of failing the write.
const WRITERS = {
  text: (v) => String(v),
  number: (v) => Number(v),
  select: (v) => [String(v)],
  checkbox: (v) => v === '是',
};

// Used when the table's fields can't be read: the layout the README describes.
const DEFAULT_TYPES = { number: 'number', reply_to: 'number', start_seconds: 'number', kind: 'select', completed: 'select' };
export const DEFAULT_FIELDS = Object.fromEntries(COLUMNS.map(({ key, label }) => [key, { name: label, type: DEFAULT_TYPES[key] || 'text' }]));

export class LarkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LarkError';
    this.code = code;
  }
}

// `asUser`: the request was made with a signed-in user's token, so access is
// the user's (shared to them as a collaborator), not the app's.
function describe(json, asUser) {
  const msg = json.msg || json.message || `错误码 ${json.code}`;
  if (json.code === 99991672 || json.code === 99991679 || /scope/i.test(msg)) {
    return asUser ? `授权缺少权限：请确认应用已开通并发布这些用户权限，再在设置页重新授权：${msg}`
      : `应用缺少权限，请在开发者后台开通并发布新版本：${msg}`;
  }
  if (json.code === 91403 || json.code === 1254302 || /forbidden|permission/i.test(msg)) {
    return asUser ? `你授权的 Lark 账号没有这个多维表格的编辑权限，请让表格所有者把它加为协作者（可编辑）：${msg}`
      : `应用没有这个多维表格的编辑权限，请把应用添加为协作者：${msg}`;
  }
  return `${msg}（错误码 ${json.code}）`;
}

// A Base link → API host, table and either the base token
// (…/base/<token>?table=tbl…) or a wiki node (…/wiki/<token>?table=tbl…, a
// Base inside a knowledge base; resolveBaseToken() looks it up).
export function parseBaseUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  const m = u.pathname.match(/\/(base|wiki)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const apiBase = /(^|\.)larksuite\.com$/.test(u.hostname) ? 'https://open.larksuite.com'
    : /(^|\.)feishu\.cn$/.test(u.hostname) ? 'https://open.feishu.cn' : null;
  const tableId = u.searchParams.get('table');
  return m[1] === 'wiki' ? { apiBase, wikiToken: m[2], tableId } : { apiBase, baseToken: m[2], tableId };
}

// The base token of a parsed link; a wiki node must be a Base.
export async function resolveBaseToken(call, { baseToken, wikiToken }) {
  if (baseToken) return baseToken;
  const { node } = await call('GET', '/open-apis/wiki/v2/spaces/get_node', { params: { token: wikiToken } });
  if (node?.obj_type !== 'bitable') throw new LarkError('这个知识库页面不是多维表格，请打开那张多维表格再复制链接');
  return node.obj_token;
}

// → async () => the app's tenant access token, cached until shortly before it expires.
export function tenantToken({ apiBase, appId, appSecret }) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const res = await fetch(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const json = await res.json();
    if (json.code !== 0) throw new LarkError(`获取应用凭证失败，请检查 App ID / App Secret：${json.msg}`, json.code);
    cached = { value: json.tenant_access_token, expiresAt: Date.now() + json.expire * 1000 };
    return cached.value;
  };
}

// `token`: tenantToken() or oauth.js userToken() (then `asUser` is true).
export function fetchTransport({ apiBase, token, asUser = false }) {
  return async (method, path, { params, body, form } = {}) => {
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(params || {})) for (const x of [].concat(v)) url.searchParams.append(k, x);
    const headers = { authorization: `Bearer ${await token()}` };
    let payload;
    if (form) {
      payload = new FormData();
      const { file, ...fields } = form;
      for (const [k, v] of Object.entries(fields)) payload.append(k, v);
      payload.append('file', new Blob([file], { type: 'image/jpeg' }), fields.file_name);
    } else if (body) {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    let json;
    try { json = await res.json(); } catch { throw new LarkError(`Lark 返回了非 JSON 响应（HTTP ${res.status}）`); }
    if (json.code !== 0) throw new LarkError(describe(json, asUser), json.code);
    return json.data;
  };
}

// Table ID from the link, else the table named 批注, else the only table.
export async function resolveTable(call, { baseToken, tableId }) {
  if (tableId) return tableId;
  const { tables = [] } = await call('GET', `/open-apis/base/v3/bases/${baseToken}/tables`, { params: { limit: 300, offset: 0 } });
  const t = tables.find((x) => x.name === '批注') || (tables.length === 1 ? tables[0] : null);
  if (!t) throw new LarkError('找不到数据表：请在多维表格链接里带上 ?table=…，或把表命名为「批注」');
  return t.id;
}

// Which field each column is written to. Writing a field the table doesn't
// have fails the whole batch (not_found, 800030201), e.g. after a column is
// renamed, so the table's own fields are read first; a record read lists
// them without needing base:field:read.
// → { fields: { key → { name, type } }, skipped: [column labels not written] }
export async function readSchema(call, baseToken, tableId) {
  const d = await call('GET', `/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/records`, { params: { limit: 1, offset: 0 } });
  const names = d.fields || [];
  if (!names.length) return { fields: DEFAULT_FIELDS, skipped: [] };
  const types = new Map(names.map((n, i) => [n, d.field_type_list?.[i]]));
  const fields = {};
  const skipped = [];
  for (const { key, label } of COLUMNS) {
    const name = [label, ...(ALIASES[key] || [])].find((n) => types.has(n));
    const type = types.get(name);
    if (!name) skipped.push(label);
    else if (type === 'select' && !SELECT_KEYS.has(key)) skipped.push(`${name}（单选列无法自动新增选项，请改成文本）`);
    else if (!WRITERS[type]) skipped.push(`${name}（${type} 类型不支持）`);
    else fields[key] = { name, type };
  }
  if (!fields.comment_id) throw new LarkError(`数据表里缺少「${ID_FIELD}」字段`);
  return { fields, skipped };
}

const isEmpty = (v) => v === '' || v == null || (Array.isArray(v) && v.length === 0);

// comment_id → { recordId, hasShot, cells: { key → cell } } where `cells`
// holds the UPDATE_KEYS columns the table has.
export async function readIndex(call, baseToken, tableId, fields = {}) {
  const tracked = UPDATE_KEYS.filter((k) => fields[k]);
  const want = [ID_FIELD, SHOT_FIELD, ...tracked.map((k) => fields[k].name)];
  const index = new Map();
  for (let offset = 0; ; offset += WRITE_BATCH) {
    const d = await call('GET', `/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/records`, {
      params: { field_id: want, limit: WRITE_BATCH, offset },
    });
    const col = (n) => d.fields.indexOf(n);
    for (const n of [ID_FIELD, SHOT_FIELD]) if (col(n) < 0) throw new LarkError(`数据表里缺少「${n}」字段`);
    d.data.forEach((cells, i) => {
      const id = cells[col(ID_FIELD)];
      if (!id) return;
      const shot = cells[col(SHOT_FIELD)];
      index.set(id, {
        recordId: d.record_id_list[i],
        hasShot: Array.isArray(shot) && shot.length > 0,
        cells: Object.fromEntries(tracked.map((k) => [k, cells[col(fields[k].name)] ?? null])),
      });
    });
    if (!d.has_more) return index;
  }
}

// Same values the webhook sends, keyed by the table's field names.
export function rowToRecord(row, fields = DEFAULT_FIELDS) {
  const item = toItem(row);
  const rec = {};
  for (const [key, { name, type }] of Object.entries(fields)) {
    if (!isEmpty(item[key])) rec[name] = WRITERS[type](item[key]);
  }
  return rec;
}

// The edit-tracking cells `row` should have, or null where it should be empty.
function updateCells(row, fields) {
  const item = toItem(row);
  const out = {};
  for (const k of UPDATE_KEYS) if (fields[k]) out[k] = isEmpty(item[k]) ? null : WRITERS[fields[k].type](item[k]);
  return out;
}

const sameCell = (have, want) => JSON.stringify(isEmpty(have) ? null : have) === JSON.stringify(want);

// Width/height from a baseline or progressive JPEG header.
export function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

function shotName(row, which) {
  const tc = (which === 'end' ? row.tc_end : row.tc_start).replace(/:/g, '-');
  return `${row.video.replace(/\.[^.]+$/, '')}_#${row.number}_${tc}.jpg`;
}

// Writes to one table must not overlap (Lark rejects concurrent writes).
function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// Renders a row's frame(s) and uploads them to the Base → 截图 cell value.
async function uploadShots(call, baseToken, r) {
  const attachments = [];
  for (const [which, frame] of [['start', r.frame_start], ['end', r.frame_end]]) {
    if (frame == null) continue;
    const bytes = await fetchFrame(r.share_id, r.asset_id, frame);
    const file_name = shotName(r, which);
    const up = await call('POST', '/open-apis/drive/v1/medias/upload_all', {
      form: { file_name, parent_type: 'bitable_file', parent_node: baseToken, size: String(bytes.length), file: bytes },
    });
    const size = jpegSize(bytes);
    attachments.push({ file_token: up.file_token, ...(size && { image_width: size.width, image_height: size.height }) });
  }
  return attachments;
}

// Creates missing records, updates edited ones and attaches up to `maxShots`
// screenshots. Returns counts plus the ids now in the table.
export async function syncToLark(call, { baseToken, tableId, rows, maxShots = 100, onProgress }) {
  const base = `/open-apis/base/v3/bases/${baseToken}/tables/${tableId}`;
  const write = serial();
  const { fields, skipped } = await readSchema(call, baseToken, tableId);
  const index = await readIndex(call, baseToken, tableId, fields);

  const missing = rows.filter((r) => !index.has(r.comment_id));
  const isNew = new Set(missing.map((r) => r.comment_id));
  const lacksShot = (r) => r.frame_start != null && index.has(r.comment_id) && !index.get(r.comment_id).hasShot;
  // Screenshots this run: new records first, then older ones still without.
  const shotQueue = [...missing.filter((r) => r.frame_start != null), ...rows.filter(lacksShot)].slice(0, maxShots);
  const queued = new Set(shotQueue.map((r) => r.comment_id));
  let shots = 0;
  let tried = 0;
  const shotErrors = [];
  // Uploads `r`'s screenshots and hands them to `use`; a failure is recorded
  // and leaves the record without one until a later run.
  async function shoot(r, use) {
    try {
      await use(await uploadShots(call, baseToken, r));
      shots++;
    } catch (e) {
      shotErrors.push(`${r.video} #${r.number}：${e.message}`);
    }
    await onProgress?.(`截图 ${++tried}/${shotQueue.length}`);
  }

  // New records are created with their screenshots already in place, so an
  // automation that fires on "record added" can show them. Small batches keep
  // records flowing while frames render (2–4 s each).
  for (let i = 0; i < missing.length; i += CREATE_BATCH) {
    const batch = missing.slice(i, i + CREATE_BATCH);
    const attached = new Map();
    await mapLimit(batch.filter((r) => queued.has(r.comment_id)), SHOT_CONCURRENCY,
      (r) => shoot(r, async (cell) => attached.set(r.comment_id, cell)));
    const create_records = batch.map((r) => {
      const rec = rowToRecord(r, fields);
      if (attached.has(r.comment_id)) rec[SHOT_FIELD] = attached.get(r.comment_id);
      return rec;
    });
    const d = await write(() => call('POST', `${base}/records/batch_create`, { body: { create_records } }));
    (d.record_id_list || []).forEach((recordId, j) => index.set(batch[j].comment_id, { recordId, hasShot: attached.has(batch[j].comment_id) }));
    await onProgress?.(`写入飞书 ${Math.min(i + CREATE_BATCH, missing.length)}/${missing.length}`);
  }

  // Records created above have no `cells` and need no update.
  const changed = rows.filter((r) => {
    const e = index.get(r.comment_id);
    if (!e?.cells) return false;
    const want = updateCells(r, fields);
    return Object.keys(want).some((k) => !sameCell(e.cells[k], want[k]));
  });
  for (let i = 0; i < changed.length; i += WRITE_BATCH) {
    const update_records = {};
    for (const r of changed.slice(i, i + WRITE_BATCH)) {
      const want = updateCells(r, fields);
      update_records[index.get(r.comment_id).recordId] = Object.fromEntries(Object.entries(want).map(([k, v]) => [fields[k].name, v]));
    }
    await write(() => call('POST', `${base}/records/batch_update`, { body: { update_records } }));
  }

  // Older records still without a screenshot get one appended.
  await mapLimit(shotQueue.filter((r) => !isNew.has(r.comment_id)), SHOT_CONCURRENCY, (r) => shoot(r, async (attachments) => {
    const { recordId } = index.get(r.comment_id);
    await write(() => call('POST', `${base}/append_attachments`, { body: { attachments: { [recordId]: { [SHOT_FIELD]: attachments } } } }));
    index.get(r.comment_id).hasShot = true;
  }));

  return {
    created: missing.length,
    updated: changed.length,
    shots,
    shotsRemaining: rows.filter(lacksShot).length,
    shotErrors,
    skippedFields: skipped,
    syncedIds: rows.filter((r) => index.has(r.comment_id)).map((r) => r.comment_id),
  };
}
