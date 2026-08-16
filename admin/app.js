const loginView = document.getElementById('login-view');
const editorView = document.getElementById('editor-view');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const content = document.getElementById('content');
const saveBtn = document.getElementById('save-btn');
const saveError = document.getElementById('save-error');
const saveStatus = document.getElementById('save-status');
const charCount = document.getElementById('char-count');
const lastSaved = document.getElementById('last-saved');
const previewBtn = document.getElementById('preview-btn');
const editorPane = document.getElementById('editor-pane');
const previewPane = document.getElementById('preview-pane');
const previewFrame = document.getElementById('preview-frame');
const logoutBtn = document.getElementById('logout-btn');
const fileSelect = document.getElementById('file-select');
const editingLabel = document.getElementById('editing-label');
const openPublic = document.getElementById('open-public');

let currentFile = 'index.html';
let dirty = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

function setEditingMeta(file) {
  currentFile = file;
  editingLabel.textContent = `public/${file}`;
  openPublic.href = '/' + file.replace(/^\/+/, '');
  openPublic.title = `Open /${file} in a new tab`;
  if (fileSelect.value !== file) fileSelect.value = file;
}

function updateCharCount() {
  charCount.textContent = `${content.value.length} chars (${new Blob([content.value]).size.toLocaleString()} bytes)`;
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadFileList() {
  const { files } = await api('/admin/api/files');
  fileSelect.innerHTML = '';
  if (!files.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no editable files in public/)';
    fileSelect.appendChild(opt);
    return files;
  }
  for (const f of files) {
    const opt = document.createElement('option');
    opt.value = f.path;
    opt.textContent = `${f.path}  (${formatSize(f.size)})`;
    fileSelect.appendChild(opt);
  }
  return files;
}

async function loadFile(file) {
  clearError(saveError);
  saveStatus.textContent = '';
  const data = await api('/admin/api/content?file=' + encodeURIComponent(file));
  content.value = data.content;
  setEditingMeta(data.file);
  dirty = false;
  lastSaved.textContent = data.savedAt ? `Last saved: ${new Date(data.savedAt).toLocaleString()}` : '';
  updateCharCount();
  // Reset preview if open
  if (!previewPane.classList.contains('hidden')) {
    previewFrame.srcdoc = content.value;
  }
}

async function init() {
  try {
    const { authed } = await api('/admin/api/session');
    if (authed) {
      await showEditor();
    } else {
      loginView.classList.remove('hidden');
      passwordInput.focus();
    }
  } catch (err) {
    showError(loginError, 'Cannot reach the server.');
  }
}

async function showEditor() {
  loginView.classList.add('hidden');
  editorView.classList.remove('hidden');
  const files = await loadFileList();
  const preferred =
    (files.find((f) => f.path === 'index.html') && 'index.html') ||
    (files[0] && files[0].path) ||
    'index.html';
  await loadFile(preferred);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError(loginError);
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  try {
    await api('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: passwordInput.value }),
    });
    passwordInput.value = '';
    await showEditor();
  } catch (err) {
    showError(loginError, err.message);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
  }
});

fileSelect.addEventListener('change', async () => {
  const next = fileSelect.value;
  if (!next || next === currentFile) return;
  if (dirty && !confirm(`Unsaved changes in ${currentFile}. Switch file anyway?`)) {
    fileSelect.value = currentFile;
    return;
  }
  try {
    await loadFile(next);
  } catch (err) {
    showError(saveError, err.message);
    fileSelect.value = currentFile;
  }
});

saveBtn.addEventListener('click', async () => {
  clearError(saveError);
  saveStatus.textContent = '';
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const data = await api('/admin/api/content', {
      method: 'POST',
      body: JSON.stringify({ file: currentFile, content: content.value }),
    });
    dirty = false;
    saveStatus.textContent = `Saved ${data.file} at ${new Date(data.savedAt).toLocaleTimeString()}`;
    lastSaved.textContent = `Last saved: ${new Date(data.savedAt).toLocaleString()}`;
    // Refresh sizes in the picker without losing selection
    const keep = currentFile;
    await loadFileList();
    fileSelect.value = keep;
  } catch (err) {
    showError(saveError, err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
  }
});

content.addEventListener('input', () => {
  dirty = true;
  saveStatus.textContent = 'Unsaved changes';
  updateCharCount();
});

previewBtn.addEventListener('click', () => {
  const showingPreview = !previewPane.classList.contains('hidden');
  if (showingPreview) {
    previewPane.classList.add('hidden');
    editorPane.classList.remove('hidden');
    previewBtn.textContent = 'Preview';
  } else {
    previewFrame.srcdoc = content.value;
    editorPane.classList.add('hidden');
    previewPane.classList.remove('hidden');
    previewBtn.textContent = 'Edit';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/admin/api/logout', { method: 'POST' });
  } catch {
    /* session may already be gone; force client-side switch anyway */
  }
  location.reload();
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

init();
