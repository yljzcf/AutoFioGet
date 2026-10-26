#!/usr/bin/env node
// Syncs one or more Frame.io shares into a Lark / Feishu Base with the same
// code the extension uses (extension/lib/lark.js), sending requests through
// lark-cli instead of an app token. Creates missing records (matched by
// 批注ID), updates edited ones and attaches screenshots. Safe to re-run.
// Usage:
//   node scripts/sync-lark.mjs <share-url> [...] --base <base-or-wiki-url> [--as user|bot] [--max-shots N] [--dry-run]

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fetchShare, resolveShareUrl } from '../extension/lib/frameio.js';
import { buildRows, formatTime } from '../extension/lib/rows.js';
import { sortRows } from '../extension/lib/csv.js';
import { LarkError, parseBaseUrl, readIndex, readSchema, resolveBaseToken, resolveTable, rowToRecord, syncToLark } from '../extension/lib/lark.js';

const run = promisify(execFile);
const opts = { as: 'user', 'max-shots': 'Infinity' };
const shareUrls = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
  else shareUrls.push(a);
}
const target = parseBaseUrl(opts.base);
if (!shareUrls.length || !target) {
  console.error('用法: node scripts/sync-lark.mjs <分享链接> [...] --base <多维表格链接> [--as user|bot] [--max-shots N] [--dry-run]');
  process.exit(1);
}

const TMP = 'out/tmp';
await mkdir(TMP, { recursive: true });

// `call` for lib/lark.js, backed by `lark-cli api` (paths must be relative).
async function call(method, path, { params, body, form } = {}) {
  const args = ['api', method, path, '--as', opts.as];
  const temp = [];
  if (params) args.push('--params', JSON.stringify(params));
  if (form) {
    const { file, ...fields } = form;
    const f = `${TMP}/${randomUUID()}.jpg`;
    await writeFile(f, file);
    temp.push(f);
    args.push('--data', JSON.stringify(fields), '--file', `file=${f}`);
  } else if (body) {
    const f = `${TMP}/${randomUUID()}.json`;
    await writeFile(f, JSON.stringify(body));
    temp.push(f);
    args.push('--data', `@${f}`);
  }
  let stdout;
  try {
    ({ stdout } = await run('lark-cli', args, {
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (e) {
    stdout = e.stdout;
  } finally {
    await Promise.all(temp.map((f) => rm(f, { force: true })));
  }
  let json;
  try { json = JSON.parse(stdout); } catch { throw new LarkError(`lark-cli 输出无法解析: ${String(stdout).slice(0, 200)}`); }
  if (json.ok !== true) throw new LarkError(json.error?.message || 'lark-cli 调用失败', json.error?.code);
  return json.data;
}

const now = formatTime(new Date().toISOString());
const rows = [];
for (const url of shareUrls) {
  const parsed = await resolveShareUrl(url);
  if (!parsed) throw new Error(`无法识别的分享链接: ${url}`);
  const share = await fetchShare(parsed.shareId);
  const failed = share.files.filter((f) => f.error).length;
  console.log(`分享「${share.shareName}」：${buildRows(share).length} 条${failed ? `（${failed} 个文件读取失败，已跳过）` : ''}`);
  rows.push(...buildRows(share).map((r) => ({ ...r, first_seen_at: now })));
}
const sorted = sortRows(rows);
const baseToken = await resolveBaseToken(call, target);
const tableId = await resolveTable(call, { ...target, baseToken });

if (opts.dryRun) {
  const { fields, skipped } = await readSchema(call, baseToken, tableId);
  const index = await readIndex(call, baseToken, tableId);
  const missing = sorted.filter((r) => !index.has(r.comment_id));
  const noShot = sorted.filter((r) => r.frame_start != null && index.get(r.comment_id) && !index.get(r.comment_id).hasShot);
  console.log(`表里已有 ${index.size} 条；将新增 ${missing.length} 条；待截图 ${noShot.length + missing.filter((r) => r.frame_start != null).length} 条`);
  if (skipped.length) console.log(`表里没有这些列，不会写入：${skipped.join('、')}`);
  if (missing.length) console.log('第一条将写入:', JSON.stringify(rowToRecord(missing[0], fields), null, 2));
  process.exit(0);
}

const t0 = Date.now();
const result = await syncToLark(call, {
  baseToken,
  tableId,
  rows: sorted,
  maxShots: Number(opts['max-shots']),
  onProgress: (p) => process.stderr.write(`\r  ${p}        `),
});
process.stderr.write('\n');
console.log(`完成（${Math.round((Date.now() - t0) / 1000)}s）：新增 ${result.created}，更新 ${result.updated}，截图 ${result.shots}，剩余待截图 ${result.shotsRemaining}`);
if (result.skippedFields.length) console.log(`表里没有这些列，未写入：${result.skippedFields.join('、')}`);
if (result.shotErrors.length) console.log(`截图失败 ${result.shotErrors.length} 条：\n  ${result.shotErrors.slice(0, 10).join('\n  ')}`);
