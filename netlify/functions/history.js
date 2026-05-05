import { getStore } from '@netlify/blobs';

function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach((part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return;
    cookies[rawKey] = decodeURIComponent(rawValue.join('='));
  });
  return cookies;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function isAdminAuthenticated(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const sessionToken = cookies.admin_session;
  if (!sessionToken) {
    return false;
  }

  const sessionStore = getStore('admin-sessions');
  const session = await sessionStore.get(sessionToken, { type: 'json' });
  if (!session || !session.expiresAt || Date.now() > session.expiresAt) {
    return false;
  }

  return true;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 100);
}

function buildMetrics(stats, configuredMaxStorageMb) {
  const totalUploads = Number(stats.totalUploads || 0);
  const totalUsedBytes = Number(stats.totalUsedBytes || 0);
  const knownSizeUploads = Number(stats.knownSizeUploads || 0);
  const unknownSizeUploads = Number(stats.unknownSizeUploads || 0);
  const largestFileBytes = Number(stats.largestFileBytes || 0);
  const mostRecentUploadAt = Number(stats.mostRecentUploadAt || 0);
  const maxStorageBytes = configuredMaxStorageMb > 0 ? Math.round(configuredMaxStorageMb * 1024 * 1024) : 0;
  const estimatedRemainingBytes = maxStorageBytes > 0 ? Math.max(0, maxStorageBytes - totalUsedBytes) : null;

  return {
    totalUploads,
    knownSizeUploads,
    unknownSizeUploads,
    totalUsedBytes,
    averageFileBytes: knownSizeUploads > 0 ? Math.round(totalUsedBytes / knownSizeUploads) : 0,
    largestFileBytes,
    mostRecentUploadAt,
    configuredMaxStorageMb: configuredMaxStorageMb > 0 ? configuredMaxStorageMb : null,
    maxStorageBytes: maxStorageBytes || null,
    estimatedRemainingBytes
  };
}

function buildIndexKey(createdAt, token) {
  const maxTimestamp = 9999999999999;
  const reverseTime = String(maxTimestamp - createdAt).padStart(13, '0');
  return `${reverseTime}-${token}`;
}

async function listLegacyTokens(linkStore, maxItems = 50) {
  const tokens = [];
  let cursor;

  do {
    const page = await linkStore.list({ cursor, limit: 100 });
    const blobs = Array.isArray(page?.blobs) ? page.blobs : [];
    for (const blob of blobs) {
      if (blob?.key) {
        tokens.push(blob.key);
      }
      if (tokens.length >= maxItems) {
        return tokens;
      }
    }
    cursor = page?.cursor;
  } while (cursor);

  return tokens;
}

async function applyDeleteStatsDelta(statsStore, indexEntry, deleteFile) {
  const current = (await statsStore.get('global', { type: 'json' })) || {};
  const sizeBytes = Number(indexEntry?.sizeBytes || 0);
  const knownDelta = sizeBytes > 0 ? -1 : 0;
  const unknownDelta = sizeBytes > 0 ? 0 : -1;
  const usedBytesDelta = deleteFile ? -sizeBytes : 0;
  const next = {
    totalUploads: Math.max(0, Number(current.totalUploads || 0) - 1),
    totalUsedBytes: Math.max(0, Number(current.totalUsedBytes || 0) + usedBytesDelta),
    knownSizeUploads: Math.max(0, Number(current.knownSizeUploads || 0) + knownDelta),
    unknownSizeUploads: Math.max(0, Number(current.unknownSizeUploads || 0) + unknownDelta),
    largestFileBytes: Number(current.largestFileBytes || 0),
    mostRecentUploadAt: Number(current.mostRecentUploadAt || 0),
    updatedAt: Date.now()
  };

  await statsStore.setJSON('global', next);
}

