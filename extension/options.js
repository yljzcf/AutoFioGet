import { formatTime } from './lib/rows.js';
import { parseBaseUrl } from './lib/lark.js';
import { USER_SCOPES, authorizeUrl, codeFromRedirect, exchangeCode } from './lib/oauth.js';
import * as store from './lib/store.js';

const $ = (id) => document.getElementById(id);

async function send(type, extra) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || '后台没有响应');
  return res.result;
}

function setStatus(el, text, cls = 'muted') {
  el.className = `small ${cls}`;
  el.textContent = text;
}

// ---------- shares ----------

async function renderShares() {
  const [shares, comments] = await Promise.all([store.getShares(), store.getComments()]);
  const counts = {};
  for (const c of Object.values(comments)) if (!c.removed) counts[c.share_id] = (counts[c.share_id] || 0) + 1;
  const box = $('shares');
  if (!shares.length) {
    box.innerHTML = '<p class="muted small">还没有分享链接。</p>';
    return;
  }
  box.replaceChildren(...shares.map((s) => {
    const row = document.createElement('div');
    row.className = 'share';
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.innerHTML = '<b></b> <span class="muted small"></span>';
    name.querySelector('b').textContent = s.name || '(未命名分享)';
    name.querySelector('span').textContent = `${counts[s.shareId] || 0} 条批注/回复`;
    const link = document.createElement('a');
    link.className = 'small';
    link.href = s.url.startsWith('http') ? s.url : `https://next.frame.io/share/${s.shareId}`;
    link.target = '_blank';
    link.textContent = link.href;
    const state = document.createElement('div');
    state.className = 'small';
    if (s.lastError) setStatus(state, `上次检查失败：${s.lastError}`, 'err');
    else if (s.lastOkAt) setStatus(state, `上次成功：${formatTime(s.lastOkAt)}`);
    else setStatus(state, '等待首次检查…');
    info.append(name, link, state);
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.onclick = async () => {
      if (!confirm(`删除「${s.name}」？本地保存的这个分享的批注也会一起删掉（已推送到飞书的不受影响）。`)) return;
      del.disabled = true;
      await send('remove-share', { shareId: s.shareId });
    };
    row.append(info, del);
    return row;
  }));
}

$('add-form').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('share-url').value.trim();
  if (!url) return;
  $('add-btn').disabled = true;
  setStatus($('add-status'), '正在校验链接…');
  try {
    const { name } = await send('add-share', { url });
    setStatus($('add-status'), `已添加「${name}」，正在抓取批注…`, 'ok');
    $('share-url').value = '';
  } catch (err) {
    setStatus($('add-status'), err.message, 'err');
  } finally {
    $('add-btn').disabled = false;
  }
};

$('demo-unread').onclick = async () => {
  const rows = Object.values(await store.getComments()).filter((c) => !c.removed);
  const ids = rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10).map((r) => r.comment_id);
  if (!ids.length) {
    setStatus($('demo-status'), '还没有抓到批注', 'warn');
    return;
  }
  await send('mark-unread', { ids });
  setStatus($('demo-status'), `已把 ${ids.length} 条设为未读，点工具栏图标打开弹窗试试`, 'ok');
};

// ---------- schedule ----------

async function saveSchedule() {
  await store.saveSettings({ intervalMinutes: Number($('interval').value), notify: $('notify').checked });
  await send('settings-changed');
}
$('interval').onchange = saveSchedule;
$('notify').onchange = saveSchedule;

// ---------- Lark / Feishu app ----------

const LARK_SCOPES = ['base:table:read', 'base:record:read', 'base:record:create', 'base:record:update', 'docs:document.media:upload'];

function readLarkForm() {
  return {
    larkAuthMode: document.querySelector('input[name=lark-mode]:checked')?.value || 'app',
    larkAppId: $('lark-app-id').value.trim(),
    larkAppSecret: $('lark-app-secret').value.trim(),
    larkBaseUrl: $('lark-base-url').value.trim(),
    maxShotsPerRun: Math.max(0, Number($('max-shots').value) || 0),
    larkEnabled: $('lark-enabled').checked,
  };
}

// Open platform host of the Base in the form (Lark unless it is a feishu.cn link).
const apiBaseOf = (form) => parseBaseUrl(form.larkBaseUrl)?.apiBase || 'https://open.larksuite.com';

function updateLarkLinks() {
  const form = readLarkForm();
  const host = apiBaseOf(form);
  const id = encodeURIComponent(form.larkAppId);
  const links = [[$('scope-link'), LARK_SCOPES, null], [$('scope-link-user'), USER_SCOPES, null], [$('safe-link'), null, 'safe']];
  for (const [link, scopes, page] of links) {
    if (!form.larkAppId) link.removeAttribute('href');
    else link.href = scopes ? `${host}/page/scope-apply?clientID=${id}&scopes=${encodeURIComponent(scopes.join(','))}` : `${host}/app/${id}/${page}`;
  }
  const asUser = form.larkAuthMode === 'user';
  $('user-auth').hidden = !asUser;
  $('steps-user').hidden = !asUser;
  $('steps-app').hidden = asUser;
  renderLarkUser();
}
$('lark-app-id').oninput = updateLarkLinks;
$('lark-base-url').oninput = updateLarkLinks;
for (const radio of document.querySelectorAll('input[name=lark-mode]')) radio.onchange = updateLarkLinks;

