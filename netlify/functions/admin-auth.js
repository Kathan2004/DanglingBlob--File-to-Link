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

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  });
}

async function getSession(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const token = cookies.admin_session;
  if (!token) return null;

  const sessionStore = getStore('admin-sessions');
  const session = await sessionStore.get(token, { type: 'json' });
  if (!session || !session.expiresAt || Date.now() > session.expiresAt) {
    return null;
  }

  return { token, session };
}

export default async (request) => {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUsername || !adminPassword) {
    return jsonResponse(
      { error: 'Server auth not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in Netlify environment variables.' },
      500
    );
  }

  if (request.method === 'GET') {
    const current = await getSession(request);
    if (!current) {
      return jsonResponse({ authenticated: false }, 401);
    }
    return jsonResponse({ authenticated: true, username: current.session.username });
  }

  if (request.method === 'DELETE') {
    const current = await getSession(request);
    if (current) {
      const sessionStore = getStore('admin-sessions');
      await sessionStore.delete(current.token);
    }
    return jsonResponse(
      { ok: true },
      200,
      { 'set-cookie': 'admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' }
    );
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '');
  const password = String(body.password || '');

  if (username !== adminUsername || password !== adminPassword) {
    return jsonResponse({ error: 'Invalid credentials' }, 401);
  }

  const token = crypto.randomUUID();
  const maxAgeSeconds = 60 * 60 * 12;
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const sessionStore = getStore('admin-sessions');

  await sessionStore.setJSON(token, {
    username,
    expiresAt,
    createdAt: Date.now()
  });

  const isSecure = new URL(request.url).protocol === 'https:';
  const secureAttr = isSecure ? '; Secure' : '';
  const cookie = `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureAttr}`;

  return jsonResponse({ ok: true, username }, 200, { 'set-cookie': cookie });
};
