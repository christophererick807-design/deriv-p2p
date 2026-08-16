require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_EXTS = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.svg', '.xml']);

const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');

// In-memory session store: token -> expiry timestamp (server restart logs everyone out)
const sessions = new Map();
// Login rate limiter: ip -> { failures, lockedUntil }
const loginAttempts = new Map();

const app = express();
app.disable('x-powered-by');
// CSP is intentionally left off: the whole point of the admin panel is to edit
// raw HTML (which may contain inline scripts/styles). SameSite=Strict cookie +
// Origin checks cover the CSRF angle instead.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------- helpers

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// State-changing requests must come from the same origin the browser sees.
// Blocks classic CSRF even if a SameSite cookie were somehow forwarded.
function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.host === req.get('host') && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function checkRateLimit(ip) {
  const rec = loginAttempts.get(ip);
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { failures: 0, lockedUntil: 0 };
  rec.failures += 1;
  if (rec.failures >= 10) {
    rec.lockedUntil = now + 15 * 60 * 1000; // lock for 15 minutes
    rec.failures = 0;
  }
  loginAttempts.set(ip, rec);
}

function recordSuccess(ip) {
  loginAttempts.delete(ip);
}

/**
 * Resolve a user-supplied relative path to an absolute file under PUBLIC_DIR.
 * Rejects traversal, absolute paths, null bytes, and disallowed extensions.
 * Returns { ok: true, abs, rel } or { ok: false, error, status }.
 */
function resolvePublicFile(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { ok: false, status: 400, error: 'file is required' };
  }
  // Normalize separators and strip leading slashes
  let rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.includes('\0') || rel.includes('..')) {
    return { ok: false, status: 400, error: 'Invalid file path' };
  }
  const abs = path.resolve(PUBLIC_DIR, rel);
  const publicRoot = path.resolve(PUBLIC_DIR) + path.sep;
  if (abs !== path.resolve(PUBLIC_DIR) && !abs.startsWith(publicRoot)) {
    return { ok: false, status: 400, error: 'Invalid file path' };
  }
  const ext = path.extname(abs).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, status: 400, error: `File type not allowed (${ext || 'none'})` };
  }
  return { ok: true, abs, rel: path.relative(PUBLIC_DIR, abs).split(path.sep).join('/') };
}

/** Recursively list editable files under PUBLIC_DIR (relative POSIX paths). */
function listPublicFiles(dir = PUBLIC_DIR, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listPublicFiles(full, rel));
    } else if (st.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (ALLOWED_EXTS.has(ext)) {
        out.push({
          path: rel,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ---------------------------------------------------------------- routes

// Admin UI shell (login + editor are handled client-side)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

app.get('/admin/api/session', (req, res) => {
  res.json({ authed: isAuthenticated(req) });
});

app.post('/admin/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const rl = checkRateLimit(ip);
  if (rl.locked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${rl.retryAfter}s.` });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !safeEqual(password, ADMIN_PASSWORD)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  recordSuccess(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/admin/api/logout', requireAuth, (req, res) => {
  const token = parseCookies(req).admin_session;
  sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// List editable files under public/ (including nested folders)
app.get('/admin/api/files', requireAuth, (req, res) => {
  try {
    const files = listPublicFiles();
    res.json({ files });
  } catch (err) {
    console.error('Failed to list public files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Read a file under public/ (?file=index.html or nested/path.html)
app.get('/admin/api/content', requireAuth, (req, res) => {
  const resolved = resolvePublicFile(req.query.file || 'index.html');
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isFile()) {
    return res.status(404).json({ error: `File not found: ${resolved.rel}` });
  }
  try {
    const content = fs.readFileSync(resolved.abs, 'utf8');
    const stat = fs.statSync(resolved.abs);
    res.json({
      file: resolved.rel,
      content,
      savedAt: stat.mtime.toISOString(),
      size: stat.size,
    });
  } catch (err) {
    console.error('Failed to read file:', err);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// Overwrite a file under public/ (body: { file, content })
app.post('/admin/api/content', requireAuth, (req, res) => {
  if (!sameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  const { content, file } = req.body || {};
  const resolved = resolvePublicFile(file || 'index.html');
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Content too large (max 2 MB)' });
  }
  // Only allow writing existing files (or create if parent dir is still under public)
  const parent = path.dirname(resolved.abs);
  if (!parent.startsWith(path.resolve(PUBLIC_DIR)) && parent !== path.resolve(PUBLIC_DIR)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (!fs.existsSync(resolved.abs)) {
    return res.status(404).json({ error: `File not found: ${resolved.rel}. Create it on disk first.` });
  }
  try {
    fs.writeFileSync(resolved.abs, content, 'utf8');
  } catch (err) {
    console.error('Failed to write file:', err);
    return res.status(500).json({ error: 'Failed to save. Check filesystem permissions.' });
  }
  res.json({ ok: true, file: resolved.rel, savedAt: new Date().toISOString() });
});

// Admin assets (style.css, app.js) - mounted AFTER the API routes so they win
app.use('/admin', express.static(ADMIN_DIR));

// Public site
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// JSON errors for malformed/oversized bodies (body-parser)
app.use((err, req, res, next) => {
  if (err && err.status >= 400 && err.status < 500 && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Content too large (max 2 MB)' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`DERIV-APP running on http://localhost:${PORT}`);
  console.log(`Admin panel:   http://localhost:${PORT}/admin`);
  console.log(
    `Admin password: ${process.env.ADMIN_PASSWORD ? '(from env/.env)' : 'DEFAULT "change-me-now" - set ADMIN_PASSWORD!'}`
  );
});
