import { APP_ROUTES, getEndpointUrl } from './app-config.js';

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
const resultQrCanvas = document.getElementById('resultQrCanvas');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const downloadNameInput = document.getElementById('downloadNameInput');
const loginBox = document.getElementById('loginBox');
const uploaderBox = document.getElementById('uploaderBox');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const historyNavLink = document.getElementById('historyNavLink');

let selectedFiles = [];
let pendingIdempotencyKey = '';

const MAX_UPLOAD_SIZE_MB = 5;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

function setStatus(message) {
  statusEl.textContent = message;
}

function setSelection(files, isFolder = false) {
  selectedFiles = files;
  pendingIdempotencyKey = '';
  if (!files.length) {
    selection.textContent = 'No file selected.';
    uploadBtn.disabled = true;
    return;
  }
  const mode = isFolder ? 'folder' : 'file';
  selection.textContent = `Selected ${files.length} ${mode}${files.length > 1 ? 's' : ''}.`;
  if (files.length === 1 && !files[0].webkitRelativePath) {
    downloadNameInput.value = files[0].name;
  } else {
    downloadNameInput.value = 'Git_never_forgets.zip';
  }
  pendingIdempotencyKey = crypto.randomUUID();
  uploadBtn.disabled = false;
}

function sanitizeDownloadName(name) {
  return name.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function generateQRCode(canvas, url) {
  if (!canvas || !url) return;
  
  if (typeof QRCode === 'undefined') {
    console.warn('QRCode library not loaded yet, waiting...');
    setTimeout(() => generateQRCode(canvas, url), 100);
    return;
  }
  
  try {
    QRCode.toCanvas(canvas, url, {
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
    console.error('Error generating QR code:', error);
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

function showAuthenticatedUI(isAuthenticated) {
  loginBox.hidden = isAuthenticated;
  uploaderBox.hidden = !isAuthenticated;
}

if (historyNavLink) {
  historyNavLink.href = APP_ROUTES.history;
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

checkAuth();

pickFilesBtn.addEventListener('click', () => fileInput.click());
pickFolderBtn.addEventListener('click', () => folderInput.click());

fileInput.addEventListener('change', () => {
  setSelection(Array.from(fileInput.files || []), false);
});

folderInput.addEventListener('change', () => {
  setSelection(Array.from(folderInput.files || []), true);
});

let dragCounter = 0;

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evtName) => {
  dropZone.addEventListener(evtName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  
  document.addEventListener(evtName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
});

dropZone.addEventListener('dragenter', (event) => {
  dragCounter++;
  dropZone.classList.add('drag');
});

dropZone.addEventListener('dragleave', (event) => {
  dragCounter--;
  if (dragCounter === 0) {
    dropZone.classList.remove('drag');
  }
});

dropZone.addEventListener('drop', (event) => {
  dragCounter = 0;
  dropZone.classList.remove('drag');
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) {
    setSelection(files, files.some((f) => f.webkitRelativePath));
  }
});

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

uploadBtn.addEventListener('click', async () => {
  if (!selectedFiles.length) return;

  try {
    setStatus('Preparing upload...');
    uploadBtn.disabled = true;

    const payloadFile = await buildPayloadFile(selectedFiles);

    if (payloadFile.size > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(`Selected file is ${Math.ceil(payloadFile.size / (1024 * 1024))} MB. Keep uploads under ${MAX_UPLOAD_SIZE_MB} MB.`);
    }

    const customDownloadName = sanitizeDownloadName(downloadNameInput.value || '');
    if (!pendingIdempotencyKey) {
      pendingIdempotencyKey = crypto.randomUUID();
    }

    const formData = new FormData();
    formData.append('file', payloadFile);
    if (customDownloadName) {
      formData.append('downloadName', customDownloadName);
    }
    if (pendingIdempotencyKey) {
      formData.append('idempotencyKey', pendingIdempotencyKey);
    }

    setStatus('Uploading to blob store...');
    const response = await fetch(getEndpointUrl('upload'), {
      method: 'POST',
      credentials: 'include',
      headers: pendingIdempotencyKey ? { 'x-idempotency-key': pendingIdempotencyKey } : undefined,
      body: formData
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
    if (customDownloadName) {
      shareUrl.searchParams.set('name', customDownloadName);
    }

    resultLink.href = shareUrl.toString();
    resultLink.textContent = shareUrl.toString();
    
    generateQRCode(resultQrCanvas, shareUrl.toString());
    
    resultBox.hidden = false;
    setStatus('Upload complete. Share the link below.');
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    uploadBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  if (!resultLink.href || resultLink.href === '#') return;
  await navigator.clipboard.writeText(resultLink.href);
  setStatus('Link copied to clipboard.');
});

downloadBtn.addEventListener('click', async () => {
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
