#!/usr/bin/env node
// Fetch every comment from one or more Frame.io share links and write a CSV.
// Usage: node scripts/probe.mjs <share-url> [<share-url> ...] [--json]

import { mkdir, writeFile } from 'node:fs/promises';
import { fetchShare, resolveShareUrl } from '../extension/lib/frameio.js';
import { buildRows, failedAssetIds } from '../extension/lib/rows.js';
import { sortRows, toCsv } from '../extension/lib/csv.js';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const urls = args.filter((a) => !a.startsWith('--'));
if (!urls.length) {
  console.error('用法: node scripts/probe.mjs <分享链接> [...] [--json]');
  process.exit(1);
}

await mkdir('out', { recursive: true });
const allRows = [];
for (const url of urls) {
  const parsed = await resolveShareUrl(url);
  if (!parsed) {
    console.error(`无法识别的分享链接: ${url}`);
    process.exitCode = 1;
    continue;
  }
  const t0 = Date.now();
  const share = await fetchShare(parsed.shareId, {
    onProgress: ({ done, total }) => process.stderr.write(`\r  ${done}/${total} 个文件`),
  });
  process.stderr.write('\n');
  const rows = buildRows(share);
  allRows.push(...rows);

  const folders = new Set(share.files.map((f) => f.folder));
  const authors = {};
  for (const r of rows) authors[r.author] = (authors[r.author] || 0) + 1;
  console.log(`分享: ${share.shareName} (${parsed.shareId})`);
  console.log(`  文件夹 ${folders.size}，文件 ${share.files.length}，批注 ${rows.filter((r) => r.kind === '批注').length}，回复 ${rows.filter((r) => r.kind === '回复').length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  作者: ${Object.entries(authors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，')}`);
  const failed = failedAssetIds(share);
  if (failed.length) console.log(`  ⚠️ ${failed.length} 个文件的批注没取到: ${share.files.filter((f) => f.error).map((f) => `${f.name}: ${f.error}`).join('; ')}`);
  if (wantJson) await writeFile(`out/share-${parsed.shareId}.json`, JSON.stringify(share, null, 2));
}

const file = 'out/comments.csv';
await writeFile(file, toCsv(sortRows(allRows)));
console.log(`已写出 ${allRows.length} 行 → ${file}`);
