'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, UPLOAD_DIR } = require('./database');
const {
  SESSION_TTL_MS,
  MAX_FILE_BYTES,
  MAX_TOTAL_STORAGE_BYTES,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_ACTIVE_SESSIONS,
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
  sessionCookie,
  clearSessionCookie,
  cleanText,
  isValidDate,
  isValidHttpUrl,
  isUuid,
  decodeBase64File,
  RateLimiter,
  getClientIp,
  isJsonContentType,
} = require('./security');
const {
  MAX_JSON_BYTES,
  MAX_UPLOAD_JSON_BYTES,
  sendJson,
  sendError,
  readJsonBody,
  getAuth,
  requireCsrf,
  verifyMutation,
  checkOrigin,
  sanitizeId,
  addActivity,
  transaction,
  safeParseJson,
  attachmentToClient,
  getProfilePhoto,
  photoUrlFor,
  parseTags,
} = require('./http');

const limiter = new RateLimiter();

const SECTIONS = new Set(['achievements', 'evidence', 'plans', 'reports']);
const PLAN_STATUSES = new Set(['not_started', 'in_progress', 'completed', 'paused']);
const REPORT_STATUSES = new Set(['draft', 'final', 'approved']);
const EVIDENCE_TYPES = new Set(['note', 'file', 'link']);

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.statusCode = status;
    this.extra = extra;
  }
}

function assert(condition, status, message) {
  if (!condition) throw new ApiError(status, message);
}

function requireJson(req) {
  assert(isJsonContentType(req.headers['content-type']), 415, 'يجب إرسال البيانات بصيغة JSON.');
}

function protectMutation(req, res, auth) {
  if (!verifyMutation(req, res, auth)) return false;
  return true;
}

function getFullUser(userId) {
  return db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(userId) || null;
}

function currentSessionPayload(auth) {
  const profile = db.prepare(`
    SELECT job_title, organization, full_name FROM profiles WHERE user_id = ?
  `).get(auth.user.id);
  return {
    user: {
      ...auth.user,
      name: profile?.full_name || auth.user.name,
      jobTitle: profile?.job_title || '',
      organization: profile?.organization || '',
    },
    csrfToken: auth.csrfToken,
    expiresAt: auth.expiresAt,
    photoUrl: photoUrlFor(auth.user.id),
  };
}

function createSession(userId, req, res) {
  const token = createSessionToken();
  const csrfToken = createCsrfToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const tokenHash = hashToken(token);

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_token, user_agent, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    userId,
    csrfToken,
    String(req.headers['user-agent'] || '').slice(0, 300),
    now,
    now,
    expiresAt,
  );

  const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(userId).count;
  if (sessionCount > MAX_ACTIVE_SESSIONS) {
    db.prepare(`
      DELETE FROM sessions
      WHERE token_hash IN (
        SELECT token_hash FROM sessions
        WHERE user_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `).run(userId, sessionCount - MAX_ACTIVE_SESSIONS);
  }

  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS));
  return { csrfToken, expiresAt };
}

function sanitizeTags(value) {
  const tags = [];
  for (const tag of parseTags(value)) {
    const cleaned = cleanText(tag, 36);
    if (cleaned && !tags.includes(cleaned)) tags.push(cleaned);
    if (tags.length >= 10) break;
  }
  return tags;
}

function profileRowToClient(row) {
  return {
    fullName: row.full_name,
    jobTitle: row.job_title,
    organization: row.organization,
    specialization: row.specialization,
    location: row.location,
    email: row.email,
    phone: row.phone,
    website: row.website,
    bio: row.bio,
    yearsExperience: row.years_experience,
    skills: safeParseJson(row.skills_json, []),
    updatedAt: row.updated_at,
  };
}

function ensureProfile(userId) {
  let row = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (row) return row;
  const now = new Date().toISOString();
  const user = getFullUser(userId);
  db.prepare(`
    INSERT INTO profiles (user_id, full_name, updated_at) VALUES (?, ?, ?)
  `).run(userId, user?.name || '', now);
  row = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  return row;
}

