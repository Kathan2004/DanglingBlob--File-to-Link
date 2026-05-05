import { getEndpointUrl } from './app-config.js';

const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const pickFilesBtn = document.getElementById('pickFilesBtn');
const pickFolderBtn = document.getElementById('pickFolderBtn');
const uploadBtn = document.getElementById('uploadBtn');
const dropZone = document.getElementById('dropZone');
const selection = document.getElementById('selection');
const statusEl = document.getElementById('status');
const resultBox = document.getElementById('resultBox');
const resultLink = document.getElementById('resultLink');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const downloadNameInput = document.getElementById('downloadNameInput');
const loginBox = document.getElementById('loginBox');
const uploaderBox = document.getElementById('uploaderBox');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const expiryPresetSelect = document.getElementById('expiryPresetSelect');
const expiryCustomMinutes = document.getElementById('expiryCustomMinutes');
const expiryHelpText = document.getElementById('expiryHelpText');
const expiryModeSelect = document.getElementById('expiryModeSelect');
const linkPasswordInput = document.getElementById('linkPasswordInput');
const maxDownloadsInput = document.getElementById('maxDownloadsInput');
const selectionPreviewBox = document.getElementById('selectionPreviewBox');
const selectionPreviewList = document.getElementById('selectionPreviewList');
const uploadQueueList = document.getElementById('uploadQueueList');
const queueSummary = document.getElementById('queueSummary');
const recentLinksList = document.getElementById('recentLinksList');

let selectedFiles = [];
let selectedIsFolder = false;
let dragCounter = 0;
let queueId = 0;
let currentUploadingId = null;
const uploadQueue = [];

const MAX_UPLOAD_SIZE_MB = 5;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const RECENT_LINKS_KEY = 'fileToLinkRecentLinks';
const recentLinks = loadRecentLinks();

function setStatus(message) {
  statusEl.textContent = message;
}

