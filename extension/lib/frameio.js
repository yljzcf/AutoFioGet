// Frame.io V4 public share links, read through the same GraphQL endpoint the
// web app uses. A public share only needs its share ID (base64) in a header:
// no login, cookie or session. This API is undocumented and may change.

const GQL_URL = 'https://api.frame.io/graphql';
const BASE_HEADERS = {
  'content-type': 'application/json',
  'apollographql-client-name': 'web-app',
  'apollographql-client-version': '@frameio/next-web-app@732.0',
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONCURRENCY = 4;

export class FrameioError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'FrameioError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(shareId, operationName, query, variables, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'x-frameio-share-authentication': btoa(shareId) },
        body: JSON.stringify({ operationName, query, variables }),
      });
    } catch (e) {
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw new FrameioError(`网络错误：${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new FrameioError(`Frame.io 返回了非 JSON 响应（HTTP ${res.status}）`, { status: res.status });
    }
    if (json.errors?.length) {
      const err = json.errors[0];
      const code = err.extensions?.code;
      const hint = code === 'PERMISSION_DENIED' ? '（分享链接可能已失效、被关闭或需要密码）' : '';
      throw new FrameioError(`Frame.io ${operationName} 失败：${err.message}${hint}`, { status: res.status, code });
    }
    if (!res.ok) throw new FrameioError(`Frame.io HTTP ${res.status}`, { status: res.status });
    return json.data;
  }
}

// Accepts next.frame.io/share/{id}[/{folder}|/view/{asset}] or a bare share ID.
export function parseShareUrl(input) {
  const s = String(input || '').trim();
  const m = s.match(new RegExp(`/share/(${UUID})(?:/view/(${UUID})|/(${UUID}))?`, 'i'));
  if (m) return { shareId: m[1].toLowerCase(), assetId: m[2]?.toLowerCase(), folderId: m[3]?.toLowerCase() };
  if (new RegExp(`^${UUID}$`, 'i').test(s)) return { shareId: s.toLowerCase() };
  return null;
}

// Short links (f.io/xxxx) redirect to the full share URL.
export async function resolveShareUrl(input) {
  const direct = parseShareUrl(input);
  if (direct) return direct;
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  const res = await fetch(url.href, { redirect: 'follow' });
  return parseShareUrl(res.url);
}

const MEDIA = 'media { ... on VideoMedia { fps duration frames } }';
const LIST_QUERY = `query ListShareAssets($shareId: ID!, $folderId: ID, $page: PageInput!) {
  share(shareId: $shareId) {
    id
    name
    ... on AssetAggregate {
      assets(folderId: $folderId, page: $page) {
        nodes {
          id name __typename
          ... on VideoAsset { ${MEDIA} }
          ... on VersionStackAsset { versions { id name __typename ... on VideoAsset { ${MEDIA} } } }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`;

const COMMENT_FIELDS = `id number text timestampMicroseconds duration completed insertedAt editedAt parentId documentPageNumber owner { name }`;
const COMMENTS_QUERY = `query GetCommentsByAsset($assetId: ID!, $orderBy: [CommentOrder!]!) {
  asset(assetId: $assetId) {
    id
    commentCount
    comments(orderBy: $orderBy, includeReplies: true, pagination: {pageNumber: 1, pageSize: 10000}) {
      result { ${COMMENT_FIELDS} replies { ${COMMENT_FIELDS} } }
    }
  }
}`;

function toFile(node, folder, stack) {
  return {
    id: node.id,
    name: node.name,
    type: node.__typename,
    folder,
    fps: node.media?.fps ?? null,
    duration: node.media?.duration ?? null,
    frames: node.media?.frames ?? null,
    versionStack: stack ?? null,
  };
}

// Walks every folder of the share. Returns { shareName, files }.
export async function listShareFiles(shareId) {
  const files = [];
  let shareName = '';
  async function walk(folderId, path) {
    let after = null;
    do {
      const page = after ? { first: 100, after } : { first: 100 };
      const data = await gql(shareId, 'ListShareAssets', LIST_QUERY, { shareId, folderId, page });
      if (!data.share) throw new FrameioError('找不到这个分享（链接可能已失效）');
      shareName = data.share.name;
      const conn = data.share.assets;
      for (const n of conn.nodes) {
        if (n.__typename === 'FolderAsset') await walk(n.id, path ? `${path}/${n.name}` : n.name);
        else if (n.__typename === 'VersionStackAsset') for (const v of n.versions || []) files.push(toFile(v, path, n.name));
        else files.push(toFile(n, path));
      }
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
  }
  await walk(null, '');
  return { shareName, files };
}

export async function getShareName(shareId) {
  const data = await gql(shareId, 'GetShareName', 'query GetShareName($shareId: ID!) { share(shareId: $shareId) { id name } }', { shareId });
  if (!data.share) throw new FrameioError('找不到这个分享（链接可能已失效）');
  return data.share.name;
}

export async function getComments(shareId, assetId) {
  const data = await gql(shareId, 'GetCommentsByAsset', COMMENTS_QUERY, {
    assetId,
    orderBy: [{ direction: 'ASC', field: 'TIMECODE' }],
  });
  return data.asset?.comments?.result ?? [];
}

// Signed URL of one exact frame, rendered from the original file (the
// player's "download still"). The URL expires after about a day.
export async function getFrameGrabUrl(shareId, assetId, frame) {
  const data = await gql(shareId, 'GetAssetFrame',
    'query GetAssetFrame($assetId: ID!, $frame: Int) { asset(assetId: $assetId) { id ... on VideoAsset { frameGrab(frameNumber: $frame) } } }',
    { assetId, frame });
  const url = data.asset?.frameGrab;
  if (!url) throw new FrameioError('这个视频不允许截取画面（分享可能关闭了下载）');
  return url;
}

// JPEG bytes of one frame, scaled to `width` px.
export async function fetchFrame(shareId, assetId, frame, { width = 720 } = {}) {
  const url = await getFrameGrabUrl(shareId, assetId, frame);
  const res = await fetch(`${url}&width=${width}`);
  if (!res.ok) throw new FrameioError(`截图下载失败（HTTP ${res.status}）`, { status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}

export async function mapLimit(items, limit, fn) {
  const queue = items.map((item, i) => [item, i]);
  const worker = async () => {
    while (queue.length) {
      const [item, i] = queue.shift();
      await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Full crawl of one share. A file whose comments fail to load gets `error`
// set instead of `comments`, so callers can tell "no comments" from "unknown".
export async function fetchShare(shareId, { onProgress } = {}) {
  const { shareName, files } = await listShareFiles(shareId);
  let done = 0;
  await mapLimit(files, CONCURRENCY, async (file) => {
    try {
      file.comments = await getComments(shareId, file.id);
    } catch (e) {
      file.error = e.message;
    }
    done++;
    await onProgress?.({ done, total: files.length });
  });
  return { shareId, shareName, files };
}