function getCompleteness(userId, row) {
  const photo = getProfilePhoto(userId);
  const checks = [
    { key: 'fullName', label: 'الاسم الكامل', weight: 15, ok: Boolean(row.full_name?.trim()) },
    { key: 'jobTitle', label: 'المسمى المهني', weight: 15, ok: Boolean(row.job_title?.trim()) },
    { key: 'organization', label: 'جهة العمل', weight: 10, ok: Boolean(row.organization?.trim()) },
    { key: 'specialization', label: 'التخصص', weight: 10, ok: Boolean(row.specialization?.trim()) },
    { key: 'bio', label: 'نبذة مهنية', weight: 15, ok: Boolean(row.bio?.trim().length >= 40) },
    { key: 'phone', label: 'رقم التواصل', weight: 5, ok: Boolean(row.phone?.trim()) },
    { key: 'location', label: 'الموقع', weight: 5, ok: Boolean(row.location?.trim()) },
    { key: 'skills', label: 'ثلاث مهارات على الأقل', weight: 15, ok: safeParseJson(row.skills_json, []).length >= 3 },
    { key: 'photo', label: 'صورة شخصية', weight: 10, ok: Boolean(photo) },
  ];
  const percent = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0);
  return {
    percent,
    missing: checks.filter((check) => !check.ok).map((check) => check.label),
  };
}

function profilePayload(userId) {
  const row = ensureProfile(userId);
  return {
    profile: profileRowToClient(row),
    photoUrl: photoUrlFor(userId),
    completeness: getCompleteness(userId, row),
  };
}

