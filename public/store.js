/*
 * أثري — طبقة البيانات السحابية
 * Supabase Auth + Postgres مع Row Level Security
 *
 * ملاحظة أمنية:
 * - هذا الملف يستخدم anon public key فقط.
 * - لا تضع service_role key هنا أو في أي ملف داخل public.
 */
(function () {
  'use strict';

  const SECTION_KEYS = ['achievements', 'evidence', 'reports'];
  const MAX_WORKSPACE_BYTES = 4.5 * 1024 * 1024;
  const AUTH_STORAGE_KEY = 'athari.supabase.auth';

  class StoreError extends Error {
    constructor(message, code = 'STORE_ERROR') {
      super(message);
      this.name = 'StoreError';
      this.code = code;
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

  function authRedirectUrl() {
    if (typeof window === 'undefined' || !window.location) return undefined;
    const { protocol, origin, pathname } = window.location;
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
    const path = pathname.replace(/index\.html?$/i, '');
    return origin + (path.endsWith('/') ? path : `${path}/`);
  }

  function cleanText(value, maxLength = 1000) {
    return String(value ?? '').trim().slice(0, maxLength);
  }

  function normalizeTimestamp(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function makeUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function jsonBytes(value) {
    const raw = JSON.stringify(value);
    try {
      return new Blob([raw]).size;
    } catch {
      return raw.length * 2;
    }
  }

  function publicUser(user) {
    if (!user) return null;
    const metadata = user.user_metadata || {};
    const email = user.email || '';
    return {
      id: user.id,
      name: metadata.full_name || metadata.name || email.split('@')[0] || 'مستخدم',
      email,
      createdAt: user.created_at || null,
      lastLoginAt: user.last_sign_in_at || null,
    };
  }

  function authErrorMessage(error) {
    const message = String(error && error.message ? error.message : error || '');
    if (/Invalid login credentials/i.test(message)) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
    if (/Email not confirmed/i.test(message)) return 'يرجى تأكيد بريدك الإلكتروني من الرسالة التي وصلتك قبل تسجيل الدخول.';
    if (/User already registered|already been registered/i.test(message)) return 'يوجد حساب مسجّل بهذا البريد الإلكتروني.';
    if (/Password should be at least|Password is too short/i.test(message)) return 'كلمة المرور قصيرة جدًا. استخدم 8 أحرف على الأقل.';
    if (/For security purposes|rate limit|too many requests/i.test(message)) return 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.';
    if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) return 'تعذّر الاتصال بخادم Supabase. تحقق من اتصال الإنترنت ومن إعدادات المشروع.';
    if (/JWT|not authenticated|Auth session missing|session.*missing/i.test(message)) return 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.';
    return message || 'تعذّر إتمام العملية.';
  }

  function databaseErrorMessage(error) {
    const message = String(error && error.message ? error.message : error || '');
    if (/relation .* does not exist|Could not find the table|schema cache/i.test(message)) {
      return 'جداول Supabase غير موجودة. نفّذ ملف supabase/schema.sql أولًا من SQL Editor.';
    }
    if (/Could not find the function|function .* does not exist/i.test(message)) {
      return 'دالة replace_workspace غير موجودة. نفّذ ملف supabase/schema.sql كاملًا.';
    }
    if (/row-level security|permission denied/i.test(message)) {
      return 'لا تملك صلاحية الوصول إلى هذه البيانات. تأكد من تسجيل الدخول ومن سياسات RLS.';
    }
    return message || 'تعذّر إتمام العملية في قاعدة البيانات.';
  }

  function throwAuth(error) {
    throw new StoreError(authErrorMessage(error), 'AUTH_ERROR');
  }

  function throwDb(error, fallback) {
    if (error) console.error('[Supabase]', error.message || error);
    throw new StoreError(databaseErrorMessage(error) || fallback || 'تعذّر إتمام العملية.', 'DB_ERROR');
  }

  function assertPublicKey(key) {
    const value = String(key || '');
    if (value.startsWith('sb_secret_') || value.includes('service_role')) {
      throw new StoreError(
        'هذا المفتاح سري (service_role). استخدم anon public key فقط، ولا تضعه في الواجهة.',
        'SERVICE_ROLE_FORBIDDEN',
      );
    }
    if (!value.startsWith('eyJ')) return;
    const parts = value.split('.');
    if (parts.length < 2) return;
    try {
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      const parsed = JSON.parse(atob(payload));
      if (parsed.role === 'service_role') {
        throw new StoreError(
          'هذا المفتاح سري (service_role). استخدم anon public key فقط، ولا تضعه في الواجهة.',
          'SERVICE_ROLE_FORBIDDEN',
        );
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
    }
  }

  const config = window.ATHARI_SUPABASE || {};
  let client = null;
  let configError = '';

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    configError = 'تعذّر تحميل مكتبة Supabase. تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.';
  } else if (!config.url || !config.anonKey) {
    configError = 'لم تُضبط إعدادات Supabase بعد. أضف Project URL و anon public key في ملف supabase-config.js.';
  } else {
    try {
      assertPublicKey(config.anonKey);
      client = window.supabase.createClient(String(config.url).replace(/\/$/, ''), config.anonKey, {
        auth: {
          storageKey: AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    } catch (error) {
      configError = error.message || 'تعذّر تهيئة اتصال Supabase.';
      console.error('[Supabase]', configError);
    }
  }

  const isConfigured = Boolean(client);

  function requireClient() {
    if (!client) {
      throw new StoreError(
        configError || 'لم يتم إعداد اتصال Supabase.',
        'SUPABASE_NOT_CONFIGURED',
      );
    }
    return client;
  }

  async function requireSession() {
    const supabase = requireClient();
    const { data, error } = await supabase.auth.getSession();
    if (error || !data || !data.session) {
      throw new StoreError('انتهت جلسة الدخول. سجّل الدخول مرة أخرى.', 'AUTH_REQUIRED');
    }
    return data.session;
  }

  async function ensureProfile(user, name) {
    const supabase = requireClient();
    const payload = {
      id: user.id,
      full_name: cleanText(name || (user.user_metadata && user.user_metadata.full_name) || '', 80),
    };
    const { error } = await supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throwDb(error, 'تعذّر تهيئة الملف المهني.');
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

  function profileToRow(profile) {
    const source = profile && typeof profile === 'object' ? profile : {};
    return {
      full_name: cleanText(source.fullName, 80),
      job_title: cleanText(source.jobTitle, 100),
      organization: cleanText(source.organization, 120),
      specialization: cleanText(source.specialization, 100),
      location: cleanText(source.location, 80),
      contact_email: cleanText(source.email, 160),
      phone: cleanText(source.phone, 30),
      website: cleanText(source.website, 300),
      years_experience: cleanText(source.yearsExperience, 20),
      bio: cleanText(source.bio, 3000),
      skills: Array.isArray(source.skills)
        ? source.skills.map((skill) => cleanText(skill, 40)).filter(Boolean).slice(0, 20)
        : [],
      photo: source.photo && typeof source.photo === 'object' && source.photo.dataUrl
        ? source.photo
        : null,
      updated_at: new Date().toISOString(),
    };
  }

  function rowToProfile(row, user) {
    const source = row && typeof row === 'object' ? row : {};
    return {
      fullName: source.full_name || user?.name || '',
      jobTitle: source.job_title || '',
      organization: source.organization || '',
      specialization: source.specialization || '',
      location: source.location || '',
      email: source.contact_email || '',
      phone: source.phone || '',
      website: source.website || '',
      yearsExperience: source.years_experience || '',
      bio: source.bio || '',
      skills: Array.isArray(source.skills) ? source.skills : [],
      photo: source.photo && typeof source.photo === 'object' ? source.photo : null,
      updatedAt: source.updated_at || new Date().toISOString(),
    };
  }

  function itemToRow(section, item, userId, options = {}) {
    const source = item && typeof item === 'object' ? item : {};
    const status = section === 'reports' && ['draft', 'final', 'approved'].includes(source.status)
      ? source.status
      : '';
    const evidenceType = section === 'evidence' && ['document', 'image', 'link', 'note'].includes(source.evidenceType)
      ? source.evidenceType
      : '';
    const row = {
      user_id: userId,
      section,
      title: cleanText(source.title || 'بدون عنوان', 160) || 'بدون عنوان',
      category: cleanText(source.category, 60),
      item_date: /^\d{4}-\d{2}-\d{2}$/.test(String(source.date || '')) ? String(source.date) : null,
      description: cleanText(source.description, 2000),
      tags: Array.isArray(source.tags)
        ? source.tags.map((tag) => cleanText(tag, 28)).filter(Boolean).slice(0, 10)
        : [],
      link: cleanText(source.link, 1000),
      attachments: Array.isArray(source.attachments) ? source.attachments.slice(0, 8) : [],
      content: section === 'reports' ? cleanText(source.content, 12000) : '',
      impact: cleanText(source.impact, 3000),
      status,
      evidence_type: evidenceType,
      linked_achievement_id: section === 'evidence' && isUuid(source.linkedAchievementId)
        ? source.linkedAchievementId
        : null,
      updated_at: normalizeTimestamp(source.updatedAt),
    };
    if (options.includeCreatedAt) {
      row.id = isUuid(source.id) ? source.id : makeUuid();
      row.created_at = normalizeTimestamp(source.createdAt);
    }
    return row;
  }

  function rowToItem(row) {
    return {
      id: row.id,
      section: row.section,
      title: row.title || '',
      category: row.category || '',
      date: row.item_date || '',
      description: row.description || '',
      tags: Array.isArray(row.tags) ? row.tags : [],
      link: row.link || '',
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      content: row.content || '',
      impact: row.impact || '',
      status: row.status || '',
      evidenceType: row.evidence_type || '',
      linkedAchievementId: row.linked_achievement_id || '',
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  function rowToActivity(row) {
    return {
      id: row.id,
      kind: row.kind || 'created',
      section: row.section || '',
      title: row.title || '',
      at: row.created_at || null,
    };
  }

  function latestTimestamp(values) {
    return values
      .filter(Boolean)
      .map((value) => ({ value, time: new Date(value).getTime() }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((a, b) => b.time - a.time)[0]?.value || new Date().toISOString();
  }

  async function register({ name, email, password }) {
    const supabase = requireClient();
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    const cleanEmail = normalizeEmail(email);
    if (cleanName.length < 2) throw new StoreError('أدخل الاسم الكامل (حرفان على الأقل).', 'INVALID_NAME');
    if (cleanName.length > 80) throw new StoreError('الاسم طويل جدًا.', 'INVALID_NAME');
    if (!isValidEmail(cleanEmail)) throw new StoreError('أدخل بريدًا إلكترونيًا صالحًا.', 'INVALID_EMAIL');
    const passwordError = passwordProblem(password);
    if (passwordError) throw new StoreError(passwordError, 'INVALID_PASSWORD');

    const redirectTo = authRedirectUrl();
    const { data, error } = await supabase.auth.signUp({
      email: cleanEmail,
      password,
      options: {
        data: { full_name: cleanName },
        ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
      },
    });
    if (error) throwAuth(error);
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new StoreError('يوجد حساب مسجّل بهذا البريد الإلكتروني.', 'EMAIL_EXISTS');
    }
    if (!data.session) {
      return {
        user: data.user ? publicUser(data.user) : null,
        needsConfirmation: true,
      };
    }
    await ensureProfile(data.user, cleanName);
    return { user: publicUser(data.user), needsConfirmation: false };
  }

  async function login({ email, password }) {
    const supabase = requireClient();
    if (!isValidEmail(email)) throw new StoreError('أدخل بريدًا إلكترونيًا صالحًا.', 'INVALID_EMAIL');
    if (!password) throw new StoreError('أدخل كلمة المرور.', 'INVALID_PASSWORD');
    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizeEmail(email),
      password,
    });
    if (error) throwAuth(error);
    await ensureProfile(data.user, data.user.user_metadata?.full_name || '');
    return publicUser(data.user);
  }

  async function getSession() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.error('[Supabase]', error.message || error);
      return null;
    }
    return data.session ? publicUser(data.session.user) : null;
  }

  function onAuthStateChange(callback) {
    if (!client) {
      return { data: { subscription: { unsubscribe() {} } } };
    }
    return client.auth.onAuthStateChange((event, session) => {
      const user = session ? publicUser(session.user) : null;
      // تأجيل المعالجة خارج قفل Supabase Auth لتجنب التعارض مع استعلامات قاعدة البيانات.
      setTimeout(() => {
        try {
          const result = callback(event, user);
          if (result && typeof result.catch === 'function') {
            result.catch((error) => console.error('[Supabase auth listener]', error));
          }
        } catch (error) {
          console.error('[Supabase auth listener]', error);
        }
      }, 0);
    });
  }

  async function logout() {
    if (!client) return true;
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throwAuth(error);
    return true;
  }

  async function changePassword(currentPassword, newPassword) {
    const supabase = requireClient();
    const session = await requireSession();
    const email = session.user.email;
    if (!email) throw new StoreError('تعذّر تحديد بريد الحساب.', 'EMAIL_MISSING');
    if (!currentPassword) throw new StoreError('أدخل كلمة المرور الحالية.', 'INVALID_PASSWORD');
    const problem = passwordProblem(newPassword);
    if (problem) throw new StoreError(problem, 'INVALID_PASSWORD');
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (verifyError) throw new StoreError('كلمة المرور الحالية غير صحيحة.', 'INVALID_PASSWORD');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throwAuth(error);
    return true;
  }

  async function updateAccountName(name) {
    const supabase = requireClient();
    const session = await requireSession();
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) return false;
    const { error: authError } = await supabase.auth.updateUser({
      data: { ...(session.user.user_metadata || {}), full_name: cleanName },
    });
    if (authError) throwAuth(authError);
    const { error } = await supabase.from('profiles').upsert({
      id: session.user.id,
      full_name: cleanName.slice(0, 80),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) throwDb(error, 'تعذّر تحديث اسم الحساب.');
    return true;
  }

  async function getWorkspace(userId) {
    const supabase = requireClient();
    const session = await requireSession();
    if (userId && session.user.id !== userId) {
      throw new StoreError('الحساب غير مطابق للجلسة الحالية.', 'USER_MISMATCH');
    }
    const user = publicUser(session.user);
    const [profileResult, itemsResult, activityResult] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
      supabase.from('items').select('*').eq('user_id', session.user.id).order('updated_at', { ascending: false }).range(0, 1999),
      supabase.from('activity').select('*').eq('user_id', session.user.id).order('created_at', { ascending: false }).limit(60),
    ]);
    if (profileResult.error) throwDb(profileResult.error, 'تعذّر تحميل الملف المهني.');
    if (itemsResult.error) throwDb(itemsResult.error, 'تعذّر تحميل عناصر الملف.');
    if (activityResult.error) throwDb(activityResult.error, 'تعذّر تحميل النشاط.');

    let profileRow = profileResult.data;
    if (!profileRow) {
      await ensureProfile(session.user, user.name);
      const retry = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (retry.error) throwDb(retry.error, 'تعذّر تهيئة الملف المهني.');
      profileRow = retry.data;
    }

    const workspace = emptyWorkspace(user);
    workspace.createdAt = profileRow?.created_at || user.createdAt || workspace.createdAt;
    workspace.profile = rowToProfile(profileRow, user);
    workspace.activity = (activityResult.data || []).map(rowToActivity);
    const itemTimestamps = [];
    (itemsResult.data || []).forEach((row) => {
      if (!SECTION_KEYS.includes(row.section)) return;
      workspace[row.section].push(rowToItem(row));
      if (row.updated_at) itemTimestamps.push(row.updated_at);
    });
    workspace.updatedAt = latestTimestamp([
      profileRow?.updated_at,
      ...itemTimestamps,
      workspace.activity[0]?.at,
    ]);
    return workspace;
  }

  async function saveProfile(profile) {
    const supabase = requireClient();
    const session = await requireSession();
    const { error } = await supabase.from('profiles').upsert({
      id: session.user.id,
      ...profileToRow(profile),
    }, { onConflict: 'id' });
    if (error) throwDb(error, 'تعذّر حفظ الملف المهني.');
    return true;
  }

  async function createItem(section, item) {
    const supabase = requireClient();
    if (!SECTION_KEYS.includes(section)) throw new StoreError('نوع المحتوى غير صالح.', 'INVALID_SECTION');
    const session = await requireSession();
    const row = itemToRow(section, item, session.user.id, { includeCreatedAt: true });
    const { data, error } = await supabase.from('items').insert(row).select('*').single();
    if (error) throwDb(error, 'تعذّر إضافة العنصر.');
    return rowToItem(data);
  }

  async function updateItem(section, item) {
    const supabase = requireClient();
    if (!SECTION_KEYS.includes(section)) throw new StoreError('نوع المحتوى غير صالح.', 'INVALID_SECTION');
    if (!item || !isUuid(item.id)) throw new StoreError('معرّف العنصر غير صالح.', 'INVALID_ITEM');
    const session = await requireSession();
    const row = itemToRow(section, item, session.user.id, { includeCreatedAt: false });
    delete row.id;
    const { data, error } = await supabase
      .from('items')
      .update(row)
      .eq('id', item.id)
      .eq('user_id', session.user.id)
      .select('*')
      .maybeSingle();
    if (error) throwDb(error, 'تعذّر تحديث العنصر.');
    if (!data) throw new StoreError('لم يعد هذا العنصر موجودًا.', 'ITEM_NOT_FOUND');
    return rowToItem(data);
  }

  async function deleteItem(section, id) {
    const supabase = requireClient();
    if (!SECTION_KEYS.includes(section)) throw new StoreError('نوع المحتوى غير صالح.', 'INVALID_SECTION');
    if (!isUuid(id)) throw new StoreError('معرّف العنصر غير صالح.', 'INVALID_ITEM');
    const session = await requireSession();
    const { error } = await supabase
      .from('items')
      .delete()
      .eq('id', id)
      .eq('user_id', session.user.id);
    if (error) throwDb(error, 'تعذّر حذف العنصر.');
    if (section === 'achievements') {
      const { error: linkError } = await supabase
        .from('items')
        .update({ linked_achievement_id: null })
        .eq('user_id', session.user.id)
        .eq('linked_achievement_id', id);
      if (linkError) throwDb(linkError, 'تعذّر تحديث الشواهد المرتبطة بالإنجاز.');
    }
    return true;
  }

  async function addActivity(activity) {
    const supabase = requireClient();
    const session = await requireSession();
    const source = activity && typeof activity === 'object' ? activity : {};
    const { data, error } = await supabase.from('activity').insert({
      id: isUuid(source.id) ? source.id : makeUuid(),
      user_id: session.user.id,
      kind: cleanText(source.kind, 24) || 'created',
      section: SECTION_KEYS.includes(source.section) ? source.section : null,
      title: cleanText(source.title, 140),
      created_at: normalizeTimestamp(source.at),
    }).select('*').single();
    if (error) throwDb(error, 'تعذّر حفظ النشاط.');
    return rowToActivity(data);
  }

  async function replaceWorkspace(workspace) {
    const supabase = requireClient();
    const session = await requireSession();
    const source = workspace && typeof workspace === 'object' ? workspace : {};
    const items = [];
    SECTION_KEYS.forEach((section) => {
      (Array.isArray(source[section]) ? source[section] : []).forEach((item) => {
        items.push({ ...item, section });
      });
    });
    const payload = {
      profile: source.profile || {},
      items,
      activity: Array.isArray(source.activity) ? source.activity.slice(0, 60) : [],
    };
    const { error } = await supabase.rpc('replace_workspace', { payload });
    if (error) {
      if (/Could not find the function|function .* does not exist/i.test(String(error.message || ''))) {
        throw new StoreError('دالة replace_workspace غير موجودة. نفّذ ملف supabase/schema.sql كاملًا أولًا.', 'RPC_MISSING');
      }
      throwDb(error, 'تعذّر استبدال بيانات المساحة.');
    }
    return true;
  }

  function workspaceBytes(workspace) {
    return jsonBytes(workspace);
  }

  window.AthariStore = {
    StoreError,
    MAX_WORKSPACE_BYTES,
    SECTION_KEYS,
    isConfigured,
    configError,
    register,
    login,
    getSession,
    onAuthStateChange,
    logout,
    getWorkspace,
    saveProfile,
    createItem,
    updateItem,
    deleteItem,
    addActivity,
    replaceWorkspace,
    workspaceBytes,
    changePassword,
    updateAccountName,
    normalizeEmail,
    isValidEmail,
    passwordProblem,
    makeUuid,
  };
})();
