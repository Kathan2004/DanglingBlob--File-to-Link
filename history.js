import { APP_ROUTES, getEndpointUrl } from './app-config.js';

const logoutBtn = document.getElementById('logoutBtn');
const statusEl = document.getElementById('status');
const historyTableBody = document.getElementById('historyTableBody');
const metricTotalUploads = document.getElementById('metricTotalUploads');
const metricStorageUsed = document.getElementById('metricStorageUsed');
const metricAvgSize = document.getElementById('metricAvgSize');
const metricLargestFile = document.getElementById('metricLargestFile');
const metricLatestUpload = document.getElementById('metricLatestUpload');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfo = document.getElementById('pageInfo');
const backToUploadLink = document.getElementById('backToUploadLink');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const filterButtons = Array.from(document.querySelectorAll('.filter-btn'));

let isMutating = false;
let currentCursor = null;
let nextCursor = null;
let pageNumber = 1;
const cursorStack = [];
const selectedItems = new Map();
let currentItems = [];
let activeFilter = 'all';

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

function formatExpiry(expiresAt) {
  if (!expiresAt) {
    return { text: 'Never', status: 'never' };
  }

  const ts = Number(expiresAt);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { text: 'Never', status: 'never' };
  }

  if (Date.now() > ts) {
    return { text: `Expired (${formatDate(ts)})`, status: 'expired' };
  }

  return { text: formatDate(ts), status: 'active' };
}

function formatPolicy(item) {
  const parts = [];
  if (item.passwordProtected) {
    parts.push('Password');
  }
  if (item.maxDownloads) {
    parts.push(`Max ${Number(item.maxDownloads)}`);
  }
  if (item.expiryMode === 'first-access') {
    parts.push('Start on first access');
  }
  return parts.length ? parts.join(' • ') : 'Standard';
}

function getExpiryStatus(expiresAt) {
  if (!expiresAt) {
    return 'never';
  }

  const ts = Number(expiresAt);
  if (!Number.isFinite(ts) || ts <= 0) {
    return 'never';
  }

  if (Date.now() > ts) {
    return 'expired';
  }

  return 'active';
}

function applyFilter(items) {
  if (!Array.isArray(items) || !items.length || activeFilter === 'all') {
    return items || [];
  }

  return items.filter((item) => getExpiryStatus(item.expiresAt) === activeFilter);
}

