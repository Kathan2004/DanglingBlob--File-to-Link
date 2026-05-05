import { getStore } from '@netlify/blobs';

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function passwordPromptPage({ token, name, errorMessage = '' }) {
  const safeToken = encodeURIComponent(String(token || ''));
  const safeName = String(name || '');
  const safeError = escapeHtml(errorMessage);
  const nameInput = safeName ? `<input type="hidden" name="name" value="${escapeHtml(safeName)}" />` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Password Required</title>
    <style>
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b1020; color:#e7ecff; font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; }
      .card { width:min(420px,92vw); background:#121936; border:1px solid #2c3768; border-radius:14px; padding:20px; box-shadow:0 12px 30px rgba(0,0,0,0.35); }
      h1 { margin:0 0 10px; font-size:1.2rem; }
      p { margin:0 0 12px; color:#b7c4ff; }
      input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid #4f68d9; background:#0d1430; color:#e7ecff; box-sizing:border-box; }
      button { margin-top:12px; border:1px solid #4f68d9; background:#2a3ea7; color:white; border-radius:10px; padding:10px 14px; cursor:pointer; font-weight:600; width:100%; }
      .error { color:#ffb7b7; margin-top:10px; }
      .muted { color:#95a6f7; font-size:0.9rem; margin-top:8px; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Password Protected Link</h1>
      <p>Enter the password to download this file.</p>
      <form method="GET" action="/download/${safeToken}">
        ${nameInput}
        <input type="password" name="password" placeholder="Password" required autofocus />
        <button type="submit">Download</button>
      </form>
      ${safeError ? `<div class="error">${safeError}</div>` : ''}
      <div class="muted">Tip: password is case-sensitive.</div>
    </main>
  </body>
</html>`;
}

export default async (request) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const queryName = url.searchParams.get('name');
  const providedPassword = String(url.searchParams.get('password') || request.headers.get('x-link-password') || '');
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');

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
      if (wantsHtml) {
        return new Response(passwordPromptPage({ token, name: queryName }), {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
      return new Response('Password required for this link', { status: 401 });
    }
    const providedHash = await sha256Hex(providedPassword);
    if (providedHash !== String(linkData.passwordHash)) {
      if (wantsHtml) {
        return new Response(passwordPromptPage({ token, name: queryName, errorMessage: 'Invalid password. Try again.' }), {
          status: 403,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
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
  const nextDownloadCount = downloadCount + 1;
  const updatedLinkData = {
    ...linkData,
    firstAccessedAt: nextFirstAccessedAt || null,
    downloadCount: nextDownloadCount,
    lastAccessedAt: now,
    exhaustedAt: maxDownloads > 0 && nextDownloadCount >= maxDownloads ? now : null
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
        downloadCount: nextDownloadCount,
        lastAccessedAt: now,
        exhaustedAt: maxDownloads > 0 && nextDownloadCount >= maxDownloads ? now : null
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
