import { toTimecode } from './timecode.js';

// Column order for CSV export. `key` is also the field name sent to Feishu.
export const COLUMNS = [
  { key: 'share_name', label: '分享名称' },
  { key: 'folder', label: '文件夹' },
  { key: 'video', label: '视频' },
  { key: 'number', label: '编号' },
  { key: 'kind', label: '类型' },
  { key: 'reply_to', label: '回复对象' },
  { key: 'tc_start', label: '开始时间码' },
  { key: 'tc_end', label: '结束时间码' },
  { key: 'start_seconds', label: '开始秒数' },
  { key: 'author', label: '作者' },
  { key: 'text', label: '内容' },
  { key: 'created_at', label: '创建时间' },
  { key: 'edited_at', label: '编辑时间' },
  { key: 'completed', label: '已完成' },
  { key: 'link', label: '视频链接' },
  { key: 'first_seen_at', label: '首次抓取时间' },
  { key: 'comment_id', label: '批注ID' },
];

const BEIJING = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

// "2026-09-28 22:35:00" in Beijing time.
export function formatTime(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(BEIJING.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function videoLink(shareId, assetId) {
  return `https://next.frame.io/share/${shareId}/view/${assetId}`;
}

const seconds = (c) => (c.timestampMicroseconds != null ? c.timestampMicroseconds / 1e6 : null);

// Frame index the player uses for a time; clamped to the last frame.
function frameAt(sec, file) {
  if (sec == null || !file.fps) return null;
  const f = Math.floor(sec * file.fps + 1e-6);
  return file.frames ? Math.min(f, file.frames - 1) : f;
}

function toRow(share, file, c, parent, pos = 0) {
  const head = parent || c;
  // Replies carry no timestamp of their own; show the thread's timecode.
  const timed = seconds(c) != null ? c : head;
  const start = seconds(timed);
  const hasRange = start != null && timed.duration > 0;
  const page = c.documentPageNumber ?? head.documentPageNumber;
  const edited = c.editedAt && c.insertedAt && c.editedAt > c.insertedAt;
  return {
    comment_id: c.id,
    share_id: share.shareId,
    asset_id: file.id,
    share_name: share.shareName,
    folder: file.folder,
    video: file.name,
    number: c.number ?? '',
    kind: parent ? '回复' : '批注',
    reply_to: parent?.number ?? '',
    tc_start: page ? `第 ${page} 页` : toTimecode(start, file.fps),
    tc_end: hasRange ? toTimecode(start + timed.duration, file.fps) : '',
    start_seconds: start != null ? Math.round(start * 1000) / 1000 : '',
    author: c.owner?.name ?? '',
    text: c.text ?? '',
    created_at: formatTime(c.insertedAt),
    edited_at: edited ? formatTime(c.editedAt) : '',
    completed: c.completed ? '是' : '否',
    link: videoLink(share.shareId, file.id),
    // Sort keys that keep a thread together: parent start, parent number, position.
    thread_start: seconds(head) ?? 0,
    thread_no: head.number ?? 0,
    thread_pos: pos,
    // Frames to screenshot: top-level video comments only (a reply shares its
    // parent's moment); the end frame only for time ranges.
    frame_start: parent || page ? null : frameAt(start, file),
    frame_end: parent || page || !hasRange ? null : frameAt(start + timed.duration, file),
    // Thumbnail in the popup; a reply shows its comment's frame.
    thumb_frame: page ? null : frameAt(start, file),
  };
}

// One row per comment and one per reply, replies right after their parent.
// Files that failed to load are skipped (see `failedAssetIds`).
export function buildRows(share) {
  const rows = [];
  for (const file of share.files) {
    if (!file.comments) continue;
    for (const c of file.comments) {
      rows.push(toRow(share, file, c));
      (c.replies || []).forEach((r, i) => rows.push(toRow(share, file, r, c, i + 1)));
    }
  }
  return rows;
}

export function failedAssetIds(share) {
  return share.files.filter((f) => !f.comments).map((f) => f.id);
}