function itemRowToClient(row, attachments = []) {
  return {
    id: row.id,
    section: row.section,
    title: row.title,
    description: row.description,
    category: row.category,
    itemDate: row.item_date,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    progress: Number(row.progress || 0),
    impact: row.impact,
    url: row.url,
    content: row.content,
    evidenceType: row.evidence_type,
    linkedItemId: row.linked_item_id,
    linkedItemTitle: row.linked_item_title || null,
    evidenceCount: Number(row.evidence_count || 0),
    attachmentCount: attachments.length,
    attachments: attachments.map(attachmentToClient),
    tags: safeParseJson(row.tags_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function addAttachmentsToItems(userId, rows) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');
  const attachments = db.prepare(`
    SELECT * FROM attachments
    WHERE user_id = ? AND item_id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(userId, ...ids);
  const grouped = new Map();
  for (const attachment of attachments) {
    if (!grouped.has(attachment.item_id)) grouped.set(attachment.item_id, []);
    grouped.get(attachment.item_id).push(attachment);
  }
  return rows.map((row) => itemRowToClient(row, grouped.get(row.id) || []));
}

const ITEM_SELECT = `
  SELECT i.*,
    l.title AS linked_item_title,
    (SELECT COUNT(*) FROM items e WHERE e.user_id = i.user_id AND e.linked_item_id = i.id AND e.section = 'evidence') AS evidence_count
  FROM items i
  LEFT JOIN items l ON l.id = i.linked_item_id AND l.user_id = i.user_id
`;

function getOwnedItem(userId, itemId) {
  return db.prepare(`${ITEM_SELECT} WHERE i.id = ? AND i.user_id = ?`).get(itemId, userId);
}

function listItems(userId, section, query) {
  const q = cleanText(query.get('q') || '', 120);
  const category = cleanText(query.get('category') || '', 80);
  const status = cleanText(query.get('status') || '', 40);
  const sort = cleanText(query.get('sort') || 'newest', 20);
  const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), 200);
  const offset = Math.max(Number(query.get('offset')) || 0, 0);

  const conditions = ['i.user_id = ?', 'i.section = ?'];
  const params = [userId, section];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    conditions.push(`(
      i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR
      i.category LIKE ? ESCAPE '\\' OR i.tags_json LIKE ? ESCAPE '\\' OR
      i.content LIKE ? ESCAPE '\\' OR i.impact LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like, like, like);
  }
  if (category) {
    conditions.push('i.category = ?');
    params.push(category);
  }
  if (status) {
    conditions.push('i.status = ?');
    params.push(status);
  }

  const orderBy = {
    newest: 'i.updated_at DESC',
    oldest: 'i.updated_at ASC',
    title: 'i.title COLLATE NOCASE ASC',
    date: "COALESCE(i.item_date, i.end_date, i.start_date, i.updated_at) DESC",
  }[sort] || 'i.updated_at DESC';

  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM items i WHERE ${where}`).get(...params).count;
  const rows = db.prepare(`
    ${ITEM_SELECT}
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const categories = db.prepare(`
    SELECT category, COUNT(*) AS count FROM items
    WHERE user_id = ? AND section = ? AND category <> ''
    GROUP BY category ORDER BY count DESC, category ASC
  `).all(userId, section);

  return {
    items: addAttachmentsToItems(userId, rows),
    total: Number(total),
    categories,
    filters: { q, category, status, sort },
  };
}

function validateItemInput(body, existing, section) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const current = existing || {};
  const titleValue = has('title') ? body.title : current.title;
  const title = cleanText(titleValue, 200);
  assert(title.length >= 1, 400, 'عنوان السجل مطلوب.');

  const description = cleanText(
    has('description') ? body.description : current.description,
    5000,
  );
  const category = cleanText(has('category') ? body.category : current.category, 80);
  const tagsJson = JSON.stringify(
    has('tags') ? sanitizeTags(body.tags) : safeParseJson(current.tags_json, []),
  );

  let itemDate = has('itemDate') ? cleanText(body.itemDate, 10) : (current.item_date || '');
  let startDate = has('startDate') ? cleanText(body.startDate, 10) : (current.start_date || '');
  let endDate = has('endDate') ? cleanText(body.endDate, 10) : (current.end_date || '');

  assert(isValidDate(itemDate), 400, 'تاريخ السجل غير صالح.');
  assert(isValidDate(startDate), 400, 'تاريخ البداية غير صالح.');
  assert(isValidDate(endDate), 400, 'تاريخ النهاية غير صالح.');
  if (startDate && endDate && endDate < startDate) {
    throw new ApiError(400, 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية.');
  }

  let status = has('status') ? cleanText(body.status, 30) : (current.status || '');
  if (section === 'plans') {
    status = status || 'not_started';
    assert(PLAN_STATUSES.has(status), 400, 'حالة الخطة غير صالحة.');
  } else if (section === 'reports') {
    status = status || 'draft';
    assert(REPORT_STATUSES.has(status), 400, 'حالة التقرير غير صالحة.');
  } else {
    status = null;
  }

  let progress = has('progress') ? Number(body.progress) : Number(current.progress || 0);
  if (!Number.isFinite(progress)) progress = 0;
  progress = Math.round(progress);
  assert(progress >= 0 && progress <= 100, 400, 'نسبة التقدم يجب أن تكون بين 0 و100.');

  const impact = cleanText(has('impact') ? body.impact : current.impact, 3000);
  const content = cleanText(has('content') ? body.content : current.content, 15000);
  let url = has('url') ? cleanText(body.url, 1000) : (current.url || '');
  assert(isValidHttpUrl(url), 400, 'الرابط يجب أن يبدأ بـ http أو https.');

  let evidenceType = has('evidenceType') ? cleanText(body.evidenceType, 20) : (current.evidence_type || 'note');
  if (section === 'evidence') {
    evidenceType = evidenceType || 'note';
    assert(EVIDENCE_TYPES.has(evidenceType), 400, 'نوع الشاهد غير صالح.');
    if (evidenceType === 'link') {
      assert(Boolean(url), 400, 'أضف رابط الشاهد قبل الحفظ.');
    }
  } else {
    evidenceType = null;
    if (section !== 'achievements') url = '';
  }

  let linkedItemId = null;
  if (section === 'evidence') {
    const rawLinked = has('linkedItemId') ? body.linkedItemId : current.linked_item_id;
    if (rawLinked) {
      assert(isUuid(rawLinked), 400, 'الإنجاز المرتبط غير صالح.');
      linkedItemId = rawLinked;
    }
  }

  if (section === 'reports' || section === 'plans') {
    itemDate = '';
  } else {
    startDate = '';
    endDate = '';
  }

  return {
    title,
    description,
    category,
    itemDate: itemDate || null,
    startDate: startDate || null,
    endDate: endDate || null,
    status,
    progress,
    impact,
    url,
    content,
    evidenceType,
    linkedItemId,
    tagsJson,
    startRaw: startDate,
    endRaw: endDate,
  };
}

function verifyLinkedItem(linkedItemId, userId) {
  if (!linkedItemId) return;
  const target = db.prepare(`
    SELECT id FROM items WHERE id = ? AND user_id = ? AND section = 'achievements'
  `).get(linkedItemId, userId);
  if (!target) throw new ApiError(400, 'الإنجاز المرتبط غير موجود أو لا ينتمي إليك.');
}

function saveItem(userId, body, existing = null) {
  const section = existing ? existing.section : cleanText(body.section, 20);
  assert(SECTIONS.has(section), 400, 'القسم غير صالح.');
  const normalized = validateItemInput(body, existing, section);
  if (section === 'evidence' && normalized.linkedItemId) {
    verifyLinkedItem(normalized.linkedItemId, userId);
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE items SET
        title = ?, description = ?, category = ?, item_date = ?, start_date = ?, end_date = ?,
        status = ?, progress = ?, impact = ?, url = ?, content = ?, evidence_type = ?,
        linked_item_id = ?, tags_json = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      normalized.title, normalized.description, normalized.category, normalized.itemDate,
      normalized.startDate, normalized.endDate, normalized.status, normalized.progress,
      normalized.impact, normalized.url, normalized.content, normalized.evidenceType,
      normalized.linkedItemId, normalized.tagsJson, now, existing.id, userId,
    );
    addActivity(userId, 'updated', section, normalized.title);
    return existing.id;
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO items (
      id, user_id, section, title, description, category, item_date, start_date, end_date,
      status, progress, impact, url, content, evidence_type, linked_item_id, tags_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, section, normalized.title, normalized.description, normalized.category,
    normalized.itemDate, normalized.startDate, normalized.endDate, normalized.status,
    normalized.progress, normalized.impact, normalized.url, normalized.content,
    normalized.evidenceType, normalized.linkedItemId, normalized.tagsJson, now, now,
  );
  addActivity(userId, 'created', section, normalized.title);
  return id;
}

function deleteAttachmentsFiles(userId, attachments) {
  for (const attachment of attachments) {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(attachment.storage_key)) continue;
    const filePath = path.join(UPLOAD_DIR, userId, attachment.storage_key);
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('تعذّر حذف المرفق:', error.message);
    }
  }
}