function updateFilterButtonsUI() {
  filterButtons.forEach((btn) => {
    const value = btn.getAttribute('data-filter') || 'all';
    btn.classList.toggle('active', value === activeFilter);
  });
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
    const label = activeFilter === 'all'
      ? 'No uploads found yet.'
      : `No ${activeFilter} uploads on this page.`;
    historyTableBody.innerHTML = `<tr><td data-label="Status" colspan="10">${label}</td></tr>`;
    updateBulkDeleteUI();
    return;
  }

  historyTableBody.innerHTML = items
    .map((item) => {
      const uploadedAt = formatDate(item.createdAt);
      const filename = escapeHtml(item.filename || 'download.bin');
      const downloadName = escapeHtml(item.downloadName || '-');
      const expiry = formatExpiry(item.expiresAt);
      const expiryText = escapeHtml(expiry.text);
      const policyText = escapeHtml(formatPolicy(item));
      const expiryClass =
        expiry.status === 'expired'
          ? 'expiry-expired'
          : expiry.status === 'active'
            ? 'expiry-active'
            : 'expiry-never';
      const downloadsText = String(Number(item.downloadCount || 0));
      const lastAccessText = escapeHtml(formatDate(item.lastAccessedAt || 0));
      const link = escapeHtml(item.url || '#');
      const token = escapeHtml(item.token || '');
      const indexKey = escapeHtml(item.indexKey || '');

      return `
        <tr>
          <td class="checkbox-cell" data-label="Sel"><input type="checkbox" class="row-checkbox" data-token="${token}" data-index-key="${indexKey}" ${selectedItems.has(token) ? 'checked' : ''} /></td>
          <td data-label="Uploaded At">${uploadedAt}</td>
          <td data-label="Stored Filename">${filename}</td>
          <td data-label="Download Name">${downloadName}</td>
          <td data-label="Expiry"><span class="expiry-badge ${expiryClass}">${expiryText}</span></td>
          <td data-label="Policy">${policyText}</td>
          <td data-label="Downloads">${downloadsText}</td>
          <td data-label="Last Access">${lastAccessText}</td>
          <td data-label="Download Link"><a href="${link}" target="_blank" rel="noopener noreferrer">${link}</a></td>
          <td data-label="Actions">
            <button class="action-btn" data-action="revoke" data-token="${token}" data-index-key="${indexKey}">Revoke</button>
            <button class="action-btn danger-btn" data-action="delete-file" data-token="${token}" data-index-key="${indexKey}">Delete</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderFilteredHistory() {
  const filtered = applyFilter(currentItems);
  renderHistory(filtered);
  updateBulkDeleteUI();
}

function updateBulkDeleteUI() {
  if (bulkDeleteBtn) {
    bulkDeleteBtn.disabled = selectedItems.size === 0 || isMutating;
    bulkDeleteBtn.textContent = selectedItems.size > 0
      ? `Delete Selected + Files (${selectedItems.size})`
      : 'Delete Selected + Files';
  }

  if (selectAllCheckbox && historyTableBody) {
    const rowCheckboxes = historyTableBody.querySelectorAll('.row-checkbox');
    const total = rowCheckboxes.length;
    const checked = Array.from(rowCheckboxes).filter((cb) => cb.checked).length;
    selectAllCheckbox.checked = total > 0 && checked === total;
    selectAllCheckbox.indeterminate = checked > 0 && checked < total;
  }
}

function renderPagination() {
  if (pageInfo) {
    pageInfo.textContent = nextCursor ? `Page ${pageNumber} - more available` : `Page ${pageNumber} - end`;
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

async function deleteHistoryItems(items, deleteFile) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('No selected items to delete.');
  }

  const response = await fetch(getEndpointUrl('history'), {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items, deleteFile })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete selected items.');
  }

  return payload;
}

async function loadHistory(cursor = null) {
  setStatus('Loading upload history...');

  selectedItems.clear();
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
  }

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

    currentItems = Array.isArray(payload.items) ? payload.items : [];
    renderFilteredHistory();
    renderMetrics(payload.metrics || {});
    nextCursor = payload.cursor || null;
    updateFilterButtonsUI();
    renderPagination();
    const filteredCount = applyFilter(currentItems).length;
    setStatus(`Loaded ${filteredCount} of ${currentItems.length} upload entries on this page.`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error('History fetch error:', error);
  }
}

async function checkAuthAndLoad() {
  try {
    const response = await fetch(getEndpointUrl('adminAuth'), {
      method: 'GET',
      credentials: 'include'
    });

    if (!response.ok) {
      window.location.href = `${APP_ROUTES.admin}?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }

    await loadHistory(null);
  } catch (error) {
    setStatus(`Auth check error: ${error.message}`);
    console.error('Auth check error:', error);
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

  if (!action || isMutating) {
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
    selectedItems.delete(token);
    updateBulkDeleteUI();
  }
});

historyTableBody?.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('row-checkbox')) {
    return;
  }

  const token = target.getAttribute('data-token') || '';
  const indexKey = target.getAttribute('data-index-key') || '';
  if (!token) {
    return;
  }

  if (target.checked) {
    selectedItems.set(token, indexKey);
  } else {
    selectedItems.delete(token);
  }

  updateBulkDeleteUI();
});

selectAllCheckbox?.addEventListener('change', () => {
  if (!historyTableBody) {
    return;
  }

  const rowCheckboxes = historyTableBody.querySelectorAll('.row-checkbox');
  rowCheckboxes.forEach((checkbox) => {
    if (!(checkbox instanceof HTMLInputElement)) {
      return;
    }

    checkbox.checked = selectAllCheckbox.checked;
    const token = checkbox.getAttribute('data-token') || '';
    const indexKey = checkbox.getAttribute('data-index-key') || '';
    if (!token) {
      return;
    }

    if (selectAllCheckbox.checked) {
      selectedItems.set(token, indexKey);
    } else {
      selectedItems.delete(token);
    }
  });

  updateBulkDeleteUI();
});

bulkDeleteBtn?.addEventListener('click', async () => {
  if (isMutating || selectedItems.size === 0) {
    return;
  }

  if (!window.confirm(`Delete ${selectedItems.size} selected link(s) and file(s) permanently?`)) {
    return;
  }

  isMutating = true;
  updateBulkDeleteUI();

  try {
    const items = Array.from(selectedItems.entries()).map(([token, indexKey]) => ({ token, indexKey }));
    const result = await deleteHistoryItems(items, true);
    selectedItems.clear();
    setStatus(`Deleted ${Number(result.deleted || 0)} of ${Number(result.total || items.length)} selected items.`);
    await loadHistory(currentCursor);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    isMutating = false;
    updateBulkDeleteUI();
  }
});

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const value = btn.getAttribute('data-filter') || 'all';
    if (value === activeFilter) {
      return;
    }

    activeFilter = value;
    selectedItems.clear();
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    }
    updateFilterButtonsUI();
    renderFilteredHistory();
    const filteredCount = applyFilter(currentItems).length;
    setStatus(`Showing ${filteredCount} of ${currentItems.length} entries (${activeFilter}).`);
  });
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