export default async (request) => {
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const isAuthenticated = await isAdminAuthenticated(request);
  if (!isAuthenticated) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const linkStore = getStore('shared-links');
    const fileStore = getStore('uploaded-files');
    const indexStore = getStore('uploads-index');
    const statsStore = getStore('upload-stats');

    if (request.method === 'DELETE') {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || '').trim();
      const indexKey = String(body.indexKey || '').trim();
      const deleteFile = Boolean(body.deleteFile);

      if (!token) {
        return jsonResponse({ error: 'Missing token' }, 400);
      }

      const linkData = await linkStore.get(token, { type: 'json' });
      if (!linkData || !linkData.key) {
        return jsonResponse({ error: 'Link not found' }, 404);
      }

      const resolvedIndexKey = indexKey || linkData.indexKey || '';
      const indexEntry = resolvedIndexKey
        ? await indexStore.get(resolvedIndexKey, { type: 'json' })
        : null;

      await linkStore.delete(token);

      if (deleteFile) {
        await fileStore.delete(linkData.key);
      }

      if (resolvedIndexKey) {
        await indexStore.delete(resolvedIndexKey);
      }

      if (indexEntry) {
        await applyDeleteStatsDelta(statsStore, indexEntry, deleteFile);
      }

      return jsonResponse({ ok: true, token, deletedFile: deleteFile });
    }

    const requestUrl = new URL(request.url);
    const cursor = requestUrl.searchParams.get('cursor') || undefined;
    const limit = normalizeLimit(requestUrl.searchParams.get('limit'));
    const page = await indexStore.list({ cursor, limit });
    const rows = [];

    for (const blob of page?.blobs || []) {
      const indexEntry = await indexStore.get(blob.key, { type: 'json' });
      if (!indexEntry?.token) {
        continue;
      }

      const createdAt = Number(indexEntry.createdAt || 0);
      const sizeBytes = Number(indexEntry.sizeBytes || 0);
      const filename = indexEntry.filename || 'download.bin';
      const downloadName = indexEntry.downloadName || null;
      const token = String(indexEntry.token);
      const baseUrl = `${requestUrl.origin}/download/${encodeURIComponent(token)}`;
      const url = downloadName
        ? `${baseUrl}?name=${encodeURIComponent(downloadName)}`
        : baseUrl;

      rows.push({
        indexKey: String(indexEntry.indexKey || blob.key),
        token,
        createdAt,
        filename,
        downloadName,
        contentType: indexEntry.contentType || 'application/octet-stream',
        sizeBytes,
        url
      });
    }

    if (!cursor && rows.length === 0) {
      const legacyTokens = await listLegacyTokens(linkStore, limit);
      for (const token of legacyTokens) {
        const linkData = await linkStore.get(token, { type: 'json' });
        if (!linkData?.key) {
          continue;
        }

        const metadata = (await fileStore.getMetadata(linkData.key)) || {};
        const createdAt = Number(linkData.createdAt || metadata.uploadedAt || Date.now());
        const indexKey = buildIndexKey(createdAt, token);
        const filename = metadata.filename || 'download.bin';
        const downloadName = metadata.downloadName || null;
        const sizeBytes = Number(metadata.sizeBytes || 0);
        const contentType = metadata.contentType || 'application/octet-stream';

        await indexStore.setJSON(indexKey, {
          indexKey,
          token,
          key: linkData.key,
          filename,
          downloadName,
          contentType,
          sizeBytes,
          createdAt,
          revoked: false
        });

        const baseUrl = `${requestUrl.origin}/download/${encodeURIComponent(token)}`;
        const url = downloadName
          ? `${baseUrl}?name=${encodeURIComponent(downloadName)}`
          : baseUrl;

        rows.push({
          indexKey,
          token,
          createdAt,
          filename,
          downloadName,
          contentType,
          sizeBytes,
          url
        });
      }

      rows.sort((a, b) => b.createdAt - a.createdAt);
    }

    const configuredMaxStorageMb = Number(process.env.MAX_STORAGE_MB || 0);
    const stats = (await statsStore.get('global', { type: 'json' })) || {};

    return jsonResponse({
      items: rows,
      cursor: page?.cursor || null,
      hasMore: Boolean(page?.cursor),
      metrics: buildMetrics(stats, configuredMaxStorageMb)
    });
  } catch (error) {
    return jsonResponse({ error: error.message || 'Failed to load history' }, 500);
  }
};
