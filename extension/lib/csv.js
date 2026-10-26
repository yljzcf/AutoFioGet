import { COLUMNS } from './rows.js';

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// UTF-8 with BOM and CRLF so Excel opens Chinese text correctly.
export function toCsv(rows, columns = COLUMNS) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// Same order as the Frame.io panel: share, folder, video, timecode; replies
// stay under their comment.
export function sortRows(rows) {
  const text = (a, b) => (a || '').localeCompare(b || '', 'zh-CN', { numeric: true });
  return [...rows].sort((a, b) =>
    text(a.share_name, b.share_name) ||
    text(a.folder, b.folder) ||
    text(a.video, b.video) ||
    a.thread_start - b.thread_start ||
    a.thread_no - b.thread_no ||
    a.thread_pos - b.thread_pos,
  );
}
