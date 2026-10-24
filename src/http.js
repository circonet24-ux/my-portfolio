'use strict';

const crypto = require('node:crypto');
const { db } = require('./database');
const {
  SESSION_COOKIE,
  hashToken,
  parseCookies,
  safeEqualText,
} = require('./security');

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_JSON_BYTES = 12 * 1024 * 1024;

function applySecurityHeaders(req, res) {
  const isSecure = req.socket?.encrypted || process.env.ATHARI_SECURE_COOKIES === '1';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self'",
      "manifest-src 'self'",
    ].join('; '),
  );
  if (isSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  setNoStore(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

function readJsonBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength && contentLength > limit + 1024) {
      const error = new Error('حجم الطلب أكبر من المسموح.');
      error.statusCode = 413;
      req.resume();
      reject(error);
      return;
    }

    let total = 0;
    let finished = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (finished) return;
      total += chunk.length;
      if (total > limit) {
        finished = true;
        const error = new Error('حجم الطلب أكبر من المسموح.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const error = new Error('صيغة البيانات غير صالحة.');
          error.statusCode = 400;
          reject(error);
          return;
        }
        resolve(parsed);
      } catch {
        const error = new Error('تعذّر قراءة البيانات المرسلة.');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('aborted', () => {
      if (finished) return;
      finished = true;
      const error = new Error('أُوقف إرسال الطلب.');
      error.statusCode = 400;
      reject(error);
    });

    req.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

function getAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token || typeof token !== 'string') return null;
  const now = Date.now();
  const row = db.prepare(`
    SELECT s.token_hash, s.csrf_token, s.expires_at, s.last_seen_at,
           u.id AS user_id, u.name, u.email, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(hashToken(token), now);
  if (!row) return null;
  if (now - Number(row.last_seen_at) > 5 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, row.token_hash);
  }
  return {
    token,
    csrfToken: row.csrf_token,
    expiresAt: Number(row.expires_at),
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      createdAt: row.created_at,
    },
  };
}

function requireCsrf(req, res, auth) {
  const header = String(req.headers['x-csrf-token'] || '');
  if (!header || !safeEqualText(header, auth.csrfToken)) {
    sendError(res, 403, 'انتهت صلاحية الجلسة أو أن الطلب غير موثوق. حدّث الصفحة وحاول مجددًا.');
    return false;
  }
  return true;
}

function checkOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'cross-site') return false;

  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;

  const configuredOrigin = process.env.ATHARI_ORIGIN;
  if (configuredOrigin) return origin === configuredOrigin.replace(/\/$/, '');

  try {
    const originHost = new URL(origin).host;
    return originHost === req.headers.host;
  } catch {
    return false;
  }
}

function verifyMutation(req, res, auth) {
  if (!checkOrigin(req)) {
    sendError(res, 403, 'تم رفض الطلب لأنه لم يأتِ من نطاق التطبيق.');
    return false;
  }
  if (!auth) {
    sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
    return false;
  }
  return requireCsrf(req, res, auth);
}

function sanitizeId(value) {
  const id = String(value || '');
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function addActivity(userId, kind, section = '', title = '') {
  db.prepare(`
    INSERT INTO activity (id, user_id, kind, section, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, kind, section, title.slice(0, 200), new Date().toISOString());
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back.
    }
    throw error;
  }
}

function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function attachmentToClient(row) {
  return {
    id: row.id,
    name: row.original_name,
    mime: row.mime,
    size: Number(row.size),
    kind: row.mime.startsWith('image/') ? 'image' : (row.mime === 'application/pdf' ? 'pdf' : 'file'),
    url: `/api/attachments/${encodeURIComponent(row.id)}`,
    downloadUrl: `/api/attachments/${encodeURIComponent(row.id)}?download=1`,
    createdAt: row.created_at,
  };
}

function getProfilePhoto(userId) {
  return db.prepare(`
    SELECT * FROM attachments
    WHERE user_id = ? AND scope = 'profile'
    ORDER BY created_at DESC LIMIT 1
  `).get(userId) || null;
}

function photoUrlFor(userId) {
  const photo = getProfilePhoto(userId);
  return photo ? `/api/attachments/${encodeURIComponent(photo.id)}` : null;
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

module.exports = {
  MAX_JSON_BYTES,
  MAX_UPLOAD_JSON_BYTES,
  applySecurityHeaders,
  setNoStore,
  sendJson,
  sendError,
  readJsonBody,
  getAuth,
  requireCsrf,
  checkOrigin,
  verifyMutation,
  sanitizeId,
  addActivity,
  transaction,
  safeParseJson,
  attachmentToClient,
  getProfilePhoto,
  photoUrlFor,
  parseTags,
};
