'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const SESSION_COOKIE = 'athari_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_STORAGE_BYTES = 200 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_ITEM = 10;
const MAX_ACTIVE_SESSIONS = 12;
const SECURE_COOKIES = process.env.ATHARI_SECURE_COOKIES === '1';

const SCRYPT = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
  keylen: 64,
});

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

function verifySecret(secret, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(String(secret), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Used to keep response timing similar when an account does not exist.
const DUMMY_PASSWORD_HASH = hashSecret(crypto.randomBytes(24).toString('hex'));

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return email.length >= 5 && email.length <= 254 && EMAIL_RE.test(email);
}

function passwordProblem(password) {
  if (typeof password !== 'string') return 'كلمة المرور غير صالحة.';
  if (password.length < 8) return 'يجب أن تتكوّن كلمة المرور من 8 أحرف على الأقل.';
  if (password.length > 200) return 'كلمة المرور طويلة جدًا.';
  if (!/\p{L}/u.test(password)) return 'أضف حرفًا واحدًا على الأقل إلى كلمة المرور.';
  if (!/\d/u.test(password)) return 'أضف رقمًا واحدًا على الأقل إلى كلمة المرور.';
  return '';
}

function generateRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < 16; i += 1) {
    raw += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return raw.match(/.{4}/g).join('-');
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value when it is not valid percent-encoding.
    }
    if (name) out[name] = value;
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${options.path || '/'}`);
  if (typeof options.maxAge === 'number') bits.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly !== false) bits.push('HttpOnly');
  bits.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure || SECURE_COOKIES) bits.push('Secure');
  return bits.join('; ');
}

function sessionCookie(token, maxAgeMs = SESSION_TTL_MS) {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(maxAgeMs / 1000),
    httpOnly: true,
    sameSite: 'Lax',
  });
}

function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
  });
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanText(value, maxLength = 5000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function isValidDate(value) {
  if (!value) return true;
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  return year >= 1900 && year <= 2100 && date.toISOString().startsWith(value);
}

function isValidHttpUrl(value) {
  if (!value) return true;
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

const FILE_TYPES = new Map(Object.entries({
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  png: { mime: 'image/png', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  pdf: { mime: 'application/pdf', kind: 'pdf' },
  doc: { mime: 'application/msword', kind: 'document' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' },
  xls: { mime: 'application/vnd.ms-excel', kind: 'document' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document' },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'document' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document' },
  txt: { mime: 'text/plain', kind: 'text' },
  csv: { mime: 'text/csv', kind: 'text' },
  zip: { mime: 'application/zip', kind: 'archive' },
}));

const MIME_TO_KIND = new Map();
for (const info of FILE_TYPES.values()) {
  if (!MIME_TO_KIND.has(info.mime)) MIME_TO_KIND.set(info.mime, info.kind);
}

function getFileType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase().replace('.', '');
  return FILE_TYPES.get(ext) || null;
}

function hasValidMagic(buffer, ext) {
  const startsWith = (...bytes) => bytes.every((byte, index) => buffer[index] === byte);
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'gif':
      return buffer.slice(0, 6).toString('ascii') === 'GIF87a'
        || buffer.slice(0, 6).toString('ascii') === 'GIF89a';
    case 'webp':
      return buffer.slice(0, 4).toString('ascii') === 'RIFF'
        && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    case 'pdf':
      return buffer.slice(0, 5).toString('ascii') === '%PDF-';
    case 'doc':
    case 'xls':
    case 'ppt':
      return startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'zip':
      return startsWith(0x50, 0x4b, 0x03, 0x04);
    case 'txt':
    case 'csv':
      return !buffer.subarray(0, 4096).includes(0x00);
    default:
      return false;
  }
}

function sanitizeOriginalFilename(filename) {
  let name = path.basename(String(filename || 'ملف')).replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[^\p{L}\p{N}\s._()\-]/gu, '_').trim();
  name = name.replace(/\s+/g, ' ');
  if (!name) name = 'ملف';
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function decodeBase64File(data, filename, declaredMime) {
  const info = getFileType(filename);
  if (!info) return { error: 'نوع الملف غير مدعوم. يمكنك إرفاق صور أو PDF أو ملفات Office أو النصوص والملفات المضغوطة.' };
  if (typeof data !== 'string' || !data) return { error: 'تعذّر قراءة الملف.' };
  const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return { error: 'بيانات الملف غير صالحة.' };
  const estimatedBytes = Math.floor((base64.replace(/\s/g, '').length * 3) / 4);
  if (estimatedBytes > MAX_FILE_BYTES) {
    return { error: `حجم الملف كبير جدًا. الحد الأقصى ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} ميجابايت.` };
  }
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { error: 'تعذّر قراءة الملف.' };
  }
  if (!buffer.length) return { error: 'الملف فارغ.' };
  if (buffer.length > MAX_FILE_BYTES) {
    return { error: `حجم الملف كبير جدًا. الحد الأقصى ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} ميجابايت.` };
  }
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (!hasValidMagic(buffer, ext)) return { error: 'محتوى الملف لا يطابق نوعه أو أنه تالف.' };
  if (declaredMime && !['application/octet-stream', info.mime].includes(String(declaredMime).toLowerCase())) {
    return { error: 'نوع محتوى الملف غير مطابق لامتداده.' };
  }
  return {
    buffer,
    ext,
    mime: info.mime,
    kind: info.kind,
    originalName: sanitizeOriginalFilename(filename),
    size: buffer.length,
  };
}

class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  hit(key, limit, windowMs) {
    const now = Date.now();
    const bucket = (this.buckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (bucket.length >= limit) {
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfter: Math.ceil((windowMs - (now - bucket[0])) / 1000) };
    }
    bucket.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfter: 0 };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.buckets) {
      const fresh = timestamps.filter((timestamp) => now - timestamp < 24 * 60 * 60 * 1000);
      if (fresh.length) this.buckets.set(key, fresh);
      else this.buckets.delete(key);
    }
  }
}

function getClientIp(req) {
  if (process.env.ATHARI_TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isJsonContentType(contentType) {
  return String(contentType || '').toLowerCase().startsWith('application/json');
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  MAX_FILE_BYTES,
  MAX_TOTAL_STORAGE_BYTES,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_ACTIVE_SESSIONS,
  SECURE_COOKIES,
  DUMMY_PASSWORD_HASH,
  hashSecret,
  verifySecret,
  normalizeEmail,
  isValidEmail,
  passwordProblem,
  generateRecoveryCode,
  normalizeRecoveryCode,
  createSessionToken,
  hashToken,
  createCsrfToken,
  parseCookies,
  serializeCookie,
  sessionCookie,
  clearSessionCookie,
  safeEqualText,
  cleanText,
  isValidDate,
  isValidHttpUrl,
  isUuid,
  getFileType,
  sanitizeOriginalFilename,
  decodeBase64File,
  RateLimiter,
  getClientIp,
  isJsonContentType,
  MIME_TO_KIND,
};
