/*
 * أثري — طبقة البيانات المحلية
 * كل الحسابات والمساحات تُحفظ في localStorage / sessionStorage.
 */
(function () {
  'use strict';

  const NS = 'athari.v1';
  const USERS_KEY = `${NS}.users`;
  const SESSION_KEY = `${NS}.session`;
  const WORKSPACE_PREFIX = `${NS}.workspace.`;
  const DEFAULT_PBKDF2_ITERATIONS = 210000;
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_WORKSPACE_BYTES = 4.5 * 1024 * 1024;

  const SECTION_KEYS = ['achievements', 'evidence', 'reports'];

  class StoreError extends Error {
    constructor(message, code = 'STORE_ERROR') {
      super(message);
      this.name = 'StoreError';
      this.code = code;
    }
  }

  function safeStorage(kind) {
    try {
      const storage = kind === 'session' ? window.sessionStorage : window.localStorage;
      const probe = `${NS}.probe`;
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    } catch {
      return null;
    }
  }

  const local = safeStorage('local');
  const session = safeStorage('session');

  function requireLocal() {
    if (!local) {
      throw new StoreError(
        'تعذّر الوصول إلى التخزين المحلي. تأكد من السماح للمتصفح بحفظ بيانات الموقع.',
        'STORAGE_UNAVAILABLE',
      );
    }
    return local;
  }

  function readJSON(storage, key, fallback) {
    if (!storage) return fallback;
    try {
      const raw = storage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    if (!storage) throw new StoreError('التخزين المحلي غير متاح.', 'STORAGE_UNAVAILABLE');
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (error) {
      if (
        error &&
        (error.name === 'QuotaExceededError' ||
          error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
          error.code === 22 ||
          error.code === 1014)
      ) {
        throw new StoreError(
          'امتلأت مساحة التخزين المحلية. احذف بعض المرفقات أو صدّر نسخة احتياطية ثم أفرغ مساحة.',
          'QUOTA_EXCEEDED',
        );
      }
      throw new StoreError('تعذّر حفظ البيانات في المتصفح.', 'STORAGE_WRITE_FAILED');
    }
  }

  function jsonBytes(value) {
    const raw = JSON.stringify(value);
    try {
      return new Blob([raw]).size;
    } catch {
      return raw.length * 2;
    }
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function isValidEmail(email) {
    const value = normalizeEmail(email);
    return value.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(value);
  }

  function passwordProblem(password) {
    const value = String(password || '');
    if (value.length < 8) return 'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل.';
    if (value.length > 128) return 'كلمة المرور طويلة جدًا.';
    if (!/[A-Za-z\u0600-\u06FF]/u.test(value)) return 'أضف حرفًا واحدًا على الأقل إلى كلمة المرور.';
    if (!/\d/u.test(value)) return 'أضف رقمًا واحدًا على الأقل إلى كلمة المرور.';
    return '';
  }

  function getUsers() {
    const users = readJSON(requireLocal(), USERS_KEY, []);
    return Array.isArray(users) ? users : [];
  }

  function saveUsers(users) {
    writeJSON(requireLocal(), USERS_KEY, users);
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt || null,
    };
  }

  function findUserByEmail(email) {
    const key = normalizeEmail(email);
    return getUsers().find((user) => user.emailKey === key) || null;
  }

  function findUserById(userId) {
    return getUsers().find((user) => user.id === userId) || null;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function randomBase64(byteCount = 16) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return bytesToBase64(bytes);
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function constantTimeEqual(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function derivePasswordHash(password, saltBase64, iterations) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new StoreError(
        'متصفحك لا يدعم حماية كلمة المرور المطلوبة. افتح التطبيق عبر HTTPS أو استخدم متصفحًا حديثًا.',
        'CRYPTO_UNAVAILABLE',
      );
    }
    const passwordBytes = new TextEncoder().encode(String(password));
    const salt = base64ToBytes(saltBase64);
    const material = await crypto.subtle.importKey(
      'raw',
      passwordBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      material,
      256,
    );
    return bytesToBase64(new Uint8Array(bits));
  }

  function saveSession(userId, remember) {
    const now = Date.now();
    const payload = {
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + SESSION_TTL_MS,
    };
    try {
      if (local) local.removeItem(SESSION_KEY);
      if (session) session.removeItem(SESSION_KEY);
      const target = remember ? requireLocal() : (session || requireLocal());
      target.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      throw new StoreError('تعذّر بدء جلسة الدخول في هذا المتصفح.', 'SESSION_FAILED');
    }
  }

  function clearSession() {
    try {
      if (local) local.removeItem(SESSION_KEY);
      if (session) session.removeItem(SESSION_KEY);
    } catch {
      // لا شيء يمكن فعله إن كان التخزين مقفلًا.
    }
  }

  function getSession() {
    const sources = [local, session];
    for (const storage of sources) {
      if (!storage) continue;
      const raw = readJSON(storage, SESSION_KEY, null);
      if (!raw || !raw.userId) continue;
      if (!raw.expiresAt || Number(raw.expiresAt) <= Date.now()) {
        try { storage.removeItem(SESSION_KEY); } catch { /* تجاهل */ }
        continue;
      }
      const user = findUserById(raw.userId);
      if (!user) {
        try { storage.removeItem(SESSION_KEY); } catch { /* تجاهل */ }
        continue;
      }
      return publicUser(user);
    }
    return null;
  }

  function emptyWorkspace(account) {
    const now = new Date().toISOString();
    return {
      version: 1,
      createdAt: now,
      updatedAt: now,
      profile: {
        fullName: account?.name || '',
        jobTitle: '',
        organization: '',
        specialization: '',
        location: '',
        email: account?.email || '',
        phone: '',
        website: '',
        yearsExperience: '',
        bio: '',
        skills: [],
        photo: null,
        updatedAt: now,
      },
      achievements: [],
      evidence: [],
      reports: [],
      activity: [],
    };
  }

  function normalizeWorkspace(data, account) {
    const fallback = emptyWorkspace(account);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback;
    const workspace = { ...fallback, ...data };
    workspace.version = 1;
    workspace.profile = {
      ...fallback.profile,
      ...(data.profile && typeof data.profile === 'object' && !Array.isArray(data.profile) ? data.profile : {}),
    };
    for (const key of SECTION_KEYS) {
      workspace[key] = Array.isArray(data[key]) ? data[key] : [];
    }
    workspace.activity = Array.isArray(data.activity) ? data.activity.slice(0, 60) : [];
    if (!Array.isArray(workspace.profile.skills)) workspace.profile.skills = [];
    return workspace;
  }

  function getWorkspace(userId) {
    const account = findUserById(userId);
    if (!account) throw new StoreError('الحساب غير موجود.', 'USER_NOT_FOUND');
    const key = `${WORKSPACE_PREFIX}${userId}`;
    const raw = readJSON(requireLocal(), key, null);
    if (raw) return normalizeWorkspace(raw, account);
    const workspace = emptyWorkspace(account);
    writeJSON(requireLocal(), key, workspace);
    return workspace;
  }

  function saveWorkspace(userId, workspace) {
    if (!findUserById(userId)) throw new StoreError('الحساب غير موجود.', 'USER_NOT_FOUND');
    const bytes = jsonBytes(workspace);
    if (bytes > MAX_WORKSPACE_BYTES) {
      throw new StoreError(
        'المساحة المخصصة للملف ممتلئة تقريبًا. احذف بعض المرفقات أو صدّر نسخة احتياطية.',
        'WORKSPACE_LIMIT',
      );
    }
    writeJSON(requireLocal(), `${WORKSPACE_PREFIX}${userId}`, workspace);
  }

  function workspaceBytes(workspace) {
    return jsonBytes(workspace);
  }

  async function register({ name, email, password }) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    const cleanEmail = normalizeEmail(email);
    if (cleanName.length < 2) throw new StoreError('أدخل الاسم الكامل (حرفان على الأقل).', 'INVALID_NAME');
    if (cleanName.length > 80) throw new StoreError('الاسم طويل جدًا.', 'INVALID_NAME');
    if (!isValidEmail(cleanEmail)) throw new StoreError('أدخل بريدًا إلكترونيًا صالحًا.', 'INVALID_EMAIL');
    const passwordError = passwordProblem(password);
    if (passwordError) throw new StoreError(passwordError, 'INVALID_PASSWORD');

    const users = getUsers();
    if (users.some((user) => user.emailKey === cleanEmail)) {
      throw new StoreError('يوجد حساب مسجّل بهذا البريد الإلكتروني.', 'EMAIL_EXISTS');
    }

    const salt = randomBase64(16);
    const iterations = DEFAULT_PBKDF2_ITERATIONS;
    const passwordHash = await derivePasswordHash(password, salt, iterations);
    const now = new Date().toISOString();
    const user = {
      id: makeId(),
      name: cleanName,
      email: cleanEmail,
      emailKey: cleanEmail,
      salt,
      passwordHash,
      iterations,
      createdAt: now,
      lastLoginAt: now,
    };
    users.push(user);
    saveUsers(users);
    const workspace = emptyWorkspace(user);
    writeJSON(requireLocal(), `${WORKSPACE_PREFIX}${user.id}`, workspace);
    saveSession(user.id, true);
    return publicUser(user);
  }

  async function login({ email, password, remember = true }) {
    const user = findUserByEmail(email);
    if (!user) {
      // اشتقاق وهمي للحفاظ على زمن استجابة متقارب.
      await derivePasswordHash(password || '', randomBase64(16), DEFAULT_PBKDF2_ITERATIONS).catch(() => {});
      throw new StoreError('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 'INVALID_CREDENTIALS');
    }
    const passwordHash = await derivePasswordHash(
      password || '',
      user.salt,
      Number(user.iterations) || DEFAULT_PBKDF2_ITERATIONS,
    );
    if (!constantTimeEqual(passwordHash, user.passwordHash)) {
      throw new StoreError('البريد الإلكتروني أو كلمة المرور غير صحيحة.', 'INVALID_CREDENTIALS');
    }
    const users = getUsers();
    const index = users.findIndex((entry) => entry.id === user.id);
    if (index !== -1) {
      users[index].lastLoginAt = new Date().toISOString();
      saveUsers(users);
    }
    saveSession(user.id, remember);
    return publicUser(users[index] || user);
  }

  async function changePassword(userId, currentPassword, newPassword) {
    const users = getUsers();
    const index = users.findIndex((user) => user.id === userId);
    if (index === -1) throw new StoreError('الحساب غير موجود.', 'USER_NOT_FOUND');
    const user = users[index];
    const currentHash = await derivePasswordHash(
      currentPassword || '',
      user.salt,
      Number(user.iterations) || DEFAULT_PBKDF2_ITERATIONS,
    );
    if (!constantTimeEqual(currentHash, user.passwordHash)) {
      throw new StoreError('كلمة المرور الحالية غير صحيحة.', 'INVALID_PASSWORD');
    }
    const nextProblem = passwordProblem(newPassword);
    if (nextProblem) throw new StoreError(nextProblem, 'INVALID_PASSWORD');
    const salt = randomBase64(16);
    const iterations = DEFAULT_PBKDF2_ITERATIONS;
    users[index] = {
      ...user,
      salt,
      iterations,
      passwordHash: await derivePasswordHash(newPassword, salt, iterations),
      updatedAt: new Date().toISOString(),
    };
    saveUsers(users);
    return true;
  }

  function updateAccountName(userId, name) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) return;
    const users = getUsers();
    const index = users.findIndex((user) => user.id === userId);
    if (index === -1) return;
    users[index].name = cleanName;
    users[index].updatedAt = new Date().toISOString();
    saveUsers(users);
  }

  function accountExists(email) {
    return Boolean(findUserByEmail(email));
  }

  function hasUsers() {
    try {
      return getUsers().length > 0;
    } catch {
      return false;
    }
  }

  window.AthariStore = {
    StoreError,
    SESSION_TTL_MS,
    MAX_WORKSPACE_BYTES,
    SECTION_KEYS,
    register,
    login,
    getSession,
    clearSession,
    logout: clearSession,
    getWorkspace,
    saveWorkspace,
    workspaceBytes,
    changePassword,
    updateAccountName,
    accountExists,
    hasUsers,
    normalizeEmail,
    isValidEmail,
    passwordProblem,
  };
})();
