import { formatTime } from './lib/rows.js';
import { sortRows, toCsv } from './lib/csv.js';
import { getFrameGrabUrl } from './lib/frameio.js';
import * as store from './lib/store.js';

const $ = (id) => document.getElementById(id);
const send = (type, extra) => chrome.runtime.sendMessage({ type, ...extra });

if (new URLSearchParams(location.search).has('tab')) $('app').classList.add('tab');

const SWIPE_THRESHOLD = 0.35; // share of the row width that marks it read
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';

function liveRows(comments) {
  return Object.values(comments).filter((c) => !c.removed);
}

function markRead(ids) {
  return send('mark-read', { ids });
}

// ---------- thumbnails ----------
// Frame grabs from Frame.io (240 px wide). Signed URLs are cached in storage
// until shortly before they expire, so reopening the popup is instant.

const thumbMem = new Map(); // `${asset}:${frame}` → Promise<url | null>
let thumbSaves = Promise.resolve();
let thumbSlots = 3; // concurrent Frame.io renders
const thumbWaiters = [];

async function withThumbSlot(fn) {
  if (thumbSlots === 0) await new Promise((r) => thumbWaiters.push(r));
  thumbSlots--;
  try {
    return await fn();
  } finally {
    thumbSlots++;
    thumbWaiters.shift()?.();
  }
}

function saveThumb(key, entry) {
  thumbSaves = thumbSaves.then(async () => {
    const { thumbs = {} } = await chrome.storage.local.get('thumbs');
    const now = Date.now() / 1000;
    for (const [k, v] of Object.entries(thumbs)) if (v.exp < now) delete thumbs[k];
    thumbs[key] = entry;
    await chrome.storage.local.set({ thumbs });
  }).catch(() => {});
}

function thumbUrl(r) {
  const frame = r.thumb_frame ?? r.frame_start;
  if (frame == null || !r.asset_id) return Promise.resolve(null);
  const key = `${r.asset_id}:${frame}`;
  if (!thumbMem.has(key)) {
    thumbMem.set(key, (async () => {
      const { thumbs = {} } = await chrome.storage.local.get('thumbs');
      const hit = thumbs[key];
      if (hit && hit.exp * 1000 > Date.now() + 10 * 60_000) return hit.url;
      const url = `${await withThumbSlot(() => getFrameGrabUrl(r.share_id, r.asset_id, frame))}&width=240`;
      saveThumb(key, { url, exp: Number(new URL(url).searchParams.get('exp')) || 0 });
      return url;
    })().catch(() => null));
  }
  return thumbMem.get(key);
}

// ---------- swipe right to mark read ----------

// While a swipe is in progress the list is not rebuilt (a check writing
// progress would otherwise yank the row out from under the pointer).
let activeSwipes = 0;
let listDirty = false;
function beginSwipe() { activeSwipes++; }
function endSwipe() {
  activeSwipes = Math.max(0, activeSwipes - 1);
  if (!activeSwipes && listDirty) renderList();
}

// Trackpad momentum: after a swipe ends, macOS keeps sending decaying wheel
// events, and the row that slides under the cursor would catch them and get
// swiped too. So once a trackpad swipe ends, wheel swipes are locked until
// the trackpad is quiet for a moment, or the deltas start growing again
// (momentum only decays, a new gesture speeds up).
const WHEEL_QUIET_MS = 350;
const WHEEL_RELEASE_MS = 250;
const wheelLock = { on: false, lastAt: 0, prev: 0, rising: 0 };
document.addEventListener('wheel', (e) => {
  const now = performance.now();
  const mag = Math.abs(e.deltaX);
  if (wheelLock.on) {
    if (now - wheelLock.lastAt > WHEEL_QUIET_MS) wheelLock.on = false;
    else {
      wheelLock.rising = mag > wheelLock.prev && mag >= 1 ? wheelLock.rising + 1 : 0;
      if (wheelLock.rising >= 3) wheelLock.on = false;
    }
  }
  wheelLock.lastAt = now;
  wheelLock.prev = mag;
}, { capture: true, passive: true });
function lockWheel() {
  wheelLock.on = true;
  wheelLock.rising = 0;
  wheelLock.lastAt = performance.now();
}