async function renderLarkUser() {
  const auth = await store.getLarkUser();
  const form = readLarkForm();
  $('lark-logout').hidden = !auth;
  $('lark-login').textContent = auth ? '重新授权' : '用 Lark 账号授权';
  if (!auth) setStatus($('user-auth-status'), '还没有授权。');
  else if (auth.expired) setStatus($('user-auth-status'), `「${auth.name}」的授权已失效，请重新授权。`, 'err');
  else if (auth.appId !== form.larkAppId || auth.apiBase !== apiBaseOf(form)) setStatus($('user-auth-status'), `「${auth.name}」是用另一个 App ID 或平台授权的，请重新授权。`, 'warn');
  else {
    const until = auth.refreshExpiresAt ? `，授权保持到 ${formatTime(new Date(auth.refreshExpiresAt).toISOString())}，每次同步自动续期` : '';
    setStatus($('user-auth-status'), `已授权：${auth.name}${until}`, 'ok');
  }
}

async function saveLark() {
  const form = readLarkForm();
  if (form.larkBaseUrl) {
    const target = parseBaseUrl(form.larkBaseUrl);
    if (!target) throw new Error('多维表格链接格式不对，应该形如 https://xxx.larksuite.com/base/… 或 …/wiki/…');
    if (!target.apiBase) throw new Error('多维表格链接需要是 feishu.cn 或 larksuite.com 的地址');
  }
  await store.saveSettings(form);
}

async function withLarkButton(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    setStatus($('lark-status'), err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

$('save-lark').onclick = () => withLarkButton($('save-lark'), async () => {
  await saveLark();
  setStatus($('lark-status'), '已保存', 'ok');
});

const skippedNote = (fields) => (fields?.length ? `；表里没有这些列，不会写入：${fields.join('、')}` : '');

$('lark-test').onclick = () => withLarkButton($('lark-test'), async () => {
  await saveLark();
  setStatus($('lark-status'), '正在连接…');
  const r = await send('lark-test');
  const as = readLarkForm().larkAuthMode === 'user' ? `（以「${(await store.getLarkUser())?.name}」的身份）` : '';
  setStatus($('lark-status'), `连接成功${as}：表里有 ${r.records} 条批注，其中 ${r.withShots} 条已有截图${skippedNote(r.skippedFields)}。`, r.skippedFields?.length ? 'warn' : 'ok');
});

$('lark-sync').onclick = () => withLarkButton($('lark-sync'), async () => {
  await saveLark();
  setStatus($('lark-status'), '正在同步…（截图每张要几秒，进度见弹窗）');
  const r = await send('lark-sync-now');
  const parts = [`新增 ${r.created} 条`, `更新 ${r.updated} 条`, `截图 ${r.shots} 条`];
  if (r.shotsRemaining) parts.push(`还有 ${r.shotsRemaining} 条待截图（下次检查继续）`);
  setStatus($('lark-status'), `同步完成：${parts.join('，')}${r.shotErrorCount ? `；${r.shotErrorCount} 条截图失败：${r.shotErrors[0]}` : ''}${skippedNote(r.skippedFields)}`, r.shotErrorCount || r.skippedFields?.length ? 'warn' : 'ok');
});

// chrome.identity.launchWebAuthFlow() error → what to do about it.
function authFlowError(message) {
  // The sign-in window from an earlier click is still open (it outlives a
  // reload of this page), often behind other windows.
  if (/only one web auth flow/i.test(message)) {
    return '上一次打开的 Lark 授权窗口还没关（可能被别的窗口挡住了，可以在 Chrome 菜单「窗口」里找到）。请在那个窗口里完成登录，或者关掉它再点授权；找不到的话，到 chrome://extensions 刷新一下插件。';
  }
  if (/did not approve|cancel/i.test(message)) return '授权窗口被关掉了，没有完成授权。';
  if (/could not be loaded/i.test(message)) return `授权页打不开，请检查网络后重试（${message}）。`;
  return `授权没有完成：${message}。如果授权页提示重定向地址不合法，请先把下面的重定向 URL 加到应用的安全设置里。`;
}

// Sign-in runs here, not in the background: the service worker may be shut
// down while the user is still in the sign-in window.
$('lark-login').onclick = () => withLarkButton($('lark-login'), async () => {
  await saveLark();
  const form = readLarkForm();
  if (!form.larkAppId || !form.larkAppSecret) throw new Error('请先填写 App ID 和 App Secret');
  const apiBase = apiBaseOf(form);
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  setStatus($('lark-status'), '请在弹出的窗口里登录并同意授权（有多个组织时，选应用所在组织的账号）…');
  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl({ apiBase, appId: form.larkAppId, redirectUri, state }), interactive: true });
  } catch (e) {
    throw new Error(authFlowError(e.message));
  }
  const code = codeFromRedirect(back, state);
  const auth = await exchangeCode({ apiBase, appId: form.larkAppId, appSecret: form.larkAppSecret, code, redirectUri });
  await store.saveLarkUser(auth);
  setStatus($('lark-status'), `已授权：${auth.name}。可以点「测试连接」试试。`, 'ok');
});

