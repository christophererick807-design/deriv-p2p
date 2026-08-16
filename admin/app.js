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
  const data = await api('/admin/api/content');
  content.value = data.content;
  lastSaved.textContent = data.savedAt ? `Last saved: ${new Date(data.savedAt).toLocaleString()}` : '';
  updateCharCount();
}

function updateCharCount() {
  charCount.textContent = `${content.value.length} chars (${new Blob([content.value]).size.toLocaleString()} bytes)`;
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

saveBtn.addEventListener('click', async () => {
  clearError(saveError);
  saveStatus.textContent = '';
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const data = await api('/admin/api/content', {
      method: 'POST',
      body: JSON.stringify({ content: content.value }),
    });
    saveStatus.textContent = `Saved at ${new Date(data.savedAt).toLocaleTimeString()}`;
    lastSaved.textContent = `Last saved: ${new Date(data.savedAt).toLocaleString()}`;
  } catch (err) {
    showError(saveError, err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
  }
});

content.addEventListener('input', () => {
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

init();