// Drag right (mouse/touch) or two-finger swipe right (trackpad) on `row`.
// Past the threshold the row slides out, `collapseEl` folds away and
// `onDismiss` runs; otherwise the row snaps back.
function attachSwipe(wrap, row, bg, onDismiss, collapseEl = wrap) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let dragging = false;
  let wheelTimer = null;
  let byWheel = false;
  let done = false; // dismissed: ignore any further input
  const limit = () => wrap.clientWidth * SWIPE_THRESHOLD;

  const setX = (x, animate) => {
    row.style.transition = animate ? 'transform .2s ease' : 'none';
    row.style.transform = `translateX(${x}px)`;
    const progress = Math.min(1, x / limit());
    bg.style.opacity = String(progress);
    bg.classList.toggle('armed', progress >= 1);
  };

  const dismiss = () => {
    done = true;
    let collapsed = false;
    const collapse = () => {
      if (collapsed) return;
      collapsed = true;
      collapseEl.style.height = `${collapseEl.offsetHeight}px`;
      void collapseEl.offsetHeight; // commit the start height before animating
      collapseEl.classList.add('collapsing');
      collapseEl.style.height = '0px';
      setTimeout(onDismiss, 180);
    };
    row.addEventListener('transitionend', collapse, { once: true });
    setTimeout(collapse, 260); // in case transitionend never fires
    setX(wrap.clientWidth, true);
  };

  const release = () => {
    if (dx >= limit()) dismiss();
    else setX(0, true);
    if (byWheel) lockWheel();
    dx = 0;
    dragging = false;
    byWheel = false;
    endSwipe();
  };

  const start = () => {
    dragging = true;
    beginSwipe();
  };

  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || done) return;
    delete row.dataset.swiped;
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
  });
  row.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { tracking = false; return; } // vertical scroll
      if (mx < 6) return;
      start();
      try { row.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }
    dx = Math.max(0, mx);
    setX(dx, false);
  });
  row.addEventListener('pointerup', () => {
    tracking = false;
    if (!dragging) return;
    row.dataset.swiped = '1'; // swallow the click that follows the drag
    release();
  });
  row.addEventListener('pointercancel', () => {
    tracking = false;
    if (dragging) { dx = 0; release(); }
  });

  row.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    if (done || (wheelLock.on && !byWheel)) return;
    if (!dragging) { start(); byWheel = true; }
    dx = Math.max(0, dx - e.deltaX);
    setX(dx, false);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(release, WHEEL_RELEASE_MS);
  }, { passive: false });
}

// Wraps `row` in a swipe container with the "👁 已读" layer behind it.
function swipeable(row, onDismiss, collapseEl) {
  const wrap = document.createElement('div');
  wrap.className = 'swipe';
  const bg = document.createElement('div');
  bg.className = 'swipe-bg';
  bg.innerHTML = `${EYE}<span>已读</span>`;
  wrap.append(bg, row);
  attachSwipe(wrap, row, bg, onDismiss, collapseEl ?? wrap);
  return wrap;
}

// A click right after a drag is not a click.
function onClickNotDrag(el, fn) {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (el.dataset.swiped) { delete el.dataset.swiped; return; }
    fn(e);
  });
}

// ---------- the unread feed, grouped by video ----------

const expanded = new Set(); // asset ids opened in this popup session

const shortTime = (t) => (t ? t.slice(5, 16) : ''); // "MM-DD HH:mm"