$('lark-logout').onclick = () => withLarkButton($('lark-logout'), async () => {
  if (!confirm('退出 Lark 账号授权？用户身份的同步会暂停，直到重新授权。')) return;
  await store.saveLarkUser(null);
  setStatus($('lark-status'), '已退出授权', 'ok');
});

$('copy-redirect').onclick = async () => {
  await navigator.clipboard.writeText($('redirect-url').textContent);
  setStatus($('lark-status'), '已复制重定向 URL', 'ok');
};

// ---------- Feishu webhook ----------

function readFeishuForm() {
  return {
    webhookUrl: $('webhook-url').value.trim(),
    webhookToken: $('webhook-token').value.trim(),
    batchSize: Number($('batch-size').value),
    maxBatchesPerRun: Math.max(1, Number($('max-batches').value) || store.DEFAULT_SETTINGS.maxBatchesPerRun),
    pushEnabled: $('push-enabled').checked,
  };
}

function checkWebhookUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return 'webhook 地址需要以 https:// 开头';
    if (!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(u.hostname)) return '只支持 feishu.cn 或 larksuite.com 的 webhook 地址';
  } catch {
    return 'webhook 地址格式不对';
  }
  return null;
}

async function saveFeishu() {
  const form = readFeishuForm();
  const problem = checkWebhookUrl(form.webhookUrl);
  if (problem) throw new Error(problem);
  await store.saveSettings(form);
}

async function withButton(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    setStatus($('feishu-status'), err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

$('save-feishu').onclick = () => withButton($('save-feishu'), async () => {
  await saveFeishu();
  setStatus($('feishu-status'), '已保存', 'ok');
});

$('push-test').onclick = () => withButton($('push-test'), async () => {
  await saveFeishu();
  setStatus($('feishu-status'), '正在发送测试数据…');
  const { disabled } = await send('push-test');
  setStatus($('feishu-status'), disabled
    ? '测试数据已发送（工作流还没启用，配置期间属于正常）。请在 3 分钟内回飞书点「生成」。'
    : '测试数据已发送，飞书返回成功。还在配置输出的话，请在 3 分钟内回飞书点「生成」；工作流已启用的话，表里会多一条示例记录。', 'ok');
});

$('push-now').onclick = () => withButton($('push-now'), async () => {
  await saveFeishu();
  setStatus($('feishu-status'), '正在推送…（每批间隔约 1 秒）');
  const r = await send('push-now');
  if (!r) throw new Error('请先填写 webhook 地址');
  if (r.error) throw new Error(`已推送 ${r.pushed} 条，之后失败：${r.error}`);
  setStatus($('feishu-status'), r.pushed ? `已推送 ${r.pushed} 条` : '没有需要推送的批注', 'ok');
});

$('mark-synced').onclick = () => withButton($('mark-synced'), async () => {
  if (!confirm('把当前所有未同步的批注都标记为「已同步」？之后只会推送新出现的批注。适合先用 CSV 把存量导入飞书的情况。')) return;
  const n = await send('mark-all-synced');
  setStatus($('feishu-status'), `已标记 ${n} 条`, 'ok');
});

async function renderPending() {
  const comments = await store.getComments();
  $('n-pending').textContent = Object.values(comments).filter((c) => !c.synced_at && !c.removed).length;
}

// ---------- init ----------

const settings = await store.getSettings();
$('interval').value = String(settings.intervalMinutes);
if ($('interval').value !== String(settings.intervalMinutes)) {
  $('interval').add(new Option(`${settings.intervalMinutes} 分钟`, settings.intervalMinutes, true, true));
}
$('notify').checked = settings.notify;
$('webhook-url').value = settings.webhookUrl;
$('webhook-token').value = settings.webhookToken;
$('batch-size').value = String(settings.batchSize);
$('max-batches').value = settings.maxBatchesPerRun;
$('push-enabled').checked = settings.pushEnabled;
$('lark-app-id').value = settings.larkAppId;
$('lark-app-secret').value = settings.larkAppSecret;
$('lark-base-url').value = settings.larkBaseUrl;
$('max-shots').value = settings.maxShotsPerRun;
$('lark-enabled').checked = settings.larkEnabled;
document.querySelector(`input[name=lark-mode][value=${settings.larkAuthMode}]`).checked = true;
$('redirect-url').textContent = chrome.identity.getRedirectURL();
updateLarkLinks();

await Promise.all([renderShares(), renderPending()]);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.larkUser || changes.settings) renderLarkUser();
  if (changes.shares || changes.comments) renderShares();
  if (changes.comments) renderPending();
});
