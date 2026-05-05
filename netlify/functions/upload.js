import { getStore } from '@netlify/blobs';

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sanitizeIdempotencyKey(value) {
  if (!value) return '';
  return String(value).trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
}

function parseExpiryMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const now = Date.now();
  const maxFutureMs = 365 * 24 * 60 * 60 * 1000;
  if (parsed <= now) {
    return null;
  }
  if (parsed > now + maxFutureMs) {
    return now + maxFutureMs;
  }

  return parsed;
}

function parseTtlMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  const maxTtlMs = 365 * 24 * 60 * 60 * 1000;
  return Math.min(parsed, maxTtlMs);
}

function parseMaxDownloads(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.min(parsed, 1000000);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(body, status = 200, requestId) {
  const headers = { 'content-type': 'application/json' };
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function buildIndexKey(createdAt, token) {
  const maxTimestamp = 9999999999999;
  const reverseTime = String(maxTimestamp - createdAt).padStart(13, '0');
  return `${reverseTime}-${token}`;
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach((part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return;
    cookies[rawKey] = decodeURIComponent(rawValue.join('='));
  });
  return cookies;
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

async function applyUploadStatsDelta(statsStore, { totalUploads = 0, totalUsedBytes = 0, knownSizeUploads = 0, unknownSizeUploads = 0, largestFileBytes = 0, mostRecentUploadAt = 0 }) {
  const current = (await statsStore.get('global', { type: 'json' })) || {};
  const next = {
    totalUploads: Math.max(0, Number(current.totalUploads || 0) + totalUploads),
    totalUsedBytes: Math.max(0, Number(current.totalUsedBytes || 0) + totalUsedBytes),
    knownSizeUploads: Math.max(0, Number(current.knownSizeUploads || 0) + knownSizeUploads),
    unknownSizeUploads: Math.max(0, Number(current.unknownSizeUploads || 0) + unknownSizeUploads),
    largestFileBytes: Math.max(Number(current.largestFileBytes || 0), Number(largestFileBytes || 0)),
    mostRecentUploadAt: Math.max(Number(current.mostRecentUploadAt || 0), Number(mostRecentUploadAt || 0)),
    updatedAt: Date.now()
  };

  await statsStore.setJSON('global', next);
}

export default async (request) => {
  const requestId = crypto.randomUUID();

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, requestId);
  }

  const isAuthenticated = await isAdminAuthenticated(request);
  if (!isAuthenticated) {
    return jsonResponse({ error: 'Unauthorized' }, 401, requestId);
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const requestedDownloadName = sanitizeName(String(formData.get('downloadName') || ''));
    const expiryMode = String(formData.get('expiryMode') || 'fixed') === 'first-access' ? 'first-access' : 'fixed';
    const expiresAt = parseExpiryMs(formData.get('expiresAt'));
    const ttlMs = parseTtlMs(formData.get('ttlMs'));
    const linkPassword = String(formData.get('linkPassword') || '').trim().slice(0, 200);
    const maxDownloads = parseMaxDownloads(formData.get('maxDownloads'));
    const passwordHash = linkPassword ? await sha256Hex(linkPassword) : null;
    const idempotencyHeader = request.headers.get('x-idempotency-key');
    const idempotencyBody = formData.get('idempotencyKey');
    const idempotencyKey = sanitizeIdempotencyKey(idempotencyHeader || idempotencyBody || '');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return jsonResponse({ error: 'No file uploaded' }, 400, requestId);
    }

    if (expiryMode === 'first-access' && !ttlMs) {
      return jsonResponse({ error: 'First-access expiry requires ttlMs' }, 400, requestId);
    }

    const idempotencyStore = getStore('upload-idempotency');
    if (idempotencyKey) {
      const existing = await idempotencyStore.get(idempotencyKey, { type: 'json' });
      if (existing?.response?.url) {
        return jsonResponse({ ...existing.response, idempotentReplay: true }, 200, requestId);
      }
    }

    const originalName = sanitizeName(file.name || 'upload.bin');
    const key = `${Date.now()}-${crypto.randomUUID()}-${originalName}`;
    const token = crypto.randomUUID();
    const uploadedAt = Date.now();
    const indexKey = buildIndexKey(uploadedAt, token);
    const sizeBytes = Number(file.size || 0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileStore = getStore('uploaded-files');
    const linkStore = getStore('shared-links');
    const indexStore = getStore('uploads-index');
    const statsStore = getStore('upload-stats');

    await fileStore.set(key, bytes, {
      metadata: {
        filename: originalName,
        downloadName: requestedDownloadName || undefined,
        contentType: file.type || 'application/octet-stream',
        sizeBytes,
        uploadedAt,
        indexKey
      }
    });

    await linkStore.setJSON(token, {
      key,
      createdAt: uploadedAt,
      indexKey,
      expiresAt,
      expiryMode,
      ttlMs,
      passwordHash,
      passwordProtected: Boolean(passwordHash),
      maxDownloads,
      downloadCount: 0,
      firstAccessedAt: null,
      lastAccessedAt: null
    });

    await indexStore.setJSON(indexKey, {
      indexKey,
      token,
      key,
      filename: originalName,
      downloadName: requestedDownloadName || null,
      contentType: file.type || 'application/octet-stream',
      sizeBytes,
      createdAt: uploadedAt,
      expiresAt,
      expiryMode,
      ttlMs,
      passwordProtected: Boolean(passwordHash),
      maxDownloads,
      downloadCount: 0,
      firstAccessedAt: null,
      lastAccessedAt: null,
      revoked: false
    });

    await applyUploadStatsDelta(statsStore, {
      totalUploads: 1,
      totalUsedBytes: sizeBytes,
      knownSizeUploads: sizeBytes > 0 ? 1 : 0,
      unknownSizeUploads: sizeBytes > 0 ? 0 : 1,
      largestFileBytes: sizeBytes,
      mostRecentUploadAt: uploadedAt
    });

    const requestUrl = new URL(request.url);
    const url = `${requestUrl.origin}/.netlify/functions/file?token=${encodeURIComponent(token)}`;

    const responsePayload = {
      requestId,
      token,
      filename: originalName,
      downloadName: requestedDownloadName || null,
      expiresAt,
      expiryMode,
      ttlMs,
      passwordProtected: Boolean(passwordHash),
      maxDownloads,
      url
    };

    if (idempotencyKey) {
      await idempotencyStore.setJSON(idempotencyKey, {
        createdAt: Date.now(),
        response: responsePayload
      });
    }

    return jsonResponse(responsePayload, 200, requestId);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Upload failed' }, 500, requestId);
  }
};
