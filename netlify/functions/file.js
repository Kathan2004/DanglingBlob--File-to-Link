import { getStore } from '@netlify/blobs';

export default async (request) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const queryName = url.searchParams.get('name');

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  const linkStore = getStore('shared-links');
  const linkData = await linkStore.get(token, { type: 'json' });

  if (!linkData || !linkData.key) {
    return new Response('Invalid or expired token', { status: 404 });
  }

  const expiresAt = Number(linkData.expiresAt || 0);
  if (expiresAt > 0 && Date.now() > expiresAt) {
    await linkStore.delete(token);

    const indexKey = String(linkData.indexKey || '');
    if (indexKey) {
      const indexStore = getStore('uploads-index');
      await indexStore.delete(indexKey);
    }

    return new Response('Link has expired', { status: 410 });
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

  return new Response(fileData, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, max-age=0, must-revalidate'
    }
  });
};
