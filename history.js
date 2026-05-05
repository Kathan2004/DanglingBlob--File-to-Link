import { APP_ROUTES, getEndpointUrl } from './app-config.js';

const logoutBtn = document.getElementById('logoutBtn');
const statusEl = document.getElementById('status');
const qrModal = document.getElementById('qrModal');
const qrCanvas = document.getElementById('qrCanvas');
const qrLinkText = document.getElementById('qrLinkText');
const closeQrModal = document.getElementById('closeQrModal');
const historyTableBody = document.getElementById('historyTableBody');
const metricTotalUploads = document.getElementById('metricTotalUploads');
const metricStorageUsed = document.getElementById('metricStorageUsed');
const metricSpaceLeft = document.getElementById('metricSpaceLeft');
const metricAvgSize = document.getElementById('metricAvgSize');
const metricLargestFile = document.getElementById('metricLargestFile');
const metricLatestUpload = document.getElementById('metricLatestUpload');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfo = document.getElementById('pageInfo');
const backToUploadLink = document.getElementById('backToUploadLink');
let isMutating = false;
let currentCursor = null;
let nextCursor = null;
let pageNumber = 1;
const cursorStack = [];

if (backToUploadLink) {
  backToUploadLink.href = APP_ROUTES.admin;
}

function setStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(ms) {
  if (!ms) {
    return 'Unknown';
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return 'Unknown';
  }
  return d.toLocaleString();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = size >= 100 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function renderMetrics(metrics) {
  const data = metrics || {};
  if (metricTotalUploads) {
    metricTotalUploads.textContent = String(Number(data.totalUploads || 0));
  }
  if (metricStorageUsed) {
    const knownCount = Number(data.knownSizeUploads || 0);
    const unknownCount = Number(data.unknownSizeUploads || 0);
    metricStorageUsed.textContent = `${formatBytes(data.totalUsedBytes || 0)}${unknownCount > 0 ? ` (known for ${knownCount} items)` : ''}`;
  }
  if (metricSpaceLeft) {
    if (data.estimatedRemainingBytes === null || data.estimatedRemainingBytes === undefined) {
      metricSpaceLeft.textContent = 'Set MAX_STORAGE_MB';
    } else {
      metricSpaceLeft.textContent = formatBytes(data.estimatedRemainingBytes);
    }
  }
  if (metricAvgSize) {
    metricAvgSize.textContent = formatBytes(data.averageFileBytes || 0);
  }
  if (metricLargestFile) {
    metricLargestFile.textContent = formatBytes(data.largestFileBytes || 0);
  }
  if (metricLatestUpload) {
    metricLatestUpload.textContent = formatDate(data.mostRecentUploadAt || 0);
  }
}

function renderHistory(items) {
  if (!historyTableBody) return;

  if (!Array.isArray(items) || !items.length) {
    historyTableBody.innerHTML = '<tr><td data-label="Status" colspan="5">No uploads found yet.</td></tr>';
    return;
  }

  historyTableBody.innerHTML = items
    .map((item) => {
      const uploadedAt = formatDate(item.createdAt);
      const filename = escapeHtml(item.filename || 'download.bin');
      const downloadName = escapeHtml(item.downloadName || '-');
      const link = escapeHtml(item.url || '#');
      const token = escapeHtml(item.token || '');
      const indexKey = escapeHtml(item.indexKey || '');
      return `
        <tr>
          <td data-label="Uploaded At">${uploadedAt}</td>
          <td data-label="Stored Filename">${filename}</td>
          <td data-label="Download Name">${downloadName}</td>
          <td data-label="Download Link"><a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a></td>
          <td data-label="Actions">
            <button class="action-btn" data-action="qr-code" data-link="${link}">QR Code</button>
            <button class="action-btn" data-action="revoke" data-token="${token}" data-index-key="${indexKey}">Revoke</button>
            <button class="action-btn danger-btn" data-action="delete-file" data-token="${token}" data-index-key="${indexKey}">Delete</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderPagination() {
  if (pageInfo) {
    pageInfo.textContent = `Page ${pageNumber}`;
  }
  if (prevPageBtn) {
    prevPageBtn.disabled = cursorStack.length === 0;
  }
  if (nextPageBtn) {
    nextPageBtn.disabled = !nextCursor;
  }
}

async function deleteHistoryItem(token, indexKey, deleteFile) {
  if (!token) {
    throw new Error('Missing token for delete action.');
  }

  const response = await fetch(getEndpointUrl('history'), {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, indexKey, deleteFile })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to update history item.');
  }
}

async function loadHistory(cursor = null) {
  setStatus('Loading upload history...');

  currentCursor = cursor;
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) {
    query.set('cursor', cursor);
  }

  try {
    const response = await fetch(getEndpointUrl('history', query), {
      method: 'GET',
      credentials: 'include'
    });

    if (response.status === 401) {
      window.location.href = APP_ROUTES.admin;
      return;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error (${response.status}): ${errorText || 'No message'}`);
    }

    const text = await response.text();
    if (!text) {
      throw new Error('Empty response from server');
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.substring(0, 100)}`);
    }

    renderHistory(payload.items || []);
    renderMetrics(payload.metrics || {});
    nextCursor = payload.cursor || null;
    renderPagination();
    setStatus(`Loaded ${Array.isArray(payload.items) ? payload.items.length : 0} upload entries.`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error('History fetch error:', error);
  }
}

function showQrCode(link) {
  if (!link || link === '#') return;
  
  qrLinkText.textContent = link;
  qrModal.classList.add('visible');
  
  try {
    QRCode.toCanvas(qrCanvas, link, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 300,
      margin: 1,
      color: {
        dark: '#0b1020',
        light: '#ffffff'
      }
    });
  } catch (error) {
    setStatus('Error generating QR code: ' + error.message);
  }
}

closeQrModal?.addEventListener('click', () => {
  qrModal.classList.remove('visible');
});

qrModal?.addEventListener('click', (e) => {
  if (e.target === qrModal) {
    qrModal.classList.remove('visible');
  }
});

async function checkAuthAndLoad() {
  try {
    const response = await fetch(getEndpointUrl('adminAuth'), {
      method: 'GET',
      credentials: 'include'
    });

    if (!response.ok) {
      window.location.href = APP_ROUTES.admin + '?next=' + encodeURIComponent(window.location.pathname);
      return;
    }

    await loadHistory(null);
  } catch {
    window.location.href = APP_ROUTES.admin;
  }
}

logoutBtn?.addEventListener('click', async () => {
  await fetch(getEndpointUrl('adminAuth'), {
    method: 'DELETE',
    credentials: 'include'
  });
  window.location.href = APP_ROUTES.admin;
});

historyTableBody?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const action = target.getAttribute('data-action');
  const token = target.getAttribute('data-token') || '';
  const indexKey = target.getAttribute('data-index-key') || '';
  const link = target.getAttribute('data-link') || '';
  
  if (!action || isMutating) {
    return;
  }

  if (action === 'qr-code') {
    showQrCode(link);
    return;
  }

  if (!token) return;

  const deleteFile = action === 'delete-file';
  const confirmationMessage = deleteFile
    ? 'Delete this link and its uploaded file permanently?'
    : 'Revoke this link? It will stop working immediately.';

  if (!window.confirm(confirmationMessage)) {
    return;
  }

  isMutating = true;
  target.disabled = true;

  try {
    await deleteHistoryItem(token, indexKey, deleteFile);
    setStatus(deleteFile ? 'Link and file deleted.' : 'Link revoked.');
    await loadHistory(currentCursor);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    isMutating = false;
    target.disabled = false;
  }
});

prevPageBtn?.addEventListener('click', async () => {
  if (!cursorStack.length || isMutating) return;
  const prevCursor = cursorStack.pop() || null;
  pageNumber = Math.max(1, pageNumber - 1);
  await loadHistory(prevCursor);
});

nextPageBtn?.addEventListener('click', async () => {
  if (!nextCursor || isMutating) return;
  cursorStack.push(currentCursor);
  pageNumber += 1;
  await loadHistory(nextCursor);
});

renderPagination();

checkAuthAndLoad();