function storageUsage(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
    FROM attachments WHERE user_id = ?
  `).get(userId);
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

function saveUploadedFile(userId, decoded) {
  const dir = path.join(UPLOAD_DIR, userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storageKey = `${crypto.randomUUID()}.${decoded.ext}`;
  const filePath = path.join(dir, storageKey);
  fs.writeFileSync(filePath, decoded.buffer, { mode: 0o600, flag: 'wx' });
  return storageKey;
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;
  const auth = getAuth(req);

  if (method !== 'GET' && method !== 'HEAD' && !checkOrigin(req)) {
    sendError(res, 403, 'تم رفض الطلب لأنه لم يأتِ من نطاق التطبيق.');
    return;
  }

  // ---------------- Authentication ----------------

  if (pathname === '/api/auth/register' && method === 'POST') {
    const ipLimit = limiter.hit(`register:${getClientIp(req)}`, 8, 60 * 60 * 1000);
    if (!ipLimit.allowed) {
      sendError(res, 429, 'محاولات إنشاء الحساب كثيرة. حاول بعد قليل.', { retryAfter: ipLimit.retryAfter });
      return;
    }
    requireJson(req);
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const name = cleanText(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    assert(name.length >= 2, 400, 'أدخل الاسم الكامل (حرفان على الأقل).');
    assert(isValidEmail(email), 400, 'أدخل بريدًا إلكترونيًا صالحًا.');
    const passwordError = passwordProblem(password);
    assert(!passwordError, 400, passwordError);

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    assert(!existing, 409, 'يوجد حساب مسجّل بهذا البريد الإلكتروني.');

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = hashSecret(password);
    const recoveryCode = generateRecoveryCode();
    const recoveryHash = hashSecret(normalizeRecoveryCode(recoveryCode));

    transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, name, password_hash, recovery_hash, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, email, name, passwordHash, recoveryHash, now, now, now);
      db.prepare(`
        INSERT INTO profiles (user_id, full_name, email, updated_at) VALUES (?, ?, ?, ?)
      `).run(userId, name, email, now);
    });

    const session = createSession(userId, req, res);
    const user = getFullUser(userId);
    sendJson(res, 201, {
      user,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      photoUrl: null,
      recoveryCode,
    });
    return;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    requireJson(req);
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const ipKey = `login-ip:${getClientIp(req)}`;
    const emailKey = `login-email:${email}`;
    const ipLimit = limiter.hit(ipKey, 40, 15 * 60 * 1000);
    const emailLimit = limiter.hit(emailKey, 10, 15 * 60 * 1000);
    if (!ipLimit.allowed || !emailLimit.allowed) {
      sendError(res, 429, 'محاولات الدخول كثيرة. انتظر بضع دقائق ثم حاول مجددًا.', {
        retryAfter: Math.max(ipLimit.retryAfter, emailLimit.retryAfter),
      });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const passwordOk = verifySecret(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) {
      sendError(res, 401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
      return;
    }

    limiter.reset(emailKey);
    limiter.reset(ipKey);
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
    const session = createSession(user.id, req, res);
    sendJson(res, 200, {
      user: { id: user.id, name: user.name, email: user.email, createdAt: user.created_at },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      photoUrl: photoUrlFor(user.id),
    });
    return;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    sendJson(res, 200, currentSessionPayload(auth));
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (!auth) {
      res.setHeader('Set-Cookie', clearSessionCookie());
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.token ? hashToken(auth.token) : '');
    res.setHeader('Set-Cookie', clearSessionCookie());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/auth/recover' && method === 'POST') {
    requireJson(req);
    const ipLimit = limiter.hit(`recover:${getClientIp(req)}`, 12, 30 * 60 * 1000);
    if (!ipLimit.allowed) {
      sendError(res, 429, 'محاولات الاستعادة كثيرة. حاول بعد قليل.', { retryAfter: ipLimit.retryAfter });
      return;
    }
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const email = normalizeEmail(body.email);
    const recovery = normalizeRecoveryCode(body.recoveryCode);
    const password = typeof body.newPassword === 'string' ? body.newPassword : '';
    const passwordError = passwordProblem(password);
    assert(!passwordError, 400, passwordError);
    assert(recovery.length === 16, 400, 'رمز الاستعادة غير صالح.');

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const emailLimit = limiter.hit(`recover-email:${email}`, 6, 30 * 60 * 1000);
    if (!emailLimit.allowed) {
      sendError(res, 429, 'محاولات الاستعادة كثيرة. حاول بعد قليل.', { retryAfter: emailLimit.retryAfter });
      return;
    }
    const codeOk = verifySecret(recovery, user?.recovery_hash || DUMMY_PASSWORD_HASH);
    if (!user || !codeOk) {
      sendError(res, 400, 'بيانات الاستعادة غير صحيحة. تحقق من البريد ورمز الاستعادة.');
      return;
    }

    const newRecoveryCode = generateRecoveryCode();
    const passwordHash = hashSecret(password);
    const recoveryHash = hashSecret(normalizeRecoveryCode(newRecoveryCode));
    transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, recovery_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, recoveryHash, new Date().toISOString(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    limiter.reset(`recover-email:${email}`);
    sendJson(res, 200, {
      ok: true,
      recoveryCode: newRecoveryCode,
      message: 'تم تعيين كلمة مرور جديدة. احفظ رمز الاستعادة الجديد.',
    });
    return;
  }

  // ---------------- Session-protected routes ----------------

  if (pathname === '/api/dashboard' && method === 'GET') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    const userId = auth.user.id;
    const countsRows = db.prepare(`
      SELECT section, COUNT(*) AS count FROM items WHERE user_id = ? GROUP BY section
    `).all(userId);
    const counts = Object.fromEntries(countsRows.map((row) => [row.section, Number(row.count)]));
    const storage = storageUsage(userId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const thisMonth = db.prepare(`
      SELECT COUNT(*) AS count FROM items WHERE user_id = ? AND created_at >= ?
    `).get(userId, monthStart.toISOString()).count;

    const recentRows = db.prepare(`
      ${ITEM_SELECT} WHERE i.user_id = ? ORDER BY i.updated_at DESC LIMIT 4
    `).all(userId);
    const recentItems = addAttachmentsToItems(userId, recentRows);

    const upcomingRows = db.prepare(`
      SELECT * FROM items
      WHERE user_id = ? AND section = 'plans' AND status <> 'completed'
        AND end_date IS NOT NULL AND end_date >= ?
      ORDER BY end_date ASC LIMIT 3
    `).all(userId, new Date().toISOString().slice(0, 10));
    const upcoming = upcomingRows.map((row) => itemRowToClient(row));

    const activity = db.prepare(`
      SELECT id, kind, section, title, created_at FROM activity
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 6
    `).all(userId);

    const categoryRows = db.prepare(`
      SELECT category, COUNT(*) AS count FROM items
      WHERE user_id = ? AND category <> ''
      GROUP BY category ORDER BY count DESC, category ASC LIMIT 5
    `).all(userId);

    const profile = ensureProfile(userId);
    const completeness = getCompleteness(userId, profile);
    const totalItems = Object.values(counts).reduce((sum, count) => sum + count, 0);

    sendJson(res, 200, {
      stats: {
        achievements: counts.achievements || 0,
        evidence: counts.evidence || 0,
        plans: counts.plans || 0,
        reports: counts.reports || 0,
        attachments: storage.count,
        storageBytes: storage.bytes,
        thisMonth: Number(thisMonth),
        totalItems,
      },
      profileCompletion: completeness.percent,
      profileMissing: completeness.missing,
      recentItems,
      upcoming,
      activity,
      categories: categoryRows,
      profile: {
        fullName: profile.full_name || auth.user.name,
        jobTitle: profile.job_title || '',
        organization: profile.organization || '',
        photoUrl: photoUrlFor(userId),
      },
    });
    return;
  }

  if (pathname === '/api/search' && method === 'GET') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    const q = cleanText(url.searchParams.get('q') || '', 100);
    if (q.length < 2) {
      sendJson(res, 200, { results: [], query: q });
      return;
    }
    const like = `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const rows = db.prepare(`
      SELECT id, section, title, description, category, item_date, updated_at
      FROM items
      WHERE user_id = ? AND (
        title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR
        category LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\' OR
        content LIKE ? ESCAPE '\\' OR impact LIKE ? ESCAPE '\\'
      )
      ORDER BY updated_at DESC LIMIT 24
    `).all(auth.user.id, like, like, like, like, like, like);
    sendJson(res, 200, {
      query: q,
      results: rows.map((row) => ({
        id: row.id,
        section: row.section,
        title: row.title,
        description: (row.description || '').slice(0, 140),
        category: row.category,
        itemDate: row.item_date,
        updatedAt: row.updated_at,
      })),
    });
    return;
  }

  if (pathname === '/api/items' && method === 'GET') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    const section = cleanText(url.searchParams.get('section') || '', 20);
    assert(SECTIONS.has(section), 400, 'القسم غير صالح.');
    sendJson(res, 200, listItems(auth.user.id, section, url.searchParams));
    return;
  }

  if (pathname === '/api/items' && method === 'POST') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    requireJson(req);
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const id = saveItem(auth.user.id, body);
    const row = getOwnedItem(auth.user.id, id);
    sendJson(res, 201, { item: addAttachmentsToItems(auth.user.id, [row])[0] });
    return;
  }

  const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch) {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    const itemId = sanitizeId(itemMatch[1]);
    assert(itemId, 404, 'السجل غير موجود.');
    const existing = getOwnedItem(auth.user.id, itemId);
    assert(existing, 404, 'السجل غير موجود.');

    if (method === 'GET') {
      sendJson(res, 200, { item: addAttachmentsToItems(auth.user.id, [existing])[0] });
      return;
    }
    if (method === 'PATCH') {
      if (!protectMutation(req, res, auth)) return;
      requireJson(req);
      const body = await readJsonBody(req, MAX_JSON_BYTES);
      saveItem(auth.user.id, body, existing);
      const row = getOwnedItem(auth.user.id, itemId);
      sendJson(res, 200, { item: addAttachmentsToItems(auth.user.id, [row])[0] });
      return;
    }
    if (method === 'DELETE') {
      if (!protectMutation(req, res, auth)) return;
      const attachments = db.prepare('SELECT * FROM attachments WHERE user_id = ? AND item_id = ?')
        .all(auth.user.id, itemId);
      db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(itemId, auth.user.id);
      deleteAttachmentsFiles(auth.user.id, attachments);
      addActivity(auth.user.id, 'deleted', existing.section, existing.title);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const itemAttachmentMatch = pathname.match(/^\/api\/items\/([^/]+)\/attachments$/);
  if (itemAttachmentMatch && method === 'POST') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    requireJson(req);
    const itemId = sanitizeId(itemAttachmentMatch[1]);
    assert(itemId, 404, 'السجل غير موجود.');
    const item = getOwnedItem(auth.user.id, itemId);
    assert(item, 404, 'السجل غير موجود.');

    const body = await readJsonBody(req, MAX_UPLOAD_JSON_BYTES);
    const count = db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ? AND item_id = ?')
      .get(auth.user.id, itemId).count;
    assert(count < MAX_ATTACHMENTS_PER_ITEM, 400, `يمكن إرفاق ${MAX_ATTACHMENTS_PER_ITEM} ملفات لكل سجل كحد أقصى.`);
    const usage = storageUsage(auth.user.id);
    assert(usage.bytes < MAX_TOTAL_STORAGE_BYTES, 400, 'وصلت مساحة التخزين إلى الحد الأقصى. احذف بعض المرفقات القديمة.');

    const decoded = decodeBase64File(body.data, body.name, body.mime);
    assert(!decoded.error, 400, decoded.error);
    assert(usage.bytes + decoded.size <= MAX_TOTAL_STORAGE_BYTES, 400, 'لا توجد مساحة كافية لإضافة هذا الملف.');

    let storageKey;
    try {
      storageKey = saveUploadedFile(auth.user.id, decoded);
      const attachmentId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO attachments
          (id, user_id, item_id, scope, original_name, mime, size, storage_key, created_at)
        VALUES (?, ?, ?, 'item', ?, ?, ?, ?, ?)
      `).run(
        attachmentId, auth.user.id, itemId, decoded.originalName,
        decoded.mime, decoded.size, storageKey, now,
      );
      addActivity(auth.user.id, 'uploaded', item.section, item.title);
      const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId);
      sendJson(res, 201, { attachment: attachmentToClient(attachment) });
    } catch (error) {
      if (storageKey) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, auth.user.id, storageKey));
        } catch {
          // Ignore cleanup errors.
        }
      }
      throw error;
    }
    return;
  }

  const attachmentMatch = pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch) {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    const attachmentId = sanitizeId(attachmentMatch[1]);
    assert(attachmentId, 404, 'المرفق غير موجود.');
    const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?')
      .get(attachmentId, auth.user.id);
    assert(attachment, 404, 'المرفق غير موجود.');

    if (method === 'GET') {
      if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(attachment.storage_key)) {
        sendError(res, 404, 'الملف غير موجود.');
        return;
      }
      const filePath = path.join(UPLOAD_DIR, auth.user.id, attachment.storage_key);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        sendError(res, 410, 'الملف لم يعد متاحًا.');
        return;
      }
      const download = url.searchParams.get('download') === '1';
      const canInline = !download && attachment.mime.startsWith('image/');
      const disposition = canInline ? 'inline' : 'attachment';
      const asciiFallback = attachment.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      const encodedName = encodeURIComponent(attachment.original_name).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      res.writeHead(200, {
        'Content-Type': attachment.mime,
        'Content-Length': stat.size,
        'Content-Disposition': `${disposition}; filename="${asciiFallback || 'file'}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) sendError(res, 500, 'تعذّر قراءة الملف.');
        else res.destroy();
      });
      stream.pipe(res);
      return;
    }

    if (method === 'DELETE') {
      if (!protectMutation(req, res, auth)) return;
      db.prepare('DELETE FROM attachments WHERE id = ? AND user_id = ?').run(attachmentId, auth.user.id);
      deleteAttachmentsFiles(auth.user.id, [attachment]);
      const parent = attachment.item_id
        ? db.prepare('SELECT section, title FROM items WHERE id = ? AND user_id = ?').get(attachment.item_id, auth.user.id)
        : null;
      if (parent) addActivity(auth.user.id, 'removed-file', parent.section, parent.title);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // ---------------- Profile ----------------

  if (pathname === '/api/profile' && method === 'GET') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    sendJson(res, 200, profilePayload(auth.user.id));
    return;
  }

  if (pathname === '/api/profile' && method === 'PUT') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    requireJson(req);
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const current = ensureProfile(auth.user.id);
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const value = (key, currentKey, max, fallback = '') => (
      has(key) ? cleanText(body[key], max) : (current[currentKey] ?? fallback)
    );

    const fullName = value('fullName', 'full_name', 80);
    assert(fullName.length >= 2, 400, 'الاسم الكامل مطلوب.');
    const jobTitle = value('jobTitle', 'job_title', 120);
    const organization = value('organization', 'organization', 140);
    const specialization = value('specialization', 'specialization', 120);
    const location = value('location', 'location', 100);
    const email = value('email', 'email', 160);
    const phone = value('phone', 'phone', 40);
    const website = value('website', 'website', 300);
    const bio = value('bio', 'bio', 3000);
    assert(!email || isValidEmail(normalizeEmail(email)), 400, 'البريد المهني غير صالح.');
    assert(!website || isValidHttpUrl(website), 400, 'رابط الموقع يجب أن يبدأ بـ http أو https.');
    assert(/^[\d+\-()\s]*$/.test(phone), 400, 'رقم التواصل يحتوي على رموز غير مسموحة.');
    let yearsExperience = has('yearsExperience')
      ? Number(body.yearsExperience)
      : current.years_experience;
    if (yearsExperience === '' || yearsExperience === null) yearsExperience = null;
    if (yearsExperience !== null) {
      assert(Number.isInteger(yearsExperience) && yearsExperience >= 0 && yearsExperience <= 70, 400, 'سنوات الخبرة غير صالحة.');
    }
    const skills = has('skills') ? sanitizeTags(body.skills) : safeParseJson(current.skills_json, []);
    const now = new Date().toISOString();

    transaction(() => {
      db.prepare(`
        UPDATE profiles SET
          full_name = ?, job_title = ?, organization = ?, specialization = ?, location = ?,
          email = ?, phone = ?, website = ?, bio = ?, years_experience = ?, skills_json = ?, updated_at = ?
        WHERE user_id = ?
      `).run(
        fullName, jobTitle, organization, specialization, location,
        email, phone, website, bio, yearsExperience, JSON.stringify(skills), now, auth.user.id,
      );
      db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(fullName, now, auth.user.id);
    });
    sendJson(res, 200, profilePayload(auth.user.id));
    return;
  }

  if (pathname === '/api/profile/photo' && method === 'POST') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    requireJson(req);
    const body = await readJsonBody(req, MAX_UPLOAD_JSON_BYTES);
    const decoded = decodeBase64File(body.data, body.name, body.mime);
    assert(!decoded.error, 400, decoded.error);
    assert(decoded.mime.startsWith('image/'), 400, 'اختر صورة شخصية بصيغة JPG أو PNG أو WebP أو GIF.');
    assert(decoded.size <= MAX_FILE_BYTES, 400, 'حجم الصورة أكبر من المسموح.');

    const previous = getProfilePhoto(auth.user.id);
    let storageKey;
    try {
      storageKey = saveUploadedFile(auth.user.id, decoded);
      const now = new Date().toISOString();
      const attachmentId = crypto.randomUUID();
      transaction(() => {
        db.prepare('DELETE FROM attachments WHERE user_id = ? AND scope = \'profile\'').run(auth.user.id);
        db.prepare(`
          INSERT INTO attachments
            (id, user_id, item_id, scope, original_name, mime, size, storage_key, created_at)
          VALUES (?, ?, NULL, 'profile', ?, ?, ?, ?, ?)
        `).run(attachmentId, auth.user.id, decoded.originalName, decoded.mime, decoded.size, storageKey, now);
      });
      if (previous) deleteAttachmentsFiles(auth.user.id, [previous]);
      sendJson(res, 200, profilePayload(auth.user.id));
    } catch (error) {
      if (storageKey) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, auth.user.id, storageKey));
        } catch {
          // Ignore cleanup errors.
        }
      }
      throw error;
    }
    return;
  }

  if (pathname === '/api/profile/photo' && method === 'DELETE') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    const previous = getProfilePhoto(auth.user.id);
    if (previous) {
      db.prepare('DELETE FROM attachments WHERE id = ? AND user_id = ?').run(previous.id, auth.user.id);
      deleteAttachmentsFiles(auth.user.id, [previous]);
    }
    sendJson(res, 200, profilePayload(auth.user.id));
    return;
  }

  // ---------------- Account security ----------------

  if (pathname === '/api/account/password' && method === 'POST') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    requireJson(req);
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(auth.user.id);
    assert(verifySecret(currentPassword, user.password_hash), 400, 'كلمة المرور الحالية غير صحيحة.');
    const problem = passwordProblem(newPassword);
    assert(!problem, 400, problem);
    const newHash = hashSecret(newPassword);
    transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(newHash, new Date().toISOString(), auth.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
        .run(auth.user.id, hashToken(auth.token));
    });
    sendJson(res, 200, { ok: true, message: 'تم تحديث كلمة المرور وتسجيل الخروج من الجلسات الأخرى.' });
    return;
  }

  if (pathname === '/api/account/recovery' && method === 'POST') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    requireJson(req);
    const body = await readJsonBody(req, MAX_JSON_BYTES);
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(auth.user.id);
    assert(verifySecret(password, user.password_hash), 400, 'كلمة المرور غير صحيحة.');
    const recoveryCode = generateRecoveryCode();
    db.prepare('UPDATE users SET recovery_hash = ?, updated_at = ? WHERE id = ?').run(
      hashSecret(normalizeRecoveryCode(recoveryCode)),
      new Date().toISOString(),
      auth.user.id,
    );
    sendJson(res, 200, {
      ok: true,
      recoveryCode,
      message: 'تم إنشاء رمز استعادة جديد. الرمز السابق لم يعد صالحًا.',
    });
    return;
  }

  if (pathname === '/api/account/logout-all' && method === 'POST') {
    if (!auth) {
      sendError(res, 401, 'يجب تسجيل الدخول للمتابعة.');
      return;
    }
    if (!protectMutation(req, res, auth)) return;
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(auth.user.id);
    res.setHeader('Set-Cookie', clearSessionCookie());
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, 'المسار غير موجود.');
}

module.exports = {
  handleApi,
  ApiError,
};
