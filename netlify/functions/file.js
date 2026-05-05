import { getStore } from '@netlify/blobs';

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default async (request) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const queryName = url.searchParams.get('name');
  const providedPassword = String(url.searchParams.get('password') || request.headers.get('x-link-password') || '');

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  const linkStore = getStore('shared-links');
  const linkData = await linkStore.get(token, { type: 'json' });

  if (!linkData || !linkData.key) {
    return new Response('Invalid or expired token', { status: 404 });
  }

  if (linkData.passwordHash) {
    if (!providedPassword) {
      return new Response('Password required for this link', { status: 401 });
    }
    const providedHash = await sha256Hex(providedPassword);
    if (providedHash !== String(linkData.passwordHash)) {
      return new Response('Invalid link password', { status: 403 });
    }
  }

  const now = Date.now();
  const expiryMode = String(linkData.expiryMode || 'fixed');
  const ttlMs = Number(linkData.ttlMs || 0);
  const firstAccessedAt = Number(linkData.firstAccessedAt || 0);
  let effectiveExpiresAt = Number(linkData.expiresAt || 0);

  if (expiryMode === 'first-access' && ttlMs > 0 && firstAccessedAt > 0) {
    effectiveExpiresAt = firstAccessedAt + ttlMs;
  }

  if (effectiveExpiresAt > 0 && now > effectiveExpiresAt) {
    return new Response('Link has expired', { status: 410 });
  }

  const maxDownloads = Number(linkData.maxDownloads || 0);
  const downloadCount = Number(linkData.downloadCount || 0);
  if (maxDownloads > 0 && downloadCount >= maxDownloads) {
    return new Response('Download limit reached', { status: 410 });
  }

  const store = getStore('uploaded-files');
  const fileData = await store.get(linkData.key, { type: 'arrayBuffer' });

  if (!fileData) {
    return new Response('File not found', { status: 404 });
  }

  const metadata = (await store.getMetadata(linkData.key)) || {};
  const safeQueryName = typeof queryName === 'string' ? queryName.trim().replace(/[^a-zA-Z0-9._-]/g, '_') : '';
  const filename = safeQueryName || metadata.downloadName || metadata.filename || 'download.bin';
  const contentType = metadata.contentType || 'application/octet-stream';

  const nextFirstAccessedAt = firstAccessedAt || (expiryMode === 'first-access' && ttlMs > 0 ? now : 0);
  const updatedLinkData = {
    ...linkData,
    firstAccessedAt: nextFirstAccessedAt || null,
    downloadCount: downloadCount + 1,
    lastAccessedAt: now
  };
  await linkStore.setJSON(token, updatedLinkData);

  const indexKey = String(linkData.indexKey || '');
  if (indexKey) {
    const indexStore = getStore('uploads-index');
    const indexEntry = await indexStore.get(indexKey, { type: 'json' });
    if (indexEntry) {
      await indexStore.setJSON(indexKey, {
        ...indexEntry,
        firstAccessedAt: nextFirstAccessedAt || null,
        downloadCount: downloadCount + 1,
        lastAccessedAt: now
      });
    }
  }

  return new Response(fileData, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, max-age=0, must-revalidate'
    }
  });
};
