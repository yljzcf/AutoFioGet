// Lark / Feishu user sign-in (OAuth 2.0 authorization code) and token refresh,
// so the extension can write as the signed-in user instead of as the app,
// e.g. into a Base that another organization shared with that user.
//
// The access token lasts 2 hours; the refresh token 7 days, renewed on every
// refresh, so a sign-in lasts as long as a sync runs at least once a week.

import { LarkError } from './lark.js';

// User scopes requested at sign-in; the app must have them enabled.
export const USER_SCOPES = [
  'base:table:read', 'base:record:read', 'base:record:create', 'base:record:update',
  'docs:document.media:upload', 'wiki:node:read', 'offline_access',
];
// Refresh this long before the access token expires.
const REFRESH_MARGIN_MS = 5 * 60_000;

export const AUTH_MISSING = 'auth_missing';
export const AUTH_EXPIRED = 'auth_expired';

// https://open.larksuite.com → https://accounts.larksuite.com
const accountsBase = (apiBase) => apiBase.replace('://open.', '://accounts.');

export function authorizeUrl({ apiBase, appId, redirectUri, state }) {
  const u = new URL(`${accountsBase(apiBase)}/open-apis/authen/v1/authorize`);
  u.search = new URLSearchParams({ client_id: appId, response_type: 'code', redirect_uri: redirectUri, scope: USER_SCOPES.join(' '), state });
  return u.href;
}

// The URL the sign-in window was sent back to → authorization code.
export function codeFromRedirect(url, state) {
  const p = new URL(url).searchParams;
  if (p.get('state') !== state) throw new LarkError('授权回调校验失败，请重新授权');
  const error = p.get('error');
  if (error === 'access_denied') throw new LarkError('你取消了授权');
  if (error) throw new LarkError(`授权失败：${p.get('error_description') || error}`);
  if (!p.get('code')) throw new LarkError('授权回调里没有授权码');
  return p.get('code');
}

// POST to the v2 token endpoint → { accessToken, expiresAt, refreshToken, refreshExpiresAt }.
// A rejected grant throws with `grant: 'invalid_grant'`.
async function tokenRequest(apiBase, body) {
  const res = await fetch(`${apiBase}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { throw new LarkError(`Lark 返回了非 JSON 响应（HTTP ${res.status}）`); }
  const t = json.data?.access_token ? json.data : json;
  if (json.code !== 0 || !t.access_token) {
    const err = new LarkError(`${json.error_description || json.msg || json.error || '获取用户凭证失败'}（错误码 ${json.code}）`, json.code);
    err.grant = json.error;
    throw err;
  }
  const now = Date.now();
  return {
    accessToken: t.access_token,
    expiresAt: now + t.expires_in * 1000,
    refreshToken: t.refresh_token || null,
    refreshExpiresAt: t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : null,
  };
}

// Authorization code → the sign-in to store: tokens plus who signed in.
export async function exchangeCode({ apiBase, appId, appSecret, code, redirectUri }) {
  const tokens = await tokenRequest(apiBase, { grant_type: 'authorization_code', client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri });
  if (!tokens.refreshToken) throw new LarkError('授权结果里没有 refresh_token：请给应用开通 offline_access 权限并发布新版本，再重新授权');
  const res = await fetch(`${apiBase}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  const json = await res.json();
  if (json.code !== 0) throw new LarkError(`读取账号信息失败：${json.msg}（错误码 ${json.code}）`, json.code);
  return { ...tokens, appId, apiBase, name: json.data.name, openId: json.data.open_id, expired: false };
}

// Lark rotates the refresh token, so two refreshes at once would make the
// second one fail and lose the sign-in. One at a time, per worker.
let refreshing = null;

// → async () => a valid user access token, refreshed and saved as needed.
// `load` / `save` read and write the stored sign-in; `onExpired` runs once
// when a refresh is rejected and the user has to sign in again.
export function userToken({ apiBase, appId, appSecret, load, save, onExpired }) {
  async function refresh() {
    const auth = await load();
    if (auth.expiresAt > Date.now() + REFRESH_MARGIN_MS) return auth.accessToken; // refreshed meanwhile
    const lapsed = auth.refreshExpiresAt && auth.refreshExpiresAt <= Date.now();
    try {
      if (lapsed) throw Object.assign(new LarkError('refresh_token 已过期'), { grant: 'invalid_grant' });
      const tokens = await tokenRequest(apiBase, { grant_type: 'refresh_token', client_id: appId, client_secret: appSecret, refresh_token: auth.refreshToken });
      await save({ ...auth, ...tokens, refreshToken: tokens.refreshToken || auth.refreshToken });
      return tokens.accessToken;
    } catch (e) {
      if (e.grant !== 'invalid_grant') throw e; // network trouble etc.: try again next time
      await save({ ...auth, expired: true });
      await onExpired?.();
      throw new LarkError(`Lark 账号「${auth.name}」的授权已失效，请在设置页重新授权`, AUTH_EXPIRED);
    }
  }

  return async () => {
    const auth = await load();
    if (!auth?.refreshToken || auth.appId !== appId || auth.apiBase !== apiBase) {
      throw new LarkError('还没有用 Lark 账号授权（或 App ID / 多维表格所在平台改过了），请在设置页点「用 Lark 账号授权」', AUTH_MISSING);
    }
    if (auth.expired) throw new LarkError(`Lark 账号「${auth.name}」的授权已失效，请在设置页重新授权`, AUTH_EXPIRED);
    if (auth.expiresAt > Date.now() + REFRESH_MARGIN_MS) return auth.accessToken;
    refreshing ??= refresh().finally(() => { refreshing = null; });
    return refreshing;
  };
}