function msgEl(r) {
  const a = document.createElement('a');
  a.className = 'msg';
  a.href = r.link;
  a.draggable = false;
  a.title = '点击打开（同时标为已读），向右滑动标为已读';

  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.draggable = false;
  thumbUrl(r).then((url) => {
    if (!url) return;
    img.onerror = () => img.removeAttribute('src');
    img.src = url;
  });

  const body = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('span');
  who.className = 'who';
  const name = document.createElement('b');
  name.textContent = r.author || '（匿名）';
  const tc = document.createElement('span');
  tc.className = 'tcode';
  tc.textContent = r.tc_end ? `${r.tc_start}–${r.tc_end}` : r.tc_start;
  who.append(name, ` ${r.kind === '回复' ? `回复 #${r.reply_to}` : '批注'} - `, tc, '：');
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = shortTime(r.created_at);
  head.append(who, when);
  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = r.text;
  body.append(head, text);
  a.append(img, body);

  onClickNotDrag(a, async () => {
    await markRead([r.comment_id]);
    chrome.tabs.create({ url: r.link });
  });
  return swipeable(a, () => markRead([r.comment_id]));
}

function groupEl(g) {
  const box = document.createElement('div');
  box.className = 'group';
  const open = expanded.has(g.assetId);
  box.classList.toggle('open', open);

  const head = document.createElement('div');
  head.className = 'group-head';
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.title = '点击展开 / 收起，向右滑动把这个视频的批注全部标为已读';
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▶';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = g.video;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${g.rows.length} 条新批注`;
  const where = document.createElement('span');
  where.className = 'where';
  where.textContent = [g.folder, g.shareName].filter(Boolean).join(' · ');
  head.append(chev, name, count, where);

  const body = document.createElement('div');
  body.className = 'group-body';
  body.hidden = !open;
  if (open) body.append(...g.rows.map(msgEl));

  const toggle = () => {
    if (expanded.has(g.assetId)) expanded.delete(g.assetId);
    else expanded.add(g.assetId);
    const nowOpen = expanded.has(g.assetId);
    box.classList.toggle('open', nowOpen);
    body.hidden = !nowOpen;
    if (nowOpen && !body.childElementCount) body.append(...g.rows.map(msgEl));
  };
  onClickNotDrag(head, toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  box.append(swipeable(head, () => markRead(g.rows.map((r) => r.comment_id)), box), body);
  return box;
}

// Videos with unread comments, most recent activity first; comments inside
// in timecode order with replies under their comment.
function groupByVideo(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.asset_id || r.video;
    if (!groups.has(key)) groups.set(key, { assetId: key, video: r.video, folder: r.folder, shareName: r.share_name, rows: [], latest: '' });
    const g = groups.get(key);
    g.rows.push(r);
    if (r.created_at > g.latest) g.latest = r.created_at;
  }
  for (const g of groups.values()) g.rows = sortRows(g.rows);
  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

async function renderList() {
  if (activeSwipes) { listDirty = true; return; }
  listDirty = false;
  const [comments, unseen] = await Promise.all([store.getComments(), store.getUnseen()]);
  const byId = new Map(liveRows(comments).map((r) => [r.comment_id, r]));
  const unread = unseen.map((id) => byId.get(id)).filter(Boolean);
  const list = $('list');
  $('read-all').hidden = unread.length === 0;
  $('list-hint').hidden = unread.length === 0;
  $('list-title').textContent = unread.length ? `未读批注（${unread.length}）` : '未读批注';
  if (!unread.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = '没有未读批注';
    list.replaceChildren(note);
    return;
  }
  list.replaceChildren(...groupByVideo(unread).map(groupEl));
}

// ---------- status ----------

async function renderStatus() {
  const [shares, comments, lastRun, settings, alarm] = await Promise.all([
    store.getShares(), store.getComments(), store.getLastRun(), store.getSettings(), chrome.alarms.get('poll'),
  ]);

  $('empty').hidden = shares.length > 0;
  $('main').hidden = shares.length === 0;
  if (!shares.length) return;

  const rows = liveRows(comments);
  $('n-shares').textContent = shares.length;
  $('n-comments').textContent = rows.length;
  const pending = rows.filter((r) => !r.synced_at).length;
  $('pending-wrap').hidden = !(settings.webhookUrl || settings.larkEnabled);
  $('n-pending').textContent = pending;

  const status = $('status');
  status.replaceChildren();
  const line = (text, cls = 'muted') => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    status.append(d);
  };
  if (lastRun?.running) {
    line(`正在检查…${lastRun.progress ? ` ${lastRun.progress}` : ''}`);
  } else if (lastRun?.finishedAt) {
    line(`上次检查：${formatTime(lastRun.finishedAt)}，新增 ${lastRun.newCount} 条`, lastRun.ok ? 'muted' : 'warn');
    if (lastRun.error) line(lastRun.error, 'err');
  } else {
    line('还没有检查过');
  }
  const lark = settings.larkEnabled ? lastRun?.lark : null;
  if (lark?.error) line(`飞书同步失败：${lark.error}`, 'err');
  else if (lark) {
    line(`飞书：上次新增 ${lark.created} 条，截图 ${lark.shots} 条${lark.shotsRemaining ? `，还有 ${lark.shotsRemaining} 条待截图` : ''}`, 'ok');
    if (lark.shotErrorCount) line(`${lark.shotErrorCount} 条截图失败：${lark.shotErrors[0]}`, 'warn');
    if (lark.skippedFields?.length) line(`飞书表里没有这些列，未写入：${lark.skippedFields.join('、')}`);
  }
  if (lastRun?.pushError) line(`飞书推送失败：${lastRun.pushError}`, 'err');
  else if (lastRun?.pushed) line(`上次已推送飞书 ${lastRun.pushed} 条`, 'ok');
  if (alarm && !lastRun?.running) line(`下次自动检查：${formatTime(new Date(alarm.scheduledTime).toISOString())}`);
  $('check').disabled = !!lastRun?.running;
}

// ---------- CSV ----------

function download(rows, suffix) {
  const stamp = formatTime(new Date().toISOString()).replace(/[-: ]/g, '').slice(0, 12);
  const blob = new Blob([toCsv(sortRows(rows))], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `frameio-批注-${suffix}-${stamp}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportCsv(onlyNew) {
  const rows = liveRows(await store.getComments());
  const { lastExportAt } = await chrome.storage.local.get('lastExportAt');
  const picked = onlyNew && lastExportAt ? rows.filter((r) => r.first_seen_at > lastExportAt) : rows;
  if (!picked.length) {
    alert('上次导出之后没有新批注');
    return;
  }
  download(picked, onlyNew && lastExportAt ? '新增' : '全部');
  await chrome.storage.local.set({ lastExportAt: formatTime(new Date().toISOString()) });
}

// ---------- wiring ----------

$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('add-first').onclick = () => chrome.runtime.openOptionsPage();
$('check').onclick = async () => {
  $('check').disabled = true;
  await send('check-now');
};
$('export-new').onclick = () => exportCsv(true);
$('export-all').onclick = () => exportCsv(false);
$('read-all').onclick = async () => {
  const n = (await store.getUnseen()).length;
  if (n > 5 && !confirm(`把 ${n} 条未读批注全部标为已读？`)) return;
  await send('clear-unseen');
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.thumbs && Object.keys(changes).length === 1) return;
  renderStatus();
  if (changes.unseenIds || changes.comments) renderList();
});
await Promise.all([renderStatus(), renderList()]);