function sanitizeDownloadName(name) {
  return name.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function loadRecentLinks() {
  try {
    const raw = sessionStorage.getItem(RECENT_LINKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentLinks() {
  try {
    sessionStorage.setItem(RECENT_LINKS_KEY, JSON.stringify(recentLinks.slice(0, 12)));
  } catch {
    // Ignore storage errors.
  }
}

function renderRecentLinks() {
  if (!recentLinksList) return;

  if (!recentLinks.length) {
    recentLinksList.innerHTML = '<li class="muted">No links generated in this session.</li>';
    return;
  }

  recentLinksList.innerHTML = recentLinks
    .slice(0, 12)
    .map((item) => `<li><a href="${item.url}" target="_blank" rel="noopener noreferrer">${item.name}</a> <span class="muted">(${new Date(item.createdAt).toLocaleTimeString()})</span></li>`)
    .join('');
}

function addRecentLink(url, name) {
  recentLinks.unshift({ url, name, createdAt: Date.now() });
  while (recentLinks.length > 20) {
    recentLinks.pop();
  }
  saveRecentLinks();
  renderRecentLinks();
}

function updateExpiryUI() {
  if (!expiryPresetSelect || !expiryCustomMinutes || !expiryHelpText || !expiryModeSelect) {
    return;
  }

  const preset = String(expiryPresetSelect.value || '1h');
  const mode = String(expiryModeSelect.value || 'fixed');
  const labels = {
    '15m': '15 minutes',
    '1h': '1 hour',
    '6h': '6 hours',
    '24h': '24 hours',
    '7d': '7 days'
  };

  expiryCustomMinutes.disabled = preset !== 'custom';

  if (preset === 'never') {
    expiryHelpText.textContent = mode === 'first-access'
      ? 'Never-expire cannot be used with first-access mode.'
      : 'Link will not expire.';
    return;
  }

  if (preset === 'custom') {
    expiryHelpText.textContent = mode === 'first-access'
      ? 'Custom duration starts counting from first download.'
      : 'Custom duration starts counting from upload time.';
    return;
  }

  expiryHelpText.textContent = mode === 'first-access'
    ? `Link will expire ${labels[preset] ? `after ${labels[preset]}` : 'after 1 hour'} from first download.`
    : `Link will expire ${labels[preset] ? `in ${labels[preset]}` : 'in 1 hour'} after upload.`;
}

function resolveExpiryPolicy() {
  const preset = String(expiryPresetSelect?.value || '1h');
  const mode = String(expiryModeSelect?.value || 'fixed');

  const minutesByPreset = {
    '15m': 15,
    '1h': 60,
    '6h': 360,
    '24h': 1440,
    '7d': 10080
  };

  let minutes = null;
  if (preset === 'custom') {
    minutes = parsePositiveInt(expiryCustomMinutes?.value || '');
    if (!minutes) {
      throw new Error('Enter a valid custom expiry in minutes.');
    }
  } else if (preset !== 'never') {
    minutes = minutesByPreset[preset] || 60;
  }

  if (mode === 'first-access') {
    if (!minutes) {
      throw new Error('First-access expiry requires a finite duration.');
    }
    return {
      expiryMode: 'first-access',
      ttlMs: minutes * 60 * 1000,
      expiresAt: null
    };
  }

  if (!minutes) {
    return {
      expiryMode: 'fixed',
      ttlMs: null,
      expiresAt: null
    };
  }

  return {
    expiryMode: 'fixed',
    ttlMs: null,
    expiresAt: Date.now() + minutes * 60 * 1000
  };
}

function renderSelectionPreview(files) {
  if (!selectionPreviewBox || !selectionPreviewList) {
    return;
  }

  if (!files.length) {
    selectionPreviewBox.hidden = true;
    selectionPreviewList.innerHTML = '';
    return;
  }

  const previewLimit = 50;
  const items = files.slice(0, previewLimit).map((file) => {
    const path = file.webkitRelativePath || file.name;
    const kb = Math.max(1, Math.round((Number(file.size || 0) / 1024)));
    return `<li>${path} <span class="muted">(${kb} KB)</span></li>`;
  });

  if (files.length > previewLimit) {
    items.push(`<li class="muted">...and ${files.length - previewLimit} more</li>`);
  }

  selectionPreviewList.innerHTML = items.join('');
  selectionPreviewBox.hidden = false;
}

function setSelection(files, isFolder = false) {
  selectedFiles = files;
  selectedIsFolder = isFolder;

  if (!files.length) {
    selection.textContent = 'No file selected.';
    uploadBtn.disabled = true;
    renderSelectionPreview([]);
    return;
  }

  const mode = isFolder ? 'folder' : 'file';
  selection.textContent = `Selected ${files.length} ${mode}${files.length > 1 ? 's' : ''}.`;

  if (files.length === 1 && !files[0].webkitRelativePath) {
    downloadNameInput.value = files[0].name;
  } else {
    downloadNameInput.value = 'Git_never_forgets.zip';
  }

  uploadBtn.disabled = false;
  renderSelectionPreview(files);
}

function showAuthenticatedUI(isAuthenticated) {
  loginBox.hidden = isAuthenticated;
  uploaderBox.hidden = !isAuthenticated;
}

async function checkAuth() {
  try {
    const response = await fetch(getEndpointUrl('adminAuth'), {
      method: 'GET',
      credentials: 'include'
    });

    if (!response.ok) {
      showAuthenticatedUI(false);
      return;
    }

    showAuthenticatedUI(true);
    setStatus('Authenticated. Ready to upload.');
  } catch {
    showAuthenticatedUI(false);
  }
}

async function readJsonOrText(response) {
  const raw = await response.text();
  if (!raw) {
    return { json: null, text: '' };
  }

  try {
    return { json: JSON.parse(raw), text: raw };
  } catch {
    return { json: null, text: raw };
  }
}

function buildUploadErrorMessage(response, payload) {
  const defaultMessage = 'Upload failed. Please try again.';
  const text = (payload.text || '').trim();
  const jsonError = payload.json && typeof payload.json.error === 'string' ? payload.json.error : '';

  if (jsonError) {
    return jsonError;
  }

  if (response.status === 413) {
    return `Upload is too large for this server. Try keeping it under ${MAX_UPLOAD_SIZE_MB} MB.`;
  }

  if (/payload too large|request entity too large|body exceeded|internal error/i.test(text)) {
    return `Upload likely exceeds the server limit. Try keeping it under ${MAX_UPLOAD_SIZE_MB} MB.`;
  }

  return text || defaultMessage;
}

async function buildPayloadFile(files) {
  if (files.length === 1 && !files[0].webkitRelativePath) {
    return files[0];
  }

  const zip = new JSZip();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    zip.file(path, file);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'Git_never_forgets.zip', { type: 'application/zip' });
}

function createQueueItem() {
  const files = selectedFiles.slice();
  if (!files.length) {
    throw new Error('Select file(s) before adding to queue.');
  }

  const customDownloadName = sanitizeDownloadName(downloadNameInput.value || '');
  const policy = resolveExpiryPolicy();
  const linkPassword = String(linkPasswordInput?.value || '').trim();
  const maxDownloads = parsePositiveInt(maxDownloadsInput?.value || '');

  return {
    id: ++queueId,
    files,
    isFolder: selectedIsFolder,
    customDownloadName,
    policy,
    linkPassword,
    maxDownloads,
    status: 'queued',
    error: '',
    resultUrl: '',
    createdAt: Date.now(),
    idempotencyKey: crypto.randomUUID(),
    controller: null
  };
}

function renderQueue() {
  if (!uploadQueueList || !queueSummary) {
    return;
  }

  if (!uploadQueue.length) {
    queueSummary.textContent = 'No queued uploads.';
    uploadQueueList.innerHTML = '';
    return;
  }

  const queuedCount = uploadQueue.filter((item) => item.status === 'queued').length;
  const uploadingCount = uploadQueue.filter((item) => item.status === 'uploading').length;
  const failedCount = uploadQueue.filter((item) => item.status === 'failed').length;

  queueSummary.textContent = `Total: ${uploadQueue.length} | Queued: ${queuedCount} | Uploading: ${uploadingCount} | Failed: ${failedCount}`;

  uploadQueueList.innerHTML = uploadQueue
    .map((item) => {
      const baseName = item.files.length === 1
        ? (item.files[0].webkitRelativePath || item.files[0].name)
        : `${item.files.length} files`;
      const status = item.status.toUpperCase();
      const error = item.error ? `<div class="meta" style="color:#ffb3b3;">${escapeHtml(item.error)}</div>` : '';
      const link = item.resultUrl ? `<div class="meta"><a href="${item.resultUrl}" target="_blank" rel="noopener noreferrer">Open link</a></div>` : '';
      return `
        <div class="queue-item" data-id="${item.id}">
          <div>
            <div><strong>${escapeHtml(baseName)}</strong></div>
            <div class="meta">Status: ${status}</div>
            ${error}
            ${link}
          </div>
          <div class="row" style="margin:0;">
            ${item.status === 'uploading' ? '<button class="small-btn" data-action="cancel">Cancel</button>' : ''}
            ${item.status === 'failed' || item.status === 'cancelled' ? '<button class="small-btn" data-action="retry">Retry</button>' : ''}
            ${item.status !== 'uploading' ? '<button class="small-btn" data-action="remove">Remove</button>' : ''}
          </div>
        </div>
      `;
    })
    .join('');
}

async function processQueue() {
  if (currentUploadingId !== null) {
    return;
  }

  const nextItem = uploadQueue.find((item) => item.status === 'queued');
  if (!nextItem) {
    return;
  }

  currentUploadingId = nextItem.id;
  nextItem.status = 'uploading';
  nextItem.error = '';
  renderQueue();

  try {
    const payloadFile = await buildPayloadFile(nextItem.files);

    if (payloadFile.size > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(`Selected file is ${Math.ceil(payloadFile.size / (1024 * 1024))} MB. Keep uploads under ${MAX_UPLOAD_SIZE_MB} MB.`);
    }

    const formData = new FormData();
    formData.append('file', payloadFile);

    if (nextItem.customDownloadName) {
      formData.append('downloadName', nextItem.customDownloadName);
    }

    formData.append('idempotencyKey', nextItem.idempotencyKey);
    formData.append('expiryMode', nextItem.policy.expiryMode);

    if (nextItem.policy.expiresAt) {
      formData.append('expiresAt', String(nextItem.policy.expiresAt));
    }
    if (nextItem.policy.ttlMs) {
      formData.append('ttlMs', String(nextItem.policy.ttlMs));
    }
    if (nextItem.linkPassword) {
      formData.append('linkPassword', nextItem.linkPassword);
    }
    if (nextItem.maxDownloads) {
      formData.append('maxDownloads', String(nextItem.maxDownloads));
    }

    setStatus(`Uploading queue item #${nextItem.id}...`);

    const controller = new AbortController();
    nextItem.controller = controller;

    const response = await fetch(getEndpointUrl('upload'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-idempotency-key': nextItem.idempotencyKey },
      body: formData,
      signal: controller.signal
    });

    const payload = await readJsonOrText(response);
    if (!response.ok) {
      throw new Error(buildUploadErrorMessage(response, payload));
    }

    if (!payload.json || !payload.json.url) {
      throw new Error('Upload finished but server response was invalid.');
    }

    const result = payload.json;
    const shareUrl = new URL(result.url, window.location.origin);
    if (nextItem.customDownloadName) {
      shareUrl.searchParams.set('name', nextItem.customDownloadName);
    }

    nextItem.resultUrl = shareUrl.toString();
    nextItem.status = 'done';

    resultLink.href = nextItem.resultUrl;
    resultLink.textContent = nextItem.resultUrl;
    resultBox.hidden = false;

    addRecentLink(nextItem.resultUrl, nextItem.customDownloadName || payloadFile.name || 'download');
    setStatus(`Upload complete for queue item #${nextItem.id}.`);
  } catch (error) {
    if (error?.name === 'AbortError') {
      nextItem.status = 'cancelled';
      nextItem.error = 'Upload cancelled.';
      setStatus(`Upload cancelled for queue item #${nextItem.id}.`);
    } else {
      nextItem.status = 'failed';
      nextItem.error = error?.message || 'Upload failed';
      setStatus(`Error: ${nextItem.error}`);
    }
  } finally {
    nextItem.controller = null;
    currentUploadingId = null;
    renderQueue();
    processQueue();
  }
}

function handleQueueAction(action, item) {
  if (!item) return;

  if (action === 'cancel' && item.status === 'uploading' && item.controller) {
    item.controller.abort();
    return;
  }

  if (action === 'retry' && (item.status === 'failed' || item.status === 'cancelled')) {
    item.status = 'queued';
    item.error = '';
    item.idempotencyKey = crypto.randomUUID();
    renderQueue();
    processQueue();
    return;
  }

  if (action === 'remove' && item.status !== 'uploading') {
    const idx = uploadQueue.findIndex((q) => q.id === item.id);
    if (idx >= 0) {
      uploadQueue.splice(idx, 1);
      renderQueue();
    }
  }
}

loginBtn?.addEventListener('click', async () => {
  const username = (usernameInput?.value || '').trim();
  const password = passwordInput?.value || '';

  if (!username || !password) {
    setStatus('Enter username and password.');
    return;
  }

  loginBtn.disabled = true;
  setStatus('Signing in...');

  try {
    const response = await fetch(getEndpointUrl('adminAuth'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || 'Login failed');
    }

    showAuthenticatedUI(true);
    if (passwordInput) {
      passwordInput.value = '';
    }
    setStatus('Login successful.');
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn?.addEventListener('click', async () => {
  await fetch(getEndpointUrl('adminAuth'), {
    method: 'DELETE',
    credentials: 'include'
  });
  showAuthenticatedUI(false);
  setStatus('Logged out.');
});

pickFilesBtn?.addEventListener('click', () => fileInput.click());
pickFolderBtn?.addEventListener('click', () => folderInput.click());

fileInput?.addEventListener('change', () => {
  setSelection(Array.from(fileInput.files || []), false);
});

folderInput?.addEventListener('change', () => {
  setSelection(Array.from(folderInput.files || []), true);
});

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evtName) => {
  dropZone?.addEventListener(evtName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  document.addEventListener(evtName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
});

dropZone?.addEventListener('dragenter', () => {
  dragCounter += 1;
  dropZone.classList.add('drag');
});

dropZone?.addEventListener('dragleave', () => {
  dragCounter -= 1;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropZone.classList.remove('drag');
  }
});

dropZone?.addEventListener('drop', (event) => {
  dragCounter = 0;
  dropZone.classList.remove('drag');
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) {
    setSelection(files, files.some((f) => f.webkitRelativePath));
  }
});

uploadBtn?.addEventListener('click', () => {
  try {
    const item = createQueueItem();
    uploadQueue.push(item);
    renderQueue();
    processQueue();
    setStatus(`Added queue item #${item.id}.`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

uploadQueueList?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const wrapper = target.closest('.queue-item');
  if (!wrapper) {
    return;
  }

  const id = Number.parseInt(wrapper.getAttribute('data-id') || '', 10);
  if (!Number.isFinite(id)) {
    return;
  }

  const item = uploadQueue.find((q) => q.id === id);
  const action = target.getAttribute('data-action') || '';
  handleQueueAction(action, item);
});

copyBtn?.addEventListener('click', async () => {
  if (!resultLink.href || resultLink.href === '#') return;
  await navigator.clipboard.writeText(resultLink.href);
  setStatus('Link copied to clipboard.');
});

downloadBtn?.addEventListener('click', async () => {
  if (!resultLink.href || resultLink.href === '#') return;

  const response = await fetch(resultLink.href);
  if (!response.ok) {
    setStatus('Unable to download file.');
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fallbackName = sanitizeDownloadName(downloadNameInput.value || '') || 'download.bin';
  a.href = url;
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus(`Downloaded as ${fallbackName}`);
});

expiryPresetSelect?.addEventListener('change', updateExpiryUI);
expiryModeSelect?.addEventListener('change', updateExpiryUI);

renderRecentLinks();
renderQueue();
updateExpiryUI();
checkAuth();
