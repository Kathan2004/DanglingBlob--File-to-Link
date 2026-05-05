const runtime = window.APP_CONFIG || {};

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

const apiBaseUrl = trimSlash(runtime.API_BASE_URL || '');

const endpoints = {
  adminAuth: runtime.ENDPOINT_ADMIN_AUTH || '/.netlify/functions/admin-auth',
  upload: runtime.ENDPOINT_UPLOAD || '/.netlify/functions/upload',
  history: runtime.ENDPOINT_HISTORY || '/.netlify/functions/history'
};

export const APP_ROUTES = {
  admin: runtime.ROUTE_ADMIN || '/admin',
  history: runtime.ROUTE_HISTORY || '/admin/history'
};

export function getEndpointUrl(name, searchParams) {
  const endpoint = endpoints[name];
  if (!endpoint) {
    throw new Error(`Unknown endpoint: ${name}`);
  }

  const absolute = /^https?:\/\//i.test(endpoint);
  const base = absolute ? endpoint : `${apiBaseUrl}${endpoint}`;

  if (!searchParams) {
    return base;
  }

  const query = new URLSearchParams(searchParams).toString();
  if (!query) {
    return base;
  }

  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}
