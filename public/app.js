/* ==========================================================================
   أثري — ملف إنجازي الرقمي
   تطبيق واجهة يعمل بالكامل بقاعدة بيانات المتصفح المحلية (localStorage)
   ========================================================================== */
(function () {
  'use strict';

  const Store = window.AthariStore;
  const AR_LOCALE = 'ar-EG-u-nu-latn';
  const MAX_FILE_SIZE = 1.5 * 1024 * 1024;
  const MAX_IMAGE_SOURCE_SIZE = 8 * 1024 * 1024;
  const MAX_FILES_PER_ITEM = 8;

  const SECTIONS = {
    achievements: {
      key: 'achievements',
      title: 'إنجازاتي',
      singular: 'إنجاز',
      icon: 'award',
      color: 'green',
      description: 'وثّق إنجازاتك المهنية، وأبرز أثرها، وأرفق ما يدعمها من ملفات وروابط.',
      addLabel: 'إضافة إنجاز',
      searchPlaceholder: 'ابحث في العناوين، التصنيفات، الوسوم...',
      dateLabel: 'تاريخ الإنجاز',
    },
    evidence: {
      key: 'evidence',
      title: 'شواهدي',
      singular: 'شاهد',
      icon: 'archive',
      color: 'blue',
      description: 'اجمع الشواهد والصور والمستندات والروابط التي تُثبت أثر عملك وتوثّقه.',
      addLabel: 'إضافة شاهد',
      searchPlaceholder: 'ابحث في الشواهد والمرفقات...',
      dateLabel: 'تاريخ الشاهد',
    },
    reports: {
      key: 'reports',
      title: 'تقاريري',
      singular: 'تقرير',
      icon: 'file-text',
      color: 'teal',
      description: 'نظّم تقاريرك المهنية ونتائج أعمالك وملاحظاتك في مساحة واحدة واضحة.',
      addLabel: 'إضافة تقرير',
      searchPlaceholder: 'ابحث في التقارير والنتائج...',
      dateLabel: 'تاريخ التقرير',
    },
  };

  const NAV_GROUPS = [
    {
      label: 'مساحة العمل',
      items: [
        { key: 'dashboard', title: 'لوحة التحكم', icon: 'grid' },
        { key: 'profile', title: 'ملفي المهني', icon: 'user' },
      ],
    },
    {
      label: 'محتواي',
      items: [
        { key: 'achievements', title: 'إنجازاتي', icon: 'award', count: true },
        { key: 'evidence', title: 'شواهدي', icon: 'archive', count: true },
        { key: 'reports', title: 'تقاريري', icon: 'file-text', count: true },
      ],
    },
    {
      label: 'الحساب',
      items: [
        { key: 'settings', title: 'الإعدادات', icon: 'settings' },
      ],
    },
  ];

  const ROUTE_INFO = {
    dashboard: { kicker: 'مساحة العمل', title: 'لوحة التحكم' },
    profile: { kicker: 'ملفي', title: 'الملف المهني' },
    achievements: { kicker: 'محتواي', title: 'إنجازاتي' },
    evidence: { kicker: 'محتواي', title: 'شواهدي' },
    reports: { kicker: 'محتواي', title: 'تقاريري' },
    search: { kicker: 'البحث', title: 'نتائج البحث' },
    settings: { kicker: 'الحساب', title: 'الإعدادات' },
  };

  const VALID_ROUTES = new Set(Object.keys(ROUTE_INFO));
  const REPORT_STATUSES = {
    draft: { label: 'مسودة', icon: 'edit' },
    final: { label: 'نهائي', icon: 'file-text' },
    approved: { label: 'معتمد', icon: 'check-circle' },
  };
  const EVIDENCE_TYPES = {
    document: { label: 'مستند', icon: 'file-text' },
    image: { label: 'صورة', icon: 'image' },
    link: { label: 'رابط', icon: 'link' },
    note: { label: 'ملاحظة', icon: 'edit' },
  };

  const state = {
    user: null,
    workspace: null,
    currentRoute: 'dashboard',
    filters: {},
    searchQuery: '',
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    authMode: 'login',
  };

  let modalSequence = 0;
  const modalStack = [];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ------------------------------------------------------------------ */
  /* أدوات مساعدة                                                        */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function icon(name, className = '') {
    return `<svg class="icon${className ? ` ${className}` : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function normalizeArabic(value) {
    return String(value ?? '')
      .toLocaleLowerCase('ar')
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatDate(value, options = {}) {
    if (!value) return '';
    let date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      date = new Date(`${value}T12:00:00`);
    } else {
      date = new Date(value);
    }
    if (Number.isNaN(date.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat(AR_LOCALE, {
        day: 'numeric',
        month: options.short ? 'short' : 'long',
        year: 'numeric',
      }).format(date);
    } catch {
      return String(value);
    }
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat(AR_LOCALE, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    } catch {
      return String(value);
    }
  }

  function formatLongToday() {
    try {
      return new Intl.DateTimeFormat(AR_LOCALE, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date());
    } catch {
      return '';
    }
  }

  function relativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    const seconds = Math.max(0, Math.floor(diff / 1000));
    if (seconds < 45) return 'الآن';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes === 1 ? 'منذ دقيقة' : `منذ ${minutes} دقيقة`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? 'منذ ساعة' : `منذ ${hours} ساعات`;
    const days = Math.floor(hours / 24);
    if (days < 7) return days === 1 ? 'منذ يوم' : `منذ ${days} أيام`;
    if (days < 30) {
      const weeks = Math.floor(days / 7);
      return weeks === 1 ? 'منذ أسبوع' : `منذ ${weeks} أسابيع`;
    }
    return formatDate(value);
  }

  function todayISO() {
    const date = new Date();
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '0 ك.ب';
    if (value < 1024) return `${value} بايت`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} ك.ب`;
    return `${(value / (1024 * 1024)).toFixed(1)} م.ب`;
  }

  function truncateText(value, max = 120) {
    const text = String(value ?? '').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max).trim()}…`;
  }

  function initials(name) {
    const clean = String(name || '').trim();
    if (!clean) return 'أ';
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2);
    return `${parts[0][0]}${parts[1][0]}`;
  }

  function makeUrl(value, allowEmpty = true) {
    const raw = String(value || '').trim();
    if (!raw) return allowEmpty ? '' : null;
    let candidate = raw;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function urlLabel(value) {
    const safe = makeUrl(value);
    if (!safe) return '';
    try {
      return new URL(safe).host.replace(/^www\./, '');
    } catch {
      return safe;
    }
  }

  function getInitialsFromUser() {
    return initials(state.profile?.fullName || state.user?.name);
  }

  function getProfilePhoto() {
    const photo = state.profile?.photo;
    if (photo && typeof photo === 'object' && /^data:image\//.test(photo.dataUrl || '')) return photo.dataUrl;
    return '';
  }

  function avatarMarkup(name, photoUrl, className = '') {
    const cls = `avatar${className ? ` ${className}` : ''}`;
    if (photoUrl) {
      return `<span class="${cls}"><img src="${escapeAttr(photoUrl)}" alt="" loading="lazy"></span>`;
    }
    return `<span class="${cls}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
  }

  function setMetaTheme(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#071517' : '#f3f7f7');
  }

  function applyTheme(theme, persist = true) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    setMetaTheme(state.theme);
    if (persist) {
      try { localStorage.setItem('athari-theme', state.theme); } catch { /* تجاهل */ }
    }
    syncThemeControls();
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  function syncThemeControls() {
    $$('[data-theme-toggle]').forEach((button) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      const label = next === 'dark' ? 'التبديل إلى الوضع الليلي' : 'التبديل إلى الوضع النهاري';
      button.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    });
    $$('[data-set-theme]').forEach((button) => {
      const isActive = button.dataset.setTheme === state.theme;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------------ */
  /* التنبيهات                                                           */
  /* ------------------------------------------------------------------ */

  function toast(message, type = 'success', title = '') {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const icons = { success: 'check-circle', error: 'alert-circle', warning: 'alert-circle', info: 'info' };
    const titles = { success: 'تم بنجاح', error: 'تعذّر إتمام العملية', warning: 'تنبيه', info: 'معلومة' };
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.innerHTML = `
      <span class="toast-icon">${icon(icons[type] || 'info')}</span>
      <div>
        <strong>${escapeHtml(title || titles[type] || '')}</strong>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
    item.addEventListener('click', () => dismissToast(item));
    region.appendChild(item);
    setTimeout(() => dismissToast(item), type === 'error' ? 5600 : 4200);
  }

  function dismissToast(item) {
    if (!item || item.classList.contains('is-leaving')) return;
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 220);
  }

  function setButtonLoading(button, loading, loadingLabel = 'جارٍ المعالجة...') {
    if (!button) return;
    if (loading) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span><span>${escapeHtml(loadingLabel)}</span>`;
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* النوافذ المنبثقة                                                     */
  /* ------------------------------------------------------------------ */

  function focusableElements(container) {
    return $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter((element) => element.getClientRects().length > 0 && !element.hasAttribute('hidden'));
  }

  function openModal(options) {
    const {
      title = '',
      subtitle = '',
      kicker = '',
      kickerIcon = '',
      body = '',
      size = '',
      hideHeader = false,
      closeOnBackdrop = true,
      onMount = null,
      onClose = null,
    } = options;

    const previousFocus = document.activeElement;
    const modalId = `modal-title-${++modalSequence}`;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card ${size}" role="dialog" aria-modal="true" ${title ? `aria-labelledby="${modalId}"` : ''}>
        ${hideHeader ? '' : `
          <div class="modal-header">
            <div class="modal-header-main">
              ${kicker ? `<span class="modal-kicker">${kickerIcon ? icon(kickerIcon) : ''}${escapeHtml(kicker)}</span>` : ''}
              <h2 class="modal-title" id="${modalId}">${escapeHtml(title)}</h2>
              ${subtitle ? `<p class="modal-subtitle">${escapeHtml(subtitle)}</p>` : ''}
            </div>
            <button class="modal-close" type="button" aria-label="إغلاق النافذة" data-modal-close>${icon('x')}</button>
          </div>
        `}
        <div class="modal-body${hideHeader ? ' no-pad' : ''}">${body}</div>
      </div>
    `;

    document.getElementById('modal-root').appendChild(backdrop);
    document.body.classList.add('modal-open');

    let closed = false;
    const entry = { backdrop, close: () => close(false) };
    modalStack.push(entry);

    function close(result = false) {
      if (closed) return;
      closed = true;
      backdrop.remove();
      const index = modalStack.indexOf(entry);
      if (index !== -1) modalStack.splice(index, 1);
      if (!modalStack.length) document.body.classList.remove('modal-open');
      if (typeof onClose === 'function') onClose(result);
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus({ preventScroll: true }); } catch { /* تجاهل */ }
      }
    }

    entry.close = close;

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop && closeOnBackdrop) close(false);
    });
    $$('[data-modal-close]', backdrop).forEach((button) => {
      button.addEventListener('click', () => close(false));
    });

    requestAnimationFrame(() => {
      const focusables = focusableElements(backdrop);
      const target = $('[autofocus]', backdrop) || focusables[0];
      if (target) target.focus({ preventScroll: true });
    });

    if (typeof onMount === 'function') {
      try {
        onMount({ backdrop, close, modal: $('.modal-card', backdrop) });
      } catch (error) {
        console.error(error);
        toast('حدث خطأ في عرض النافذة.', 'error');
      }
    }

    return { backdrop, close };
  }

  function closeTopModal() {
    if (!modalStack.length) return;
    const top = modalStack[modalStack.length - 1];
    top.close(false);
  }

  document.addEventListener('keydown', (event) => {
    if (!modalStack.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTopModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const backdrop = modalStack[modalStack.length - 1].backdrop;
    const focusables = focusableElements(backdrop);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || !backdrop.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !backdrop.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });

  function confirmDialog({
    title,
    message,
    confirmLabel = 'تأكيد الحذف',
    cancelLabel = 'إلغاء',
    iconName = 'trash',
    danger = true,
    onConfirm = null,
  }) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const { backdrop, close } = openModal({
        hideHeader: true,
        size: 'sm',
        closeOnBackdrop: true,
        body: `
          <div class="confirm-body">
            <div class="confirm-icon">${icon(iconName)}</div>
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(message)}</p>
            <div class="confirm-actions">
              <button type="button" class="btn" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>
              <button type="button" class="btn ${danger ? 'danger-solid' : 'primary'}" data-confirm-ok>${escapeHtml(confirmLabel)}</button>
            </div>
          </div>
        `,
        onMount: ({ backdrop: dialog }) => {
          $('[data-confirm-cancel]', dialog).addEventListener('click', () => { done(false); close(false); });
          $('[data-confirm-ok]', dialog).addEventListener('click', async () => {
            const okButton = $('[data-confirm-ok]', dialog);
            try {
              if (typeof onConfirm === 'function') await onConfirm();
              done(true);
              close(true);
            } catch (error) {
              done(false);
              setButtonLoading(okButton, false);
              toast(error.message || 'تعذّر إتمام العملية.', 'error');
            }
          });
        },
        onClose: (result) => {
          done(Boolean(result));
        },
      });
      // Reference to prevent accidental unused warning in older browsers.
      void backdrop;
    });
  }

  function openLightbox(src, caption = '') {
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', caption || 'معاينة الصورة');
    lightbox.innerHTML = `
      <button class="lightbox-close" type="button" aria-label="إغلاق المعاينة">${icon('x')}</button>
      <img src="${escapeAttr(src)}" alt="${escapeAttr(caption)}">
      ${caption ? `<div class="lightbox-caption">${escapeHtml(caption)}</div>` : ''}
    `;
    const close = () => {
      lightbox.remove();
      document.removeEventListener('keydown', onKey);
      if (!modalStack.length) document.body.classList.remove('modal-open');
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    lightbox.addEventListener('click', (event) => {
      if (event.target === lightbox || event.target.closest('.lightbox-close')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    document.getElementById('modal-root').appendChild(lightbox);
    setTimeout(() => $('.lightbox-close', lightbox)?.focus(), 20);
  }

  /* ------------------------------------------------------------------ */
  /* المصادقة                                                            */
  /* ------------------------------------------------------------------ */

  function authModeMarkup(mode) {
    return `
      <div class="auth-tabs" role="tablist" aria-label="خيارات الدخول">
        <button class="auth-tab ${mode === 'login' ? 'active' : ''}" type="button" data-auth-mode="login" role="tab" aria-selected="${mode === 'login'}">تسجيل الدخول</button>
        <button class="auth-tab ${mode === 'register' ? 'active' : ''}" type="button" data-auth-mode="register" role="tab" aria-selected="${mode === 'register'}">إنشاء حساب</button>
      </div>
    `;
  }

  function loginFormMarkup() {
    return `
      <form class="auth-form" id="login-form" novalidate>
        <div class="form-alert error" data-auth-error hidden></div>
        <div class="form-field">
          <label for="login-email">البريد الإلكتروني</label>
          <div class="input-wrap">
            ${icon('mail')}
            <input id="login-email" name="email" type="email" inputmode="email" autocomplete="username" placeholder="name@example.com" dir="ltr" required autofocus>
          </div>
        </div>
        <div class="form-field">
          <label for="login-password">كلمة المرور</label>
          <div class="input-wrap has-action">
            ${icon('lock')}
            <input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="أدخل كلمة المرور" required>
            <button class="input-action" type="button" data-toggle-password aria-label="إظهار كلمة المرور">${icon('eye')}</button>
          </div>
        </div>
        <button class="auth-submit" type="submit">تسجيل الدخول ${icon('arrow-left')}</button>
        <div class="auth-local-note">
          ${icon('shield')}
          <span>مساحتك خاصة بك وحدك. تُحفظ بياناتك محليًا داخل هذا المتصفح، ولا تُرسل إلى أي خادم خارجي.</span>
        </div>
      </form>
    `;
  }

  function registerFormMarkup() {
    return `
      <form class="auth-form" id="register-form" novalidate>
        <div class="form-alert error" data-auth-error hidden></div>
        <div class="form-field">
          <label for="register-name">الاسم الكامل</label>
          <div class="input-wrap">
            ${icon('user')}
            <input id="register-name" name="name" type="text" autocomplete="name" placeholder="مثال: سارة العتيبي" required autofocus>
          </div>
        </div>
        <div class="form-field">
          <label for="register-email">البريد الإلكتروني</label>
          <div class="input-wrap">
            ${icon('mail')}
            <input id="register-email" name="email" type="email" inputmode="email" autocomplete="username" placeholder="name@example.com" dir="ltr" required>
          </div>
        </div>
        <div class="form-field">
          <label for="register-password">كلمة المرور</label>
          <div class="input-wrap has-action">
            ${icon('lock')}
            <input id="register-password" name="password" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل" required>
            <button class="input-action" type="button" data-toggle-password aria-label="إظهار كلمة المرور">${icon('eye')}</button>
          </div>
          <div class="password-strength" data-password-strength data-score="0" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <span class="field-hint">${icon('info')} استخدم 8 أحرف على الأقل، مع حرف ورقم.</span>
        </div>
        <div class="form-field">
          <label for="register-confirm">تأكيد كلمة المرور</label>
          <div class="input-wrap">
            ${icon('lock')}
            <input id="register-confirm" name="confirm" type="password" autocomplete="new-password" placeholder="أعد كتابة كلمة المرور" required>
          </div>
        </div>
        <button class="auth-submit" type="submit">إنشاء المساحة ${icon('arrow-left')}</button>
        <div class="auth-local-note">
          ${icon('database')}
          <span>بإنشاء الحساب تُنشأ مساحة مستقلة باسمك. احتفظ ببيانات الدخول؛ فالحساب محلي ولا يمكن استعادته من خادم.</span>
        </div>
      </form>
    `;
  }

  function renderAuth(mode) {
    if (!VALID_ROUTES) return;
    const chosenMode = mode === 'register' ? 'register' : 'login';
    state.authMode = chosenMode;
    state.user = null;
    state.workspace = null;
    const authView = document.getElementById('auth-view');
    const appView = document.getElementById('app-view');
    appView.hidden = true;
    authView.hidden = false;

    const isRegister = chosenMode === 'register';
    authView.innerHTML = `
      <div class="auth-shell">
        <section class="auth-hero" aria-label="تعريف بأثري">
          <div class="auth-hero-grid"></div>
          <div class="auth-arch"></div>
          <div class="auth-brand">
            <img src="assets/favicon.svg" alt="">
            <div class="auth-brand-word">
              <strong>أثري</strong>
              <span>ملف إنجازي الرقمي</span>
            </div>
          </div>
          <div class="auth-hero-content">
            <span class="auth-eyebrow"><span class="dot"></span>مساحتك المهنية الرقمية</span>
            <h1>كل أثرٍ تصنعه،<br><span class="gradient-text">يستحق أن يُوثَّق.</span></h1>
            <p class="auth-hero-lead">اجمع إنجازاتك وشواهدك وتقاريرك في ملف واحد أنيق، منظّم، ويحفظ لك أثرك المهني عامًا بعد عام.</p>
            <div class="auth-features">
              <span class="auth-feature">${icon('award')} إنجازات موثّقة</span>
              <span class="auth-feature">${icon('archive')} شواهد ومرفقات</span>
              <span class="auth-feature">${icon('file-text')} تقارير منظّمة</span>
            </div>
          </div>
          <div class="auth-preview" aria-hidden="true">
            <div class="preview-head">
              <span class="preview-avatar">س</span>
              <div><strong>سارة العتيبي</strong><span>أخصائية تطوير مهني</span></div>
              <span class="preview-badge"><span class="dot"></span> ملف نشط</span>
            </div>
            <div class="preview-progress-label"><span>اكتمال الملف المهني</span><strong>72%</strong></div>
            <div class="preview-progress"><span></span></div>
            <div class="preview-stats">
              <div class="preview-stat"><strong>12</strong><span>إنجاز</span></div>
              <div class="preview-stat"><strong>08</strong><span>شاهد</span></div>
              <div class="preview-stat"><strong>05</strong><span>تقرير</span></div>
            </div>
          </div>
          <div class="auth-hero-foot">
            <span>${icon('lock')} بيانات محلية خاصة</span>
            <span>أثري © 2026</span>
          </div>
        </section>
        <section class="auth-panel">
          <div class="auth-panel-top">
            <button class="icon-btn" type="button" data-theme-toggle aria-label="تبديل المظهر">${icon(state.theme === 'dark' ? 'sun' : 'moon')}</button>
          </div>
          <div class="auth-card">
            <div class="auth-card-brand">
              <img src="assets/favicon.svg" alt="">
              <div><strong>أثري</strong><span>ملف إنجازي الرقمي</span></div>
            </div>
            <span class="auth-kicker"><span class="dot"></span>${isRegister ? 'بداية جديدة' : 'مرحبًا بعودتك'}</span>
            <h1 class="auth-title">${isRegister ? 'أنشئ مساحتك المهنية' : 'سجّل الدخول إلى ملفك'}</h1>
            <p class="auth-subtitle">${isRegister ? 'دقيقة واحدة تفصلك عن ملف إنجاز رقمي يجمع كل ما يستحق أن يُحفظ.' : 'أدخل بياناتك للوصول إلى إنجازاتك وشواهدك وتقاريرك.'}</p>
            ${authModeMarkup(chosenMode)}
            ${isRegister ? registerFormMarkup() : loginFormMarkup()}
          </div>
          <p class="auth-panel-foot">أثري — ملف إنجازي الرقمي · نسخة محلية تحفظ خصوصيتك</p>
        </section>
      </div>
    `;
    syncThemeControls();
    bindAuthEvents();
  }

  function bindAuthEvents() {
    const authView = document.getElementById('auth-view');
    $$('[data-auth-mode]', authView).forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.authMode === state.authMode) return;
        renderAuth(button.dataset.authMode);
      });
    });

    $$('[data-toggle-password]', authView).forEach((button) => {
      button.addEventListener('click', () => {
        const wrap = button.closest('.input-wrap');
        const input = $('input', wrap);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.innerHTML = icon(show ? 'eye-off' : 'eye');
        button.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
      });
    });

    const passwordInput = $('#register-password', authView);
    const strength = $('[data-password-strength]', authView);
    if (passwordInput && strength) {
      passwordInput.addEventListener('input', () => {
        const score = passwordScore(passwordInput.value);
        strength.dataset.score = String(score);
      });
    }

    const loginForm = $('#login-form', authView);
    if (loginForm) loginForm.addEventListener('submit', handleLoginSubmit);
    const registerForm = $('#register-form', authView);
    if (registerForm) registerForm.addEventListener('submit', handleRegisterSubmit);
  }

  function passwordScore(value) {
    const password = String(value || '');
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Za-z\u0600-\u06FF]/u.test(password) && /\d/u.test(password)) score += 1;
    if (/[^A-Za-z0-9\u0600-\u06FF\s]/u.test(password) || password.length >= 16) score += 1;
    return Math.min(4, score);
  }

  function showAuthError(message) {
    const box = document.querySelector('[data-auth-error]');
    if (!box) {
      toast(message, 'error');
      return;
    }
    box.innerHTML = `${icon('alert-circle')}<span>${escapeHtml(message)}</span>`;
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const errorBox = $('[data-auth-error]', form);
    if (errorBox) errorBox.hidden = true;
    const email = String(form.elements.email.value || '').trim();
    const password = String(form.elements.password.value || '');
    if (!email || !password) {
      showAuthError('أدخل البريد الإلكتروني وكلمة المرور للمتابعة.');
      return;
    }
    if (!Store.isValidEmail(email)) {
      showAuthError('صيغة البريد الإلكتروني غير صحيحة.');
      return;
    }
    const submit = $('button[type="submit"]', form);
    setButtonLoading(submit, true, 'جارٍ التحقق...');
    try {
      const user = await Store.login({ email, password, remember: true });
      toast(`أهلًا بعودتك، ${user.name.split(/\s+/)[0]}.`, 'success');
      enterApp(user);
    } catch (error) {
      setButtonLoading(submit, false);
      showAuthError(error.message || 'تعذّر تسجيل الدخول.');
    }
  }

  async function handleRegisterSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const errorBox = $('[data-auth-error]', form);
    if (errorBox) errorBox.hidden = true;
    const name = String(form.elements.name.value || '').trim();
    const email = String(form.elements.email.value || '').trim();
    const password = String(form.elements.password.value || '');
    const confirm = String(form.elements.confirm.value || '');

    if (name.trim().length < 2) return showAuthError('أدخل اسمك الكامل (حرفان على الأقل).');
    if (!Store.isValidEmail(email)) return showAuthError('أدخل بريدًا إلكترونيًا صالحًا.');
    const problem = Store.passwordProblem(password);
    if (problem) return showAuthError(problem);
    if (password !== confirm) return showAuthError('كلمتا المرور غير متطابقتين.');

    const submit = $('button[type="submit"]', form);
    setButtonLoading(submit, true, 'جارٍ إنشاء المساحة...');
    try {
      const user = await Store.register({ name, email, password });
      toast('تم إنشاء مساحتك المهنية بنجاح. خطوتك الأولى تبدأ الآن.', 'success');
      enterApp(user);
    } catch (error) {
      setButtonLoading(submit, false);
      showAuthError(error.message || 'تعذّر إنشاء الحساب.');
    }
  }

  function enterApp(user) {
    state.user = user;
    try {
      state.workspace = Store.getWorkspace(user.id);
    } catch (error) {
      toast(error.message || 'تعذّر تحميل المساحة.', 'error');
      return;
    }
    state.profile = state.workspace.profile;
    document.getElementById('auth-view').hidden = true;
    document.getElementById('app-view').hidden = false;
    renderShell();
    const { name } = parseHash();
    const firstRoute = VALID_ROUTES.has(name) && name !== 'search' ? name : 'dashboard';
    if (location.hash && location.hash !== `#${firstRoute}`) {
      history.replaceState(null, '', `#${firstRoute}`);
    } else if (!location.hash) {
      history.replaceState(null, '', `#${firstRoute}`);
    }
    state.currentRoute = firstRoute;
    renderRoute();
    hideBoot();
    document.title = `${ROUTE_INFO[firstRoute].title} | أثري`;
  }

  function hideBoot() {
    const boot = document.getElementById('boot-screen');
    if (!boot) return;
    boot.classList.add('is-hidden');
    setTimeout(() => boot.remove(), 450);
  }

  function parseHash() {
    const raw = window.location.hash.replace(/^#/, '');
    const [rawName, rawQuery = ''] = raw.split('?');
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* تجاهل */ }
    if (!name) name = 'dashboard';
    let params = new URLSearchParams();
    if (rawQuery) {
      try { params = new URLSearchParams(rawQuery); } catch { /* تجاهل */ }
    }
    return { name, params };
  }

  function navigate(route, params = {}, replace = false) {
    const safeRoute = VALID_ROUTES.has(route) ? route : 'dashboard';
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
    });
    const hash = `#${safeRoute}${query.toString() ? `?${query.toString()}` : ''}`;
    closeSidebar();
    if (window.location.hash === hash) {
      renderRoute();
      return;
    }
    if (replace) {
      history.replaceState(null, '', hash);
      renderRoute();
    } else {
      window.location.hash = hash;
    }
  }

  function logout() {
    confirmDialog({
      title: 'تسجيل الخروج؟',
      message: 'ستعود إلى شاشة الدخول. تبقى بيانات مساحتك محفوظة في هذا المتصفح ويمكنك الدخول إليها لاحقًا.',
      confirmLabel: 'تسجيل الخروج',
      iconName: 'logout',
      danger: false,
    }).then((confirmed) => {
      if (!confirmed) return;
      Store.logout();
      state.user = null;
      state.workspace = null;
      state.profile = null;
      state.currentRoute = 'dashboard';
      state.filters = {};
      document.getElementById('app-view').hidden = true;
      history.replaceState(null, '', window.location.pathname + window.location.search);
      renderAuth('login');
      document.title = 'أثري | ملف إنجازي الرقمي';
    });
  }

  /* ------------------------------------------------------------------ */
  /* هيكل التطبيق                                                        */
  /* ------------------------------------------------------------------ */

  function renderShell() {
    const sidebar = document.getElementById('sidebar');
    const topbar = document.getElementById('topbar');
    const photo = getProfilePhoto();
    const profile = state.profile || {};
    const user = state.user || {};

    sidebar.innerHTML = `
      <div class="sidebar-top">
        <button class="brand" type="button" data-route="dashboard" aria-label="العودة إلى لوحة التحكم">
          <img src="assets/favicon.svg" alt="">
          <span class="brand-text"><strong>أثري</strong><span>ملف إنجازي الرقمي</span></span>
        </button>
        <button class="sidebar-close" type="button" data-close-sidebar aria-label="إغلاق القائمة">${icon('x')}</button>
      </div>
      <button class="sidebar-account" type="button" data-route="profile">
        <span data-shell-avatar-wrap>${avatarMarkup(profile.fullName || user.name, photo)}</span>
        <span class="sidebar-account-info">
          <strong data-shell-name>${escapeHtml(profile.fullName || user.name || 'مستخدم')}</strong>
          <span data-shell-subtitle>${escapeHtml(profile.jobTitle || user.email || 'مساحة شخصية')}</span>
        </span>
        ${icon('chevron-left')}
      </button>
      <nav class="sidebar-nav" aria-label="التنقل الرئيسي">
        ${NAV_GROUPS.map((group) => `
          <div class="nav-group">
            <span class="nav-label">${escapeHtml(group.label)}</span>
            ${group.items.map((item) => `
              <button class="nav-item" type="button" data-route="${item.key}">
                ${icon(item.icon)}
                <span>${escapeHtml(item.title)}</span>
                ${item.count ? `<span class="nav-count" data-nav-count="${item.key}">${countSection(item.key)}</span>` : ''}
              </button>
            `).join('')}
          </div>
        `).join('')}
      </nav>
      <div class="sidebar-bottom">
        <div class="storage-widget" id="storage-widget">
          <div class="storage-widget-head">
            ${icon('database')}
            <span>مساحة التخزين</span>
            <strong data-storage-text>0%</strong>
          </div>
          <div class="storage-track"><span data-storage-bar></span></div>
        </div>
        <div class="sidebar-foot">
          <button class="nav-item" type="button" data-logout>${icon('logout')}<span>تسجيل الخروج</span></button>
        </div>
      </div>
    `;

    topbar.innerHTML = `
      <button class="icon-btn topbar-menu" type="button" data-open-sidebar aria-label="فتح القائمة" aria-controls="sidebar">${icon('menu')}</button>
      <div class="topbar-heading">
        <span class="topbar-kicker" id="topbar-kicker">مساحة العمل</span>
        <h1 class="topbar-title" id="topbar-title">لوحة التحكم</h1>
      </div>
      <form class="topbar-search" id="global-search-form" role="search">
        ${icon('search')}
        <input type="search" id="global-search" name="q" placeholder="ابحث في إنجازاتك وشواهدك..." aria-label="بحث شامل" autocomplete="off">
        <kbd>Ctrl K</kbd>
      </form>
      <div class="topbar-actions">
        <button class="icon-btn topbar-search-mobile" type="button" data-route="search" aria-label="البحث">${icon('search')}</button>
        <button class="btn primary topbar-add" type="button" data-quick-add>${icon('plus')}<span>إضافة</span></button>
        <button class="icon-btn" type="button" data-theme-toggle aria-label="تبديل المظهر">${icon(state.theme === 'dark' ? 'sun' : 'moon')}</button>
      </div>
    `;

    updateShellData();
    updateRouteChrome();
    syncThemeControls();
  }

  function countSection(section) {
    return Array.isArray(state.workspace?.[section]) ? state.workspace[section].length : 0;
  }

  function collectAllItems() {
    const items = [];
    Object.keys(SECTIONS).forEach((section) => {
      (state.workspace?.[section] || []).forEach((item) => items.push({ ...item, section }));
    });
    return items;
  }

  function countAttachments() {
    return collectAllItems().reduce((total, item) => total + (Array.isArray(item.attachments) ? item.attachments.length : 0), 0);
  }

  function getStorageInfo() {
    let bytes = 0;
    try { bytes = Store.workspaceBytes(state.workspace); } catch { bytes = 0; }
    const limit = Store.MAX_WORKSPACE_BYTES || 4.5 * 1024 * 1024;
    const percent = Math.min(100, Math.round((bytes / limit) * 100));
    return { bytes, limit, percent };
  }

  function updateStorageWidget() {
    const info = getStorageInfo();
    const widget = document.getElementById('storage-widget');
    if (!widget) return;
    widget.classList.toggle('is-warning', info.percent >= 82);
    const text = $('[data-storage-text]', widget);
    const bar = $('[data-storage-bar]', widget);
    if (text) text.textContent = `${info.percent}%`;
    if (bar) bar.style.width = `${Math.max(info.percent, info.bytes ? 2 : 0)}%`;
    widget.title = `${formatBytes(info.bytes)} من ${formatBytes(info.limit)}`;
  }

  function updateShellData() {
    const profile = state.profile || {};
    const user = state.user || {};
    const name = profile.fullName || user.name || 'مستخدم';
    const photo = getProfilePhoto();
    const avatarWrap = $('[data-shell-avatar-wrap]');
    if (avatarWrap) avatarWrap.innerHTML = avatarMarkup(name, photo);
    const nameEl = $('[data-shell-name]');
    if (nameEl) nameEl.textContent = name;
    const subtitle = $('[data-shell-subtitle]');
    if (subtitle) subtitle.textContent = profile.jobTitle || user.email || 'مساحة شخصية';
    Object.keys(SECTIONS).forEach((section) => {
      $$(`[data-nav-count="${section}"]`).forEach((el) => { el.textContent = String(countSection(section)); });
    });
    updateStorageWidget();
  }

  function updateRouteChrome() {
    const info = ROUTE_INFO[state.currentRoute] || ROUTE_INFO.dashboard;
    const titleEl = document.getElementById('topbar-title');
    const kickerEl = document.getElementById('topbar-kicker');
    if (titleEl) titleEl.textContent = info.title;
    if (kickerEl) kickerEl.textContent = info.kicker;
    document.title = `${info.title} | أثري`;
    $$('.nav-item[data-route]').forEach((item) => {
      const active = item.dataset.route === state.currentRoute;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    const search = document.getElementById('global-search');
    if (search && state.currentRoute === 'search') search.value = state.searchQuery || '';
  }

  function toggleSidebar(open) {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebar-scrim');
    if (!sidebar || !scrim) return;
    const shouldOpen = typeof open === 'boolean' ? open : !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', shouldOpen);
    scrim.classList.toggle('show', shouldOpen);
    document.body.style.overflow = shouldOpen ? 'hidden' : '';
    const firstItem = $('.nav-item', sidebar);
    if (shouldOpen && firstItem) firstItem.focus({ preventScroll: true });
  }

  function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebar-scrim');
    if (!sidebar || !scrim) return;
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
    document.body.style.overflow = modalStack.length ? 'hidden' : '';
  }

  function renderRoute() {
    if (!state.user || !state.workspace) return;
    const parsed = parseHash();
    const route = VALID_ROUTES.has(parsed.name) ? parsed.name : 'dashboard';
    state.currentRoute = route;
    if (route === 'search') {
      state.searchQuery = (parsed.params.get('q') || '').trim();
    }
    updateRouteChrome();
    const page = document.getElementById('page');
    if (!page) return;
    switch (route) {
      case 'dashboard':
        renderDashboard(page);
        break;
      case 'profile':
        renderProfile(page);
        break;
      case 'achievements':
      case 'evidence':
      case 'reports':
        renderSectionPage(page, route);
        break;
      case 'search':
        renderSearchPage(page);
        break;
      case 'settings':
        renderSettings(page);
        break;
      default:
        renderDashboard(page);
    }
    updateShellData();
    updateRouteChrome();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function debounce(fn, wait = 220) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /* ------------------------------------------------------------------ */
  /* الملف الشخصي — الحسابات والاكتمال                                   */
  /* ------------------------------------------------------------------ */

  function profileChecks() {
    const profile = state.profile || {};
    const skills = Array.isArray(profile.skills) ? profile.skills.filter(Boolean) : [];
    return [
      { key: 'fullName', label: 'الاسم الكامل', missing: 'أضف اسمك الكامل', done: Boolean(String(profile.fullName || '').trim()) },
      { key: 'jobTitle', label: 'المسمى الوظيفي', missing: 'أضف مسمى وظيفيًا', done: Boolean(String(profile.jobTitle || '').trim()) },
      { key: 'organization', label: 'جهة العمل', missing: 'أضف جهة العمل', done: Boolean(String(profile.organization || '').trim()) },
      { key: 'specialization', label: 'التخصص', missing: 'حدّد تخصصك', done: Boolean(String(profile.specialization || '').trim()) },
      { key: 'bio', label: 'نبذة مهنية', missing: 'اكتب نبذة مهنية', done: String(profile.bio || '').trim().length >= 40 },
      { key: 'photo', label: 'صورة شخصية', missing: 'أضف صورة شخصية', done: Boolean(profile.photo?.dataUrl) },
      { key: 'contact', label: 'بيانات التواصل', missing: 'أضف بريدًا أو هاتفًا', done: Boolean(String(profile.email || '').trim() || String(profile.phone || '').trim()) },
      { key: 'skills', label: 'ثلاث مهارات على الأقل', missing: 'أضف ثلاث مهارات', done: skills.length >= 3 },
    ];
  }

  function profileCompletion() {
    const checks = profileChecks();
    const completed = checks.filter((check) => check.done).length;
    const percent = Math.round((completed / checks.length) * 100);
    return {
      percent,
      completed,
      total: checks.length,
      checks,
      missing: checks.filter((check) => !check.done),
    };
  }

  function greetingWord() {
    const hour = new Date().getHours();
    if (hour < 12) return 'صباح الخير';
    if (hour < 17) return 'مساء الخير';
    return 'مساء الخير';
  }

  function firstName() {
    const name = state.profile?.fullName || state.user?.name || '';
    return String(name).trim().split(/\s+/)[0] || 'بك';
  }

  function activityLabel(activity) {
    const section = activity.section ? SECTIONS[activity.section] : null;
    const title = activity.title ? `«${activity.title}»` : '';
    switch (activity.kind) {
      case 'created': return `أضفت ${section?.singular || 'عنصرًا'} ${title}`;
      case 'updated': return `حدّثت ${section?.singular || 'عنصرًا'} ${title}`;
      case 'deleted': return `حذفت ${section?.singular || 'عنصرًا'} ${title}`;
      case 'attachment': return `أرفقت ملفًا في ${title}`;
      case 'profile': return 'حدّثت بيانات ملفك المهني';
      case 'imported': return 'استعدت نسخة احتياطية من ملفك';
      case 'password': return 'غيّرت كلمة المرور';
      default: return activity.title || 'نشاط جديد';
    }
  }

  function pushActivity(workspace, kind, section = '', title = '') {
    workspace.activity = Array.isArray(workspace.activity) ? workspace.activity : [];
    workspace.activity.unshift({
      id: uid(),
      kind,
      section,
      title: String(title || '').slice(0, 140),
      at: new Date().toISOString(),
    });
    workspace.activity = workspace.activity.slice(0, 60);
  }

  function commitWorkspace(mutator, options = {}) {
    if (!state.workspace || !state.user) throw new Error('لا توجد مساحة عمل نشطة.');
    const snapshot = JSON.stringify(state.workspace);
    try {
      mutator(state.workspace);
      state.workspace.updatedAt = new Date().toISOString();
      if (options.activity) {
        pushActivity(state.workspace, options.activity.kind, options.activity.section, options.activity.title);
      }
      Store.saveWorkspace(state.user.id, state.workspace);
      state.profile = state.workspace.profile;
      if (options.accountName) Store.updateAccountName(state.user.id, options.accountName);
    } catch (error) {
      state.workspace = JSON.parse(snapshot);
      state.profile = state.workspace.profile;
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* لوحة التحكم                                                         */
  /* ------------------------------------------------------------------ */

  function renderDashboard(page) {
    const items = collectAllItems();
    const recent = items
      .slice()
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 5);
    const completion = profileCompletion();
    const storage = getStorageInfo();
    const attachments = countAttachments();
    const totalItems = items.length;
    const activity = (state.workspace.activity || []).slice(0, 5);
    const photo = getProfilePhoto();
    const profile = state.profile || {};

    const subtitle = totalItems === 0
      ? 'مساحتك جاهزة. ابدأ بتوثيق أول إنجاز، ثم أضف الشواهد التي تدعمه ليبقى أثرك محفوظًا.'
      : completion.percent < 100
        ? `لديك ${totalItems} ${totalItems === 1 ? 'عنصرًا موثقًا' : 'عناصر موثقة'} في ملفك. أكمل بياناتك المهنية لتظهر صورتك بأكملها.`
        : `ملفك مكتمل ويضم ${totalItems} ${totalItems === 1 ? 'عنصرًا' : 'عناصر'} موثقة. استمر في إضافة أثر جديد كلما حققته.`;

    const statCards = [
      { section: 'achievements', label: 'إنجازاتي', hint: 'إنجاز موثّق', iconName: 'award', tone: 'green' },
      { section: 'evidence', label: 'شواهدي', hint: 'شاهد محفوظ', iconName: 'archive', tone: 'blue' },
      { section: 'reports', label: 'تقاريري', hint: 'تقرير منظّم', iconName: 'file-text', tone: 'teal' },
      { section: 'attachments', label: 'المرفقات', hint: 'ملف أو صورة', iconName: 'paperclip', tone: 'slate' },
    ];

    page.innerHTML = `
      <div class="dash-top">
        <section class="welcome-panel">
          <div class="welcome-panel-grid"></div>
          <div class="welcome-arch"></div>
          <span class="welcome-date"><span class="dot"></span>${escapeHtml(formatLongToday())}</span>
          <h1>${escapeHtml(greetingWord())}، <span class="highlight">${escapeHtml(firstName())}</span></h1>
          <p class="welcome-subtitle">${escapeHtml(subtitle)}</p>
          <div class="welcome-actions">
            <button class="btn light" type="button" data-create-item="achievements">${icon('plus')} إضافة إنجاز</button>
            <button class="btn glass" type="button" data-create-item="evidence">${icon('archive')} إضافة شاهد</button>
            <button class="btn glass" type="button" data-route="profile">${icon('user')} تحديث ملفي</button>
          </div>
        </section>
        <aside class="completion-panel" aria-label="اكتمال الملف المهني">
          <div class="completion-panel-head">
            <div>
              <h2>اكتمال الملف المهني</h2>
              <p>${completion.percent === 100 ? 'ملفك جاهز ومكتمل' : `متبقٍ ${completion.missing.length} عناصر لإكمال ملفك`}</p>
            </div>
            ${avatarMarkup(profile.fullName || state.user?.name, photo)}
          </div>
          <div class="completion-body">
            <div class="completion-ring" style="--progress:${completion.percent}">
              <div class="completion-ring-text"><strong>${completion.percent}%</strong><span>مكتمل</span></div>
            </div>
            <div class="completion-info">
              <strong>${completion.completed} من ${completion.total} عناصر</strong>
              <p>${completion.percent === 100 ? 'ممتاز! جميع عناصر ملفك المهني مكتملة.' : 'أكمل التفاصيل البسيطة ليصبح ملفك أكثر احترافية.'}</p>
              <div class="completion-missing">
                ${completion.missing.slice(0, 3).map((item) => `<span class="tag">${escapeHtml(item.missing)}</span>`).join('')}
              </div>
            </div>
          </div>
          <button class="btn soft" type="button" data-route="profile">${icon('edit')} ${completion.percent === 100 ? 'عرض الملف المهني' : 'إكمال الملف'}</button>
        </aside>
      </div>

      <div class="stats-grid">
        ${statCards.map((stat) => {
          const value = stat.section === 'attachments' ? attachments : countSection(stat.section);
          return `
            <button class="stat-card" type="button" ${stat.section === 'attachments' ? 'data-route="evidence"' : `data-route="${stat.section}"`}>
              <span class="stat-top">
                <span class="stat-icon ${stat.tone}">${icon(stat.iconName)}</span>
                <span class="stat-arrow">${icon('chevron-left')}</span>
              </span>
              <span class="stat-value">${value}<span>${stat.section === 'attachments' ? 'ملف' : 'عنصر'}</span></span>
              <span class="stat-label">${escapeHtml(stat.label)}</span>
              <span class="stat-hint">${escapeHtml(stat.hint)}</span>
            </button>
          `;
        }).join('')}
      </div>

      <div class="dash-lower">
        <section class="content-panel" aria-labelledby="recent-title">
          <div class="panel-head">
            <h2 id="recent-title">${icon('clock')} أحدث المحتوى</h2>
            ${recent.length ? `<button class="link-btn" type="button" data-route="achievements">عرض إنجازاتي ${icon('chevron-left')}</button>` : ''}
          </div>
          ${recent.length ? `
            <div class="recent-list">
              ${recent.map((item) => {
                const meta = SECTIONS[item.section];
                return `
                  <button class="recent-row" type="button" data-view-item data-section="${item.section}" data-id="${escapeAttr(item.id)}">
                    <span class="recent-icon ${item.section}">${icon(meta.icon)}</span>
                    <span class="recent-main">
                      <strong>${escapeHtml(item.title || 'بدون عنوان')}</strong>
                      <span>${escapeHtml(meta.title)} <span class="dot"></span> ${escapeHtml(item.category || 'غير مصنّف')} <span class="dot"></span> ${escapeHtml(relativeTime(item.updatedAt))}</span>
                    </span>
                    ${icon('chevron-left')}
                  </button>
                `;
              }).join('')}
            </div>
          ` : `
            <div class="panel-empty">
              <div class="empty-visual">${icon('sparkles')}</div>
              <h3>ملفك في انتظار أول أثر</h3>
              <p>ابدأ بإضافة إنجاز واحد، ثم أرفق الشاهد الذي يوثّقه. ستجد كل شيء هنا بعد ذلك.</p>
              <button class="btn primary sm" type="button" data-create-item="achievements">${icon('plus')} إضافة أول إنجاز</button>
            </div>
          `}
        </section>

        ${activity.length ? `
          <section class="content-panel" aria-labelledby="activity-title">
            <div class="panel-head">
              <h2 id="activity-title">${icon('refresh')} نشاطك الأخير</h2>
            </div>
            <div class="timeline">
              ${activity.map((entry) => {
                const tone = entry.section === 'evidence' ? 'blue' : entry.section === 'reports' ? 'amber' : '';
                return `
                  <div class="timeline-item">
                    <span class="timeline-dot ${tone}"></span>
                    <div class="timeline-text">
                      <strong>${escapeHtml(activityLabel(entry))}</strong>
                      <time>${escapeHtml(relativeTime(entry.at))}</time>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </section>
        ` : `
          <section class="onboarding-card" aria-labelledby="onboarding-title">
            <h2 id="onboarding-title">${icon('sparkles')} ابدأ بثلاث خطوات</h2>
            <p>ثلاث خطوات بسيطة تفصلك عن ملف إنجاز متكامل.</p>
            <div class="onboarding-steps">
              <button class="onboarding-step" type="button" data-route="profile">
                <span class="onboarding-step-num">1</span>
                <span>أكمل ملفك المهني</span>
                ${icon('chevron-left')}
              </button>
              <button class="onboarding-step" type="button" data-create-item="achievements">
                <span class="onboarding-step-num">2</span>
                <span>أضف أول إنجاز</span>
                ${icon('chevron-left')}
              </button>
              <button class="onboarding-step" type="button" data-create-item="evidence">
                <span class="onboarding-step-num">3</span>
                <span>أرفق شاهدًا يدعمه</span>
                ${icon('chevron-left')}
              </button>
            </div>
            <div class="profile-inline-progress">
              <span class="storage-track"><span style="width:${storage.percent}%"></span></span>
              <strong>${storage.percent}% مستخدم</strong>
            </div>
          </section>
        `}
      </div>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* صفحات المحتوى                                                       */
  /* ------------------------------------------------------------------ */

  function defaultFilter() {
    return { q: '', category: '', status: '', type: '', sort: 'recent' };
  }

  function getFilter(section) {
    if (!state.filters[section]) state.filters[section] = defaultFilter();
    return state.filters[section];
  }

  function categoryCounts(section) {
    const map = new Map();
    (state.workspace?.[section] || []).forEach((item) => {
      const category = String(item.category || '').trim();
      if (!category) return;
      map.set(category, (map.get(category) || 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ar'));
  }

  function itemSearchText(item) {
    const meta = SECTIONS[item.section] || {};
    let linkedTitle = '';
    if (item.section === 'evidence' && item.linkedAchievementId) {
      const linked = findItem('achievements', item.linkedAchievementId);
      linkedTitle = linked?.title || '';
    }
    return normalizeArabic([
      item.title,
      item.description,
      item.category,
      item.link,
      item.content,
      item.impact,
      (item.tags || []).join(' '),
      (item.attachments || []).map((file) => file.name).join(' '),
      linkedTitle,
      meta.title,
      EVIDENCE_TYPES[item.evidenceType]?.label,
      REPORT_STATUSES[item.status]?.label,
    ].filter(Boolean).join(' '));
  }

  function filterItems(section, filter) {
    const query = normalizeArabic(filter.q || '');
    let items = (state.workspace?.[section] || []).slice();
    if (query) items = items.filter((item) => itemSearchText({ ...item, section }).includes(query));
    if (filter.category) items = items.filter((item) => String(item.category || '') === filter.category);
    if (section === 'reports' && filter.status) items = items.filter((item) => String(item.status || '') === filter.status);
    if (section === 'evidence' && filter.type) items = items.filter((item) => String(item.evidenceType || '') === filter.type);
    const sort = filter.sort || 'recent';
    items.sort((a, b) => {
      if (sort === 'oldest') return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
      if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'ar');
      if (sort === 'date') {
        return String(b.date || b.updatedAt || '').localeCompare(String(a.date || a.updatedAt || ''));
      }
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    return items;
  }

  function reportStatusMarkup(status) {
    const meta = REPORT_STATUSES[status] || REPORT_STATUSES.draft;
    return `<span class="status-chip ${escapeAttr(status || 'draft')}"><span class="dot"></span>${escapeHtml(meta.label)}</span>`;
  }

  function itemCardMarkup(item) {
    const section = item.section;
    const meta = SECTIONS[section];
    const image = (item.attachments || []).find((file) => file && /^image\//.test(file.type || ''));
    const description = String(item.description || '').trim();
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean).slice(0, 3) : [];
    const attachmentCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
    const hasLink = Boolean(makeUrl(item.link));
    const typeMeta = section === 'evidence' ? EVIDENCE_TYPES[item.evidenceType] : null;
    return `
      <article class="content-card section-${section}" data-card-id="${escapeAttr(item.id)}">
        ${section === 'evidence' && image ? `
          <button class="evidence-cover" type="button" data-view-item data-section="${section}" data-id="${escapeAttr(item.id)}" aria-label="معاينة ${escapeAttr(item.title || 'الشاهد')}">
            <img src="${escapeAttr(image.dataUrl)}" alt="" loading="lazy">
            ${attachmentCount > 1 ? `<span class="image-count">${icon('image')} ${attachmentCount}</span>` : ''}
          </button>
        ` : ''}
        <div class="content-card-body">
          <div class="content-card-top">
            <div class="card-badges">
              <span class="section-chip ${meta.color === 'blue' ? 'blue' : ''}">${icon(meta.icon)} ${escapeHtml(meta.title)}</span>
              ${item.category ? `<span class="tag">${escapeHtml(item.category)}</span>` : ''}
              ${section === 'reports' ? reportStatusMarkup(item.status) : ''}
              ${typeMeta ? `<span class="tag ${item.evidenceType === 'link' ? 'blue' : ''}">${icon(typeMeta.icon)} ${escapeHtml(typeMeta.label)}</span>` : ''}
            </div>
            <div class="card-menu">
              <button class="icon-btn" type="button" data-view-item data-section="${section}" data-id="${escapeAttr(item.id)}" aria-label="عرض" title="عرض">${icon('eye')}</button>
              <button class="icon-btn" type="button" data-edit-item data-section="${section}" data-id="${escapeAttr(item.id)}" aria-label="تعديل" title="تعديل">${icon('edit')}</button>
              <button class="icon-btn delete" type="button" data-delete-item data-section="${section}" data-id="${escapeAttr(item.id)}" aria-label="حذف" title="حذف">${icon('trash')}</button>
            </div>
          </div>
          <h3 class="content-title">
            <button type="button" data-view-item data-section="${section}" data-id="${escapeAttr(item.id)}">${escapeHtml(item.title || 'بدون عنوان')}</button>
          </h3>
          <p class="content-description ${description ? '' : 'is-empty'}">${escapeHtml(description || 'لا يوجد وصف مضاف لهذا العنصر.')}</p>
          ${tags.length ? `<div class="content-tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          <div class="content-meta">
            ${item.date ? `<span>${icon('calendar')} ${escapeHtml(formatDate(item.date, { short: true }))}</span>` : ''}
            ${attachmentCount ? `<span>${icon('paperclip')} ${attachmentCount} مرفق</span>` : ''}
            ${hasLink ? `<span>${icon('link')} رابط</span>` : ''}
            <span class="meta-end">${escapeHtml(relativeTime(item.updatedAt))}</span>
          </div>
        </div>
      </article>
    `;
  }

  function filteredCountMarkup(count, total, filter) {
    const hasFilter = Boolean(filter.q || filter.category || filter.status || filter.type);
    if (hasFilter) {
      return `${icon('filter')} <strong>${count}</strong> من ${total} عنصر`;
    }
    return `${icon('archive')} <strong>${count}</strong> ${count === 1 ? 'عنصر' : 'عناصر'}`;
  }

  function sectionResultsMarkup(section, filter) {
    const total = countSection(section);
    const filtered = filterItems(section, filter);
    if (total === 0) {
      return {
        summary: filteredCountMarkup(0, 0, filter),
        html: `
          <div class="filter-empty grid-empty">
            <div class="empty-visual">${icon(SECTIONS[section].icon)}</div>
            <h3>لا يوجد محتوى في ${escapeHtml(SECTIONS[section].title)} بعد</h3>
            <p>${escapeHtml(SECTIONS[section].description)}</p>
            <button class="btn primary" type="button" data-create-item="${section}">${icon('plus')} ${escapeHtml(SECTIONS[section].addLabel)}</button>
          </div>
        `,
      };
    }
    if (!filtered.length) {
      return {
        summary: filteredCountMarkup(0, total, filter),
        html: `
          <div class="filter-empty grid-empty">
            ${icon('search')}
            <h3>لا توجد نتائج مطابقة</h3>
            <p>جرّب كلمة بحث أخرى أو أزل عوامل التصفية للعودة إلى كل المحتوى.</p>
            <button class="btn" type="button" data-clear-filter="${section}">${icon('refresh')} إزالة التصفية</button>
          </div>
        `,
      };
    }
    return {
      summary: filteredCountMarkup(filtered.length, total, filter),
      html: filtered.map((item) => itemCardMarkup(item)).join(''),
    };
  }

  function renderSectionPage(page, section) {
    const meta = SECTIONS[section];
    const filter = getFilter(section);
    const total = countSection(section);
    const categories = categoryCounts(section);
    const results = sectionResultsMarkup(section, filter);

    page.innerHTML = `
      <div class="page-heading">
        <div class="page-heading-main">
          <span class="page-eyebrow">${icon(meta.icon)} محتواي</span>
          <h1 class="page-title">${escapeHtml(meta.title)} <span class="count">${total}</span></h1>
          <p class="page-description">${escapeHtml(meta.description)}</p>
        </div>
        <div class="page-heading-actions">
          <button class="btn primary" type="button" data-create-item="${section}">${icon('plus')} ${escapeHtml(meta.addLabel)}</button>
        </div>
      </div>

      <div class="filter-bar">
        <label class="filter-search" for="section-search">
          ${icon('search')}
          <input type="search" id="section-search" value="${escapeAttr(filter.q)}" placeholder="${escapeAttr(meta.searchPlaceholder)}" autocomplete="off">
          <button class="clear-search" type="button" data-clear-search aria-label="مسح البحث" ${filter.q ? '' : 'hidden'}>${icon('x')}</button>
        </label>
        ${categories.length ? `
          <label class="filter-select" aria-label="تصفية حسب التصنيف">
            <select id="section-category">
              <option value="">كل التصنيفات</option>
              ${categories.map(([category, count]) => `<option value="${escapeAttr(category)}" ${filter.category === category ? 'selected' : ''}>${escapeHtml(category)} (${count})</option>`).join('')}
            </select>
            ${icon('tag')}
          </label>
        ` : ''}
        ${section === 'reports' ? `
          <label class="filter-select" aria-label="تصفية حسب الحالة">
            <select id="section-status">
              <option value="">كل الحالات</option>
              ${Object.entries(REPORT_STATUSES).map(([value, status]) => `<option value="${value}" ${filter.status === value ? 'selected' : ''}>${escapeHtml(status.label)}</option>`).join('')}
            </select>
            ${icon('filter')}
          </label>
        ` : ''}
        ${section === 'evidence' ? `
          <label class="filter-select" aria-label="تصفية حسب نوع الشاهد">
            <select id="section-type">
              <option value="">كل الأنواع</option>
              ${Object.entries(EVIDENCE_TYPES).map(([value, type]) => `<option value="${value}" ${filter.type === value ? 'selected' : ''}>${escapeHtml(type.label)}</option>`).join('')}
            </select>
            ${icon('archive')}
          </label>
        ` : ''}
        <label class="filter-select" aria-label="ترتيب النتائج">
          <select id="section-sort">
            <option value="recent" ${filter.sort === 'recent' ? 'selected' : ''}>الأحدث تحديثًا</option>
            <option value="oldest" ${filter.sort === 'oldest' ? 'selected' : ''}>الأقدم تحديثًا</option>
            <option value="date" ${filter.sort === 'date' ? 'selected' : ''}>حسب التاريخ</option>
            <option value="title" ${filter.sort === 'title' ? 'selected' : ''}>أبجديًا</option>
          </select>
          ${icon('chevron-down')}
        </label>
      </div>

      <div class="filter-count" id="section-filter-count">${results.summary}</div>
      <div class="section-grid" id="section-results">${results.html}</div>
    `;

    const searchInput = $('#section-search', page);
    const clearSearch = $('[data-clear-search]', page);
    const categorySelect = $('#section-category', page);
    const statusSelect = $('#section-status', page);
    const typeSelect = $('#section-type', page);
    const sortSelect = $('#section-sort', page);

    function refreshResults() {
      const current = getFilter(section);
      const outcome = sectionResultsMarkup(section, current);
      const resultsContainer = $('#section-results', page);
      const countContainer = $('#section-filter-count', page);
      if (resultsContainer) resultsContainer.innerHTML = outcome.html;
      if (countContainer) countContainer.innerHTML = outcome.summary;
      if (clearSearch) clearSearch.hidden = !current.q;
    }

    if (searchInput) {
      const onSearch = debounce(() => {
        getFilter(section).q = searchInput.value.trim();
        refreshResults();
      }, 180);
      searchInput.addEventListener('input', onSearch);
    }
    if (clearSearch) {
      clearSearch.addEventListener('click', () => {
        if (!searchInput) return;
        searchInput.value = '';
        getFilter(section).q = '';
        refreshResults();
        searchInput.focus();
      });
    }
    if (categorySelect) {
      categorySelect.addEventListener('change', () => {
        getFilter(section).category = categorySelect.value;
        refreshResults();
      });
    }
    if (statusSelect) {
      statusSelect.addEventListener('change', () => {
        getFilter(section).status = statusSelect.value;
        refreshResults();
      });
    }
    if (typeSelect) {
      typeSelect.addEventListener('change', () => {
        getFilter(section).type = typeSelect.value;
        refreshResults();
      });
    }
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        getFilter(section).sort = sortSelect.value;
        refreshResults();
      });
    }

    const clearFilterButton = $('[data-clear-filter]', page);
    if (clearFilterButton) {
      clearFilterButton.addEventListener('click', () => {
        state.filters[section] = defaultFilter();
        renderSectionPage(page, section);
      });
    }

    refreshResults();
  }

  /* ------------------------------------------------------------------ */
  /* أدوات العناصر والمرفقات                                             */
  /* ------------------------------------------------------------------ */

  function findItem(section, id) {
    return (state.workspace?.[section] || []).find((item) => item.id === id) || null;
  }

  function findAnyItem(section, id) {
    if (SECTIONS[section]) return findItem(section, id);
    for (const key of Object.keys(SECTIONS)) {
      const found = findItem(key, id);
      if (found) return { ...found, section: key };
    }
    return null;
  }

  function parseTags(value) {
    return Array.from(new Set(String(value || '')
      .split(/[,،]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => tag.slice(0, 28))))
      .slice(0, 10);
  }

  function attachmentIcon(type, name) {
    const mime = String(type || '');
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (/^image\//.test(mime)) return 'image';
    if (mime === 'application/pdf' || ext === 'pdf') return 'file-text';
    if (/zip|rar|7z/.test(mime) || ['zip', 'rar', '7z'].includes(ext)) return 'archive';
    return 'file-text';
  }

  function base64Size(dataUrl) {
    const raw = String(dataUrl || '');
    const comma = raw.indexOf(',');
    if (comma === -1) return 0;
    const body = raw.slice(comma + 1);
    return Math.round((body.length * 3) / 4);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('تعذّر قراءة الملف. حاول مرة أخرى.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('تعذّر معالجة الصورة.'));
      image.src = dataUrl;
    });
  }

  async function compressImage(dataUrl, maxDimension = 1600, quality = 0.82) {
    try {
      const image = await loadImage(dataUrl);
      let { width, height } = image;
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return dataUrl;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const compressed = canvas.toDataURL('image/jpeg', quality);
      return compressed.length < dataUrl.length ? compressed : dataUrl;
    } catch {
      return dataUrl;
    }
  }

  function blockedFileType(file) {
    const name = String(file.name || '');
    const extension = name.split('.').pop().toLowerCase();
    const blocked = ['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'mjs', 'html', 'htm', 'svg', 'php'];
    return blocked.includes(extension);
  }

  async function prepareAttachment(file) {
    if (!file) throw new Error('لم يتم اختيار ملف.');
    if (blockedFileType(file)) {
      throw new Error('هذا النوع من الملفات غير مدعوم لأسباب أمنية.');
    }
    const isImage = /^image\/(jpeg|png|webp|gif)$/i.test(file.type);
    const isLargeImage = /^image\//i.test(file.type) && file.size > MAX_FILE_SIZE;
    if (!isImage && file.size > MAX_FILE_SIZE) {
      throw new Error(`حجم الملف أكبر من الحد المسموح (${formatBytes(MAX_FILE_SIZE)}).`);
    }
    if (isLargeImage && !/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      throw new Error('هذه الصورة كبيرة جدًا. استخدم صورة أصغر أو صيغة JPG أو PNG أو WebP.');
    }
    if (isLargeImage && file.size > MAX_IMAGE_SOURCE_SIZE) {
      throw new Error('حجم الصورة الأصلي كبير جدًا. اختر صورة بحجم أقل من 8 م.ب.');
    }
    if (file.size > MAX_IMAGE_SOURCE_SIZE) {
      throw new Error('حجم الملف أكبر من الحد المسموح.');
    }

    let dataUrl = await readFileAsDataUrl(file);
    let outputType = file.type || 'application/octet-stream';
    let outputName = file.name || 'ملف مرفق';

    if (/^image\/(jpeg|png|webp)$/i.test(file.type) && file.size > 420 * 1024) {
      const compressed = await compressImage(dataUrl);
      if (compressed !== dataUrl) {
        dataUrl = compressed;
        outputType = 'image/jpeg';
        outputName = `${String(file.name || 'image').replace(/\.[^.]+$/, '')}.jpg`;
      }
    }

    const size = base64Size(dataUrl);
    if (size > MAX_FILE_SIZE) {
      throw new Error(`الملف النهائي أكبر من ${formatBytes(MAX_FILE_SIZE)} بعد المعالجة.`);
    }
    return {
      id: uid(),
      name: outputName.slice(0, 180),
      type: outputType,
      size,
      dataUrl,
      createdAt: new Date().toISOString(),
    };
  }

  function draftAttachmentMarkup(attachment) {
    const isImage = /^image\//.test(attachment.type || '');
    return `
      <div class="attachment-draft" data-attachment-id="${escapeAttr(attachment.id)}">
        <span class="attachment-draft-thumb">
          ${isImage && /^data:image\//.test(attachment.dataUrl) ? `<img src="${escapeAttr(attachment.dataUrl)}" alt="">` : icon(attachmentIcon(attachment.type, attachment.name))}
        </span>
        <span class="attachment-draft-info">
          <strong title="${escapeAttr(attachment.name)}">${escapeHtml(attachment.name)}</strong>
          <span>${escapeHtml(formatBytes(attachment.size))}${isImage ? ' · صورة' : ''}</span>
        </span>
        <button class="attachment-remove" type="button" data-remove-attachment="${escapeAttr(attachment.id)}" aria-label="حذف المرفق" title="حذف المرفق">${icon('x')}</button>
      </div>
    `;
  }

  function draftAttachmentListMarkup(attachments) {
    if (!attachments.length) return `<div class="attachment-empty">لم تُضف أي مرفقات بعد. المرفقات اختيارية.</div>`;
    return attachments.map((attachment) => draftAttachmentMarkup(attachment)).join('');
  }

  function attachmentCardMarkup(attachment) {
    const isImage = /^image\//.test(attachment.type || '') && /^data:image\//.test(attachment.dataUrl || '');
    return `
      <div class="attachment-card">
        ${isImage
          ? `<button class="attachment-preview" type="button" data-open-image="${escapeAttr(attachment.id)}" aria-label="معاينة ${escapeAttr(attachment.name)}"><img src="${escapeAttr(attachment.dataUrl)}" alt="${escapeAttr(attachment.name)}" loading="lazy"></button>`
          : `<div class="attachment-preview">${icon(attachmentIcon(attachment.type, attachment.name))}</div>`}
        <div class="attachment-info">
          <div>
            <strong title="${escapeAttr(attachment.name)}">${escapeHtml(attachment.name)}</strong>
            <span>${escapeHtml(formatBytes(attachment.size))}</span>
          </div>
          <a class="attachment-download" href="${escapeAttr(attachment.dataUrl)}" download="${escapeAttr(attachment.name)}" aria-label="تنزيل ${escapeAttr(attachment.name)}" title="تنزيل">${icon('download')}</a>
        </div>
      </div>
    `;
  }

  function sortAttachments(attachments) {
    return attachments.filter((file) => file && file.dataUrl).map((file) => ({
      id: file.id || uid(),
      name: String(file.name || 'ملف مرفق').slice(0, 200),
      type: String(file.type || 'application/octet-stream'),
      size: Number(file.size || base64Size(file.dataUrl)),
      dataUrl: file.dataUrl,
      createdAt: file.createdAt || new Date().toISOString(),
    }));
  }

  /* ------------------------------------------------------------------ */
  /* عرض عنصر                                                        */
  /* ------------------------------------------------------------------ */

  function openItemDetail(section, id) {
    const item = findItem(section, id);
    if (!item) {
      toast('لم يعد هذا العنصر موجودًا.', 'error');
      return;
    }
    const meta = SECTIONS[section];
    const linked = section === 'evidence' && item.linkedAchievementId
      ? findItem('achievements', item.linkedAchievementId)
      : null;
    const typeMeta = section === 'evidence' ? EVIDENCE_TYPES[item.evidenceType] : null;
    const safeLink = makeUrl(item.link);
    const attachments = sortAttachments(item.attachments || []);
    const subtitleParts = [meta.title, item.category, item.date ? formatDate(item.date) : ''].filter(Boolean);

    const { backdrop, close } = openModal({
      title: item.title || 'بدون عنوان',
      subtitle: subtitleParts.join(' · '),
      kicker: meta.title,
      kickerIcon: meta.icon,
      size: 'lg',
      body: `
        <div class="detail-meta-row">
          ${item.category ? `<span class="tag">${escapeHtml(item.category)}</span>` : ''}
          ${section === 'reports' ? reportStatusMarkup(item.status) : ''}
          ${typeMeta ? `<span class="tag ${item.evidenceType === 'link' ? 'blue' : ''}">${icon(typeMeta.icon)} ${escapeHtml(typeMeta.label)}</span>` : ''}
          ${item.date ? `<span class="detail-date" style="margin:0">${icon('calendar')} ${escapeHtml(formatDate(item.date))}</span>` : ''}
        </div>
        ${String(item.description || '').trim()
          ? `<p class="detail-description">${escapeHtml(item.description)}</p>`
          : `<p class="detail-description muted">لا يوجد وصف مضاف لهذا العنصر.</p>`}
        ${section === 'reports' && String(item.content || '').trim() ? `
          <div class="detail-block">
            <h3>${icon('book-open')} محتوى التقرير</h3>
            <div class="detail-rich"><p>${escapeHtml(item.content)}</p></div>
          </div>
        ` : ''}
        ${String(item.impact || '').trim() ? `
          <div class="detail-block">
            <h3>${icon('chart')} ${section === 'reports' ? 'أبرز النتائج والتوصيات' : 'الأثر والملاحظات'}</h3>
            <p>${escapeHtml(item.impact)}</p>
          </div>
        ` : ''}
        ${safeLink ? `
          <div class="detail-block">
            <h3>${icon('link')} الرابط المرجعي</h3>
            <a class="detail-link" href="${escapeAttr(safeLink)}" target="_blank" rel="noopener noreferrer">${icon('external')}<span>${escapeHtml(urlLabel(safeLink))}</span></a>
          </div>
        ` : ''}
        ${linked ? `
          <div class="detail-block">
            <h3>${icon('award')} الإنجاز المرتبط</h3>
            <button class="linked-achievement" type="button" data-open-linked-achievement="${escapeAttr(linked.id)}">${icon('award')} ${escapeHtml(linked.title || 'إنجاز مرتبط')}</button>
          </div>
        ` : ''}
        ${(item.tags || []).length ? `<div class="detail-tags">${item.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        ${attachments.length ? `
          <div class="detail-block">
            <h3>${icon('paperclip')} المرفقات <span class="muted">(${attachments.length})</span></h3>
            <div class="detail-attachments">
              ${attachments.map((attachment) => attachmentCardMarkup(attachment)).join('')}
            </div>
          </div>
        ` : ''}
        <div class="detail-footer-actions">
          <button class="btn sm primary" type="button" data-detail-edit>${icon('edit')} تعديل</button>
          <button class="btn sm danger" type="button" data-detail-delete>${icon('trash')} حذف</button>
          <span class="spacer"></span>
          <span class="muted tiny">آخر تحديث ${escapeHtml(formatDateTime(item.updatedAt))}</span>
        </div>
      `,
      onMount: ({ backdrop: dialog }) => {
        $('[data-detail-edit]', dialog).addEventListener('click', () => {
          close(false);
          setTimeout(() => openItemForm(section, item), 60);
        });
        $('[data-detail-delete]', dialog).addEventListener('click', () => {
          close(false);
          setTimeout(() => deleteItem(section, item.id), 60);
        });
        $$('[data-open-image]', dialog).forEach((button) => {
          button.addEventListener('click', () => {
            const attachment = attachments.find((file) => file.id === button.dataset.openImage);
            if (attachment) openLightbox(attachment.dataUrl, attachment.name);
          });
        });
        const linkedButton = $('[data-open-linked-achievement]', dialog);
        if (linkedButton) {
          linkedButton.addEventListener('click', () => {
            close(false);
            setTimeout(() => openItemDetail('achievements', linkedButton.dataset.openLinkedAchievement), 60);
          });
        }
      },
    });
    void backdrop;
  }

  function deleteItem(section, id) {
    const item = findItem(section, id);
    if (!item) {
      toast('لم يعد هذا العنصر موجودًا.', 'error');
      return;
    }
    const meta = SECTIONS[section];
    confirmDialog({
      title: `حذف ${meta.singular}؟`,
      message: `سيتم حذف «${item.title || 'بدون عنوان'}» ومرفقاته نهائيًا من مساحتك. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'حذف نهائي',
      iconName: 'trash',
    }).then((confirmed) => {
      if (!confirmed) return;
      try {
        commitWorkspace((workspace) => {
          workspace[section] = (workspace[section] || []).filter((entry) => entry.id !== id);
          if (section === 'achievements') {
            (workspace.evidence || []).forEach((evidence) => {
              if (evidence.linkedAchievementId === id) evidence.linkedAchievementId = '';
            });
          }
        }, { activity: { kind: 'deleted', section, title: item.title || '' } });
        toast(`تم حذف ${meta.singular} من مساحتك.`, 'success');
        renderRoute();
      } catch (error) {
        toast(error.message || 'تعذّر حذف العنصر.', 'error');
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* نموذج إضافة / تعديل العنصر                                          */
  /* ------------------------------------------------------------------ */

  function itemFormFieldMarkup(section, item, categories, achievements) {
    const meta = SECTIONS[section];
    const isReport = section === 'reports';
    const isEvidence = section === 'evidence';
    return `
      <form id="item-form" novalidate>
        <div class="form-grid">
          <div class="form-field span-2">
            <label for="item-title">العنوان <span class="muted">*</span></label>
            <input id="item-title" name="title" type="text" maxlength="160" value="${escapeAttr(item.title || '')}" placeholder="${section === 'achievements' ? 'مثال: قيادة مبادرة تطوير مهارات الطالبات' : section === 'evidence' ? 'مثال: شهادة حضور ورشة العمل' : 'مثال: تقرير إنجاز الفصل الأول'}" required autofocus>
          </div>
          <div class="form-field">
            <label for="item-category">التصنيف</label>
            <input id="item-category" name="category" type="text" maxlength="60" value="${escapeAttr(item.category || '')}" placeholder="مثال: التطوير المهني" list="category-options">
            <datalist id="category-options">
              ${categories.map(([category]) => `<option value="${escapeAttr(category)}"></option>`).join('')}
            </datalist>
          </div>
          <div class="form-field">
            <label for="item-date">${escapeHtml(meta.dateLabel)}</label>
            <input id="item-date" name="date" type="date" value="${escapeAttr(item.date || todayISO())}">
          </div>

          ${isReport ? `
            <div class="form-field">
              <label for="item-status">حالة التقرير</label>
              <div class="select-wrap">
                <select id="item-status" name="status">
                  ${Object.entries(REPORT_STATUSES).map(([value, status]) => `<option value="${value}" ${String(item.status || 'draft') === value ? 'selected' : ''}>${escapeHtml(status.label)}</option>`).join('')}
                </select>
                ${icon('chevron-down')}
              </div>
            </div>
            <div class="form-field">
              <label for="item-tags">الوسوم</label>
              <input id="item-tags" name="tags" type="text" value="${escapeAttr((item.tags || []).join('، '))}" placeholder="تطوير، قياس، أثر">
              <span class="field-hint">افصل بين الوسوم بفاصلة.</span>
            </div>
          ` : isEvidence ? `
            <div class="form-field">
              <label for="item-evidence-type">نوع الشاهد</label>
              <div class="select-wrap">
                <select id="item-evidence-type" name="evidenceType">
                  ${Object.entries(EVIDENCE_TYPES).map(([value, type]) => `<option value="${value}" ${String(item.evidenceType || 'document') === value ? 'selected' : ''}>${escapeHtml(type.label)}</option>`).join('')}
                </select>
                ${icon('chevron-down')}
              </div>
            </div>
            <div class="form-field">
              <label for="item-tags">الوسوم</label>
              <input id="item-tags" name="tags" type="text" value="${escapeAttr((item.tags || []).join('، '))}" placeholder="شهادة، ورشة، مشاركة">
              <span class="field-hint">افصل بين الوسوم بفاصلة.</span>
            </div>
            <div class="form-field span-2">
              <label for="item-linked">الإنجاز المرتبط <span class="optional">(اختياري)</span></label>
              <div class="select-wrap">
                <select id="item-linked" name="linkedAchievementId">
                  <option value="">بدون ارتباط بإنجاز محدد</option>
                  ${achievements.map((achievement) => `<option value="${escapeAttr(achievement.id)}" ${item.linkedAchievementId === achievement.id ? 'selected' : ''}>${escapeHtml(achievement.title || 'بدون عنوان')}</option>`).join('')}
                </select>
                ${icon('chevron-down')}
              </div>
            </div>
          ` : `
            <div class="form-field">
              <label for="item-tags">الوسوم</label>
              <input id="item-tags" name="tags" type="text" value="${escapeAttr((item.tags || []).join('، '))}" placeholder="قيادة، مبادرة، تطوير">
              <span class="field-hint">افصل بين الوسوم بفاصلة.</span>
            </div>
          `}

          <div class="form-field span-2">
            <label for="item-description">الوصف المختصر</label>
            <textarea id="item-description" name="description" maxlength="2000" placeholder="اكتب وصفًا موجزًا يوضح طبيعة هذا المحتوى وسياقه..." rows="3">${escapeHtml(item.description || '')}</textarea>
          </div>

          ${isReport ? `
            <div class="form-field span-2">
              <label for="item-content">محتوى التقرير</label>
              <textarea id="item-content" name="content" maxlength="12000" placeholder="اكتب ملخص التقرير، المنهجية، النتائج، أو أي تفاصيل تريد حفظها..." style="min-height:160px" rows="7">${escapeHtml(item.content || '')}</textarea>
            </div>
            <div class="form-field span-2">
              <label for="item-impact">أبرز النتائج والتوصيات <span class="optional">(اختياري)</span></label>
              <textarea id="item-impact" name="impact" maxlength="3000" placeholder="ما أهم ما خرجت به من هذا التقرير؟" rows="3">${escapeHtml(item.impact || '')}</textarea>
            </div>
          ` : `
            <div class="form-field span-2">
              <label for="item-impact">الأثر والملاحظات <span class="optional">(اختياري)</span></label>
              <textarea id="item-impact" name="impact" maxlength="3000" placeholder="${section === 'achievements' ? 'صف الأثر الذي حققته، والنتائج القابلة للقياس...' : 'أضف أي ملاحظات أو تفاصيل تدعم هذا الشاهد...'}" rows="3">${escapeHtml(item.impact || '')}</textarea>
            </div>
          `}

          <div class="form-separator">المرفقات والروابط</div>

          <div class="form-field span-2">
            <label for="item-link">رابط مرجعي <span class="optional">(اختياري)</span></label>
            <div class="input-wrap">
              ${icon('link')}
              <input id="item-link" name="link" type="url" value="${escapeAttr(item.link || '')}" placeholder="https://example.com" dir="ltr">
            </div>
            <span class="field-hint">${icon('external')} يُفتح الرابط في نافذة جديدة عند العرض.</span>
          </div>

          <div class="form-field span-2">
            <span class="field-label">المرفقات <span class="optional">(صور أو مستندات)</span></span>
            <div class="upload-zone" id="upload-zone" role="button" tabindex="0" aria-label="إرفاق ملفات">
              <input id="item-files" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar">
              <div class="upload-icon">${icon('upload')}</div>
              <strong>اسحب الملفات هنا أو اضغط للاختيار</strong>
              <span>صور JPG وPNG وWebP • مستندات PDF وWord وExcel • حتى ${formatBytes(MAX_FILE_SIZE)} للملف</span>
              <span class="uploading" id="uploading-state" hidden><span class="spinner dark"></span> جارٍ معالجة الملفات...</span>
            </div>
            <div class="attachment-draft-list" id="attachment-draft-list"></div>
            <div class="storage-hint">${icon('database')} المرفقات تُحفظ داخل مساحة المتصفح. الصور الكبيرة تُضغط تلقائيًا.</div>
          </div>

          <div class="form-error span-2" data-form-error hidden></div>
        </div>
        <div class="modal-footer form-footer">
          <span class="form-actions-note">${icon('lock')} تُحفظ التغييرات محليًا</span>
          <button class="btn" type="button" data-form-cancel>إلغاء</button>
          <button class="btn primary" type="submit" data-form-submit>${item.id ? 'حفظ التعديلات' : `حفظ ${escapeHtml(meta.singular)}`}</button>
        </div>
      </form>
    `;
  }

  function showItemFormError(form, message) {
    const errorBox = $('[data-form-error]', form);
    if (!errorBox) return;
    errorBox.innerHTML = `${icon('alert-circle')}<span>${escapeHtml(message)}</span>`;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function openItemForm(section, existing = null) {
    const meta = SECTIONS[section];
    if (!meta) return;
    const item = existing ? { ...existing, tags: [...(existing.tags || [])], attachments: sortAttachments(existing.attachments || []) } : {
      title: '',
      category: '',
      date: todayISO(),
      description: '',
      tags: [],
      link: '',
      attachments: [],
      content: '',
      impact: '',
      status: section === 'reports' ? 'draft' : '',
      evidenceType: section === 'evidence' ? 'document' : '',
      linkedAchievementId: '',
    };
    const categories = categoryCounts(section);
    const achievements = [...(state.workspace.achievements || [])].sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ar'));
    let draftAttachments = sortAttachments(item.attachments || []);
    let processing = 0;

    const { backdrop, close } = openModal({
      title: existing ? `تعديل ${meta.singular}` : meta.addLabel,
      subtitle: existing ? 'حدّث تفاصيل العنصر ثم احفظ التغييرات.' : 'أضف التفاصيل التي تجعل هذا العنصر واضحًا وموثقًا.',
      kicker: existing ? 'تعديل المحتوى' : 'إضافة جديدة',
      kickerIcon: existing ? 'edit' : 'plus',
      size: 'lg',
      body: itemFormFieldMarkup(section, item, categories, achievements),
      onMount: ({ backdrop: dialog }) => {
        const form = $('#item-form', dialog);
        const list = $('#attachment-draft-list', dialog);
        const zone = $('#upload-zone', dialog);
        const fileInput = $('#item-files', dialog);
        const uploadingState = $('#uploading-state', dialog);
        const submitButton = $('[data-form-submit]', form);

        function renderDrafts() {
          if (list) list.innerHTML = draftAttachmentListMarkup(draftAttachments);
          const localStorageHint = $('.storage-hint', dialog);
          if (localStorageHint) {
            localStorageHint.innerHTML = `${icon('database')} ${draftAttachments.length} من ${MAX_FILES_PER_ITEM} مرفقات · تُحفظ داخل مساحة المتصفح`;
          }
        }

        renderDrafts();

        list.addEventListener('click', (event) => {
          const remove = event.target.closest('[data-remove-attachment]');
          if (!remove) return;
          draftAttachments = draftAttachments.filter((attachment) => attachment.id !== remove.dataset.removeAttachment);
          renderDrafts();
        });

        async function handleFiles(fileList) {
          const files = Array.from(fileList || []);
          if (!files.length) return;
          const remaining = MAX_FILES_PER_ITEM - draftAttachments.length;
          if (remaining <= 0) {
            toast(`يمكن إرفاق ${MAX_FILES_PER_ITEM} ملفات لكل عنصر كحد أقصى.`, 'warning');
            return;
          }
          if (files.length > remaining) {
            toast(`تمت إضافة أول ${remaining} ملفات فقط بسبب الحد الأقصى للمرفقات.`, 'warning');
          }
          const selected = files.slice(0, remaining);
          processing += 1;
          zone.classList.add('is-busy');
          if (uploadingState) uploadingState.hidden = false;
          if (submitButton) submitButton.disabled = true;
          try {
            for (const file of selected) {
              try {
                const attachment = await prepareAttachment(file);
                draftAttachments.push(attachment);
                renderDrafts();
              } catch (error) {
                toast(`${file.name}: ${error.message}`, 'error');
              }
            }
          } finally {
            processing = Math.max(0, processing - 1);
            if (!processing) {
              zone.classList.remove('is-busy');
              if (uploadingState) uploadingState.hidden = true;
              if (submitButton) submitButton.disabled = false;
            }
            if (fileInput) fileInput.value = '';
          }
        }

        zone.addEventListener('click', (event) => {
          if (event.target.closest('input')) return;
          if (!processing) fileInput.click();
        });
        zone.addEventListener('keydown', (event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !processing) {
            event.preventDefault();
            fileInput.click();
          }
        });
        fileInput.addEventListener('change', () => handleFiles(fileInput.files));
        ['dragenter', 'dragover'].forEach((eventName) => {
          zone.addEventListener(eventName, (event) => {
            event.preventDefault();
            zone.classList.add('is-dragover');
          });
        });
        ['dragleave', 'drop'].forEach((eventName) => {
          zone.addEventListener(eventName, (event) => {
            event.preventDefault();
            zone.classList.remove('is-dragover');
            if (eventName === 'drop') handleFiles(event.dataTransfer?.files);
          });
        });

        $('[data-form-cancel]', form).addEventListener('click', () => close(false));

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (processing) {
            toast('انتظر حتى تنتهي معالجة الملفات.', 'info');
            return;
          }
          const errorBox = $('[data-form-error]', form);
          if (errorBox) errorBox.hidden = true;
          const title = String(form.elements.title.value || '').trim();
          if (title.length < 2) {
            showItemFormError(form, 'أدخل عنوانًا واضحًا للعنصر (حرفان على الأقل).');
            form.elements.title.focus();
            return;
          }
          const linkValue = String(form.elements.link.value || '').trim();
          const safeLink = makeUrl(linkValue);
          if (linkValue && !safeLink) {
            showItemFormError(form, 'الرابط غير صالح. تأكد من كتابته بالشكل الصحيح، مثل: https://example.com');
            form.elements.link.focus();
            return;
          }
          const evidenceType = section === 'evidence' ? String(form.elements.evidenceType?.value || 'document') : '';
          if (evidenceType === 'link' && !safeLink) {
            showItemFormError(form, 'اخترت نوع «رابط»، لذا أضف رابط الشاهد قبل الحفظ.');
            form.elements.link.focus();
            return;
          }
          const record = {
            ...item,
            id: existing?.id || uid(),
            section,
            title: title.slice(0, 160),
            category: String(form.elements.category?.value || '').trim().slice(0, 60),
            date: String(form.elements.date?.value || ''),
            description: String(form.elements.description?.value || '').trim().slice(0, 2000),
            tags: parseTags(form.elements.tags?.value || ''),
            link: safeLink || '',
            attachments: draftAttachments.slice(),
            content: section === 'reports' ? String(form.elements.content?.value || '').trim().slice(0, 12000) : '',
            impact: String(form.elements.impact?.value || '').trim().slice(0, 3000),
            status: section === 'reports' ? String(form.elements.status?.value || 'draft') : '',
            evidenceType,
            linkedAchievementId: section === 'evidence' ? String(form.elements.linkedAchievementId?.value || '') : '',
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          try {
            commitWorkspace((workspace) => {
              workspace[section] = Array.isArray(workspace[section]) ? workspace[section] : [];
              if (existing) {
                const index = workspace[section].findIndex((entry) => entry.id === existing.id);
                if (index !== -1) workspace[section][index] = record;
                else workspace[section].unshift(record);
              } else {
                workspace[section].unshift(record);
              }
            }, {
              activity: {
                kind: existing ? 'updated' : 'created',
                section,
                title: record.title,
              },
            });
            close(true);
            toast(existing ? 'تم تحديث العنصر بنجاح.' : `تم حفظ ${meta.singular} في مساحتك.`, 'success');
            if (state.currentRoute !== section) navigate(section);
            else renderRoute();
          } catch (error) {
            showItemFormError(form, error.message || 'تعذّر حفظ العنصر. حاول مرة أخرى.');
            setButtonLoading(submitButton, false);
          }
        });
      },
    });
    void backdrop;
  }

  /* ------------------------------------------------------------------ */
  /* الملف المهني                                                        */
  /* ------------------------------------------------------------------ */

  function renderProfile(page) {
    const profile = state.profile || {};
    const photo = getProfilePhoto();
    const completion = profileCompletion();
    const counts = {
      achievements: countSection('achievements'),
      evidence: countSection('evidence'),
      reports: countSection('reports'),
    };
    const website = makeUrl(profile.website);
    const email = String(profile.email || '').trim();
    const phone = String(profile.phone || '').trim();
    const phoneHref = String(phone).replace(/[^\d+]/g, '');
    const skills = Array.isArray(profile.skills) ? profile.skills.filter(Boolean) : [];
    const identityParts = [profile.jobTitle, profile.organization, profile.location]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    const infoItems = [];
    if (String(profile.organization || '').trim()) {
      infoItems.push({ iconName: 'building', label: 'جهة العمل', html: escapeHtml(profile.organization) });
    }
    if (String(profile.specialization || '').trim()) {
      infoItems.push({ iconName: 'target', label: 'التخصص', html: escapeHtml(profile.specialization) });
    }
    if (String(profile.location || '').trim()) {
      infoItems.push({ iconName: 'map-pin', label: 'الموقع', html: escapeHtml(profile.location) });
    }
    if (String(profile.yearsExperience || '').trim()) {
      const years = String(profile.yearsExperience).trim();
      infoItems.push({ iconName: 'chart', label: 'سنوات الخبرة', html: `${escapeHtml(years)} ${Number(years) === 1 ? 'سنة' : 'سنوات'}` });
    }
    if (email) {
      infoItems.push({
        iconName: 'mail',
        label: 'بريد التواصل',
        html: Store.isValidEmail(email)
          ? `<a href="mailto:${escapeAttr(email)}" dir="ltr">${escapeHtml(email)}</a>`
          : escapeHtml(email),
      });
    }
    if (phone) {
      infoItems.push({
        iconName: 'phone',
        label: 'الهاتف',
        html: phoneHref.length >= 6
          ? `<a href="tel:${escapeAttr(phoneHref)}" dir="ltr">${escapeHtml(phone)}</a>`
          : escapeHtml(phone),
      });
    }
    if (website) {
      infoItems.push({
        iconName: 'globe',
        label: 'الموقع المهني',
        html: `<a href="${escapeAttr(website)}" target="_blank" rel="noopener noreferrer" dir="ltr">${escapeHtml(urlLabel(website))}</a>`,
      });
    }

    page.innerHTML = `
      <div class="page-heading">
        <div class="page-heading-main">
          <span class="page-eyebrow">${icon('user')} ملفي</span>
          <h1 class="page-title">الملف المهني</h1>
          <p class="page-description">هويتك المهنية في مكان واحد. تظهر هذه البيانات بجانب إنجازاتك وشواهدك، وتجعل ملفك أكثر اكتمالًا واحترافية.</p>
        </div>
        <div class="page-heading-actions">
          <button class="btn primary" type="button" data-edit-profile>${icon('edit')} تعديل الملف</button>
          <button class="btn" type="button" data-print-profile>${icon('print')} طباعة</button>
        </div>
      </div>

      <div class="profile-layout">
        <section class="profile-main-card" aria-label="البيانات المهنية">
          <div class="profile-cover"></div>
          <div class="profile-hero">
            <div class="profile-avatar-wrap">
              ${avatarMarkup(profile.fullName || state.user?.name, photo)}
              <span class="online-dot" title="مساحة نشطة"></span>
            </div>
            <div class="profile-identity">
              <h1>${escapeHtml(profile.fullName || state.user?.name || 'مستخدم')}</h1>
              <p>
                ${identityParts.length
                  ? identityParts.map((part) => `<span>${escapeHtml(part)}</span>`).join('<span class="dot"></span>')
                  : '<span>أضف مسماك الوظيفي وجهة عملك لتكتمل هويتك المهنية.</span>'}
              </p>
            </div>
            <div class="profile-actions">
              <button class="btn primary" type="button" data-edit-profile>${icon('edit')} تعديل البيانات</button>
            </div>
          </div>
          <div class="profile-body">
            <div class="profile-section">
              <h2 class="profile-section-title">${icon('book-open')} نبذة مهنية</h2>
              <p class="profile-bio ${String(profile.bio || '').trim() ? '' : 'is-empty'}">${escapeHtml(String(profile.bio || '').trim() || 'لم تُضف نبذة مهنية بعد. اكتب نبذة قصيرة تعرّف بخبرتك واهتماماتك وما يميز مسيرتك.')}</p>
            </div>
            <div class="profile-divider"></div>
            <div class="profile-section">
              <h2 class="profile-section-title">${icon('briefcase')} معلومات مهنية</h2>
              ${infoItems.length
                ? `<div class="info-grid">${infoItems.map((item) => `
                    <div class="info-item">
                      ${icon(item.iconName)}
                      <div><small>${escapeHtml(item.label)}</small><span>${item.html}</span></div>
                    </div>
                  `).join('')}</div>`
                : `<div class="info-note">${icon('info')} <span>لم تُضف تفاصيل مهنية بعد. أضف جهة عملك وتخصصك وبيانات التواصل لتظهر هنا.</span></div>`}
            </div>
            <div class="profile-divider"></div>
            <div class="profile-section">
              <h2 class="profile-section-title">${icon('sparkles')} المهارات</h2>
              ${skills.length
                ? `<div class="skills-cloud">${skills.map((skill) => `<span class="skill-pill"><span class="dot"></span>${escapeHtml(skill)}</span>`).join('')}</div>`
                : `<p class="profile-bio is-empty">لم تُضف مهارات بعد. أضف مهاراتك لتبرز نقاط قوتك أمام من يطّلع على ملفك.</p>`}
            </div>
          </div>
        </section>

        <aside class="profile-side" aria-label="ملخص الملف">
          <div class="profile-side-card">
            <h2>${icon('target')} اكتمال الملف</h2>
            <p>${completion.percent === 100 ? 'ملفك مكتمل وجاهز للعرض.' : `أكملت ${completion.completed} من ${completion.total} عناصر.`}</p>
            <div class="profile-inline-progress">
              <span class="storage-track"><span style="width:${completion.percent}%"></span></span>
              <strong>${completion.percent}%</strong>
            </div>
            <div class="completion-checklist">
              ${completion.checks.map((check) => `
                <div class="checklist-item ${check.done ? 'done' : ''}">
                  <span class="checklist-mark ${check.done ? 'done' : ''}">${check.done ? icon('check') : ''}</span>
                  <span>${escapeHtml(check.label)}</span>
                </div>
              `).join('')}
            </div>
            <button class="btn soft block" type="button" data-edit-profile>${icon('edit')} ${completion.percent === 100 ? 'تحديث بياناتي' : 'إكمال الملف'}</button>
          </div>

          <div class="profile-side-card">
            <h2>${icon('chart')} محتوى موثق</h2>
            <p>ملخص ما جمعته في مساحتك حتى الآن.</p>
            <div class="profile-mini-stats">
              <div class="profile-mini-stat"><strong>${counts.achievements}</strong><span>إنجاز</span></div>
              <div class="profile-mini-stat"><strong>${counts.evidence}</strong><span>شاهد</span></div>
              <div class="profile-mini-stat"><strong>${counts.reports}</strong><span>تقرير</span></div>
            </div>
          </div>

          <div class="profile-side-card profile-contact-card">
            <h2>${icon('mail')} للتواصل</h2>
            ${email || phone || website ? `
              ${email ? `<div class="contact-line">${icon('mail')}<span>${escapeHtml(email)}</span></div>` : ''}
              ${phone ? `<div class="contact-line">${icon('phone')}<span>${escapeHtml(phone)}</span></div>` : ''}
              ${website ? `<div class="contact-line">${icon('globe')}<a href="${escapeAttr(website)}" target="_blank" rel="noopener noreferrer" dir="ltr">${escapeHtml(urlLabel(website))}</a></div>` : ''}
            ` : `<p>أضف بيانات التواصل لتظهر هنا وفي ملفك المطبوع.</p>`}
          </div>
        </aside>
      </div>
    `;
  }

  function openProfileForm() {
    const profile = state.profile || {};
    let photoDraft = getProfilePhoto();
    let processing = false;

    const { backdrop, close } = openModal({
      title: 'تعديل الملف المهني',
      subtitle: 'حدّث بياناتك المهنية وصورتك الشخصية لتبقى هويتك واضحة في كل مكان.',
      kicker: 'ملفي المهني',
      kickerIcon: 'user',
      size: 'lg',
      body: `
        <form id="profile-form" novalidate>
          <div class="form-grid">
            <div class="form-field span-2">
              <span class="field-label">الصورة الشخصية <span class="optional">(اختياري)</span></span>
              <div class="profile-photo-editor">
                <div class="profile-photo-preview" data-profile-photo-preview></div>
                <div class="profile-photo-copy">
                  <strong>صورة واضحة تعرّف بك</strong>
                  <span>JPG أو PNG أو WebP · تُضغط الصورة تلقائيًا · حتى ${formatBytes(MAX_FILE_SIZE)}</span>
                  <div class="settings-actions">
                    <button class="btn sm" type="button" data-upload-photo>${icon('upload')} اختيار صورة</button>
                    <button class="btn sm danger" type="button" data-remove-photo hidden>${icon('trash')} إزالة</button>
                  </div>
                  <input id="profile-photo-input" type="file" accept="image/jpeg,image/png,image/webp" hidden>
                </div>
              </div>
            </div>

            <div class="form-separator">البيانات الأساسية</div>
            <div class="form-field">
              <label for="profile-name">الاسم الكامل <span class="muted">*</span></label>
              <input id="profile-name" name="fullName" type="text" maxlength="80" value="${escapeAttr(profile.fullName || state.user?.name || '')}" placeholder="مثال: سارة العتيبي" required autofocus>
            </div>
            <div class="form-field">
              <label for="profile-job">المسمى الوظيفي</label>
              <input id="profile-job" name="jobTitle" type="text" maxlength="100" value="${escapeAttr(profile.jobTitle || '')}" placeholder="مثال: أخصائية تطوير مهني">
            </div>
            <div class="form-field">
              <label for="profile-org">جهة العمل</label>
              <input id="profile-org" name="organization" type="text" maxlength="120" value="${escapeAttr(profile.organization || '')}" placeholder="اسم الجهة أو المؤسسة">
            </div>
            <div class="form-field">
              <label for="profile-specialization">التخصص</label>
              <input id="profile-specialization" name="specialization" type="text" maxlength="100" value="${escapeAttr(profile.specialization || '')}" placeholder="مثال: التطوير المهني">
            </div>
            <div class="form-field">
              <label for="profile-location">الموقع</label>
              <input id="profile-location" name="location" type="text" maxlength="80" value="${escapeAttr(profile.location || '')}" placeholder="المدينة، الدولة">
            </div>
            <div class="form-field">
              <label for="profile-years">سنوات الخبرة</label>
              <input id="profile-years" name="yearsExperience" type="number" min="0" max="60" step="1" value="${escapeAttr(profile.yearsExperience || '')}" placeholder="مثال: 8">
            </div>

            <div class="form-separator">بيانات التواصل</div>
            <div class="form-field">
              <label for="profile-email">بريد التواصل</label>
              <input id="profile-email" name="email" type="email" inputmode="email" maxlength="160" value="${escapeAttr(profile.email || '')}" placeholder="name@example.com" dir="ltr">
              <span class="field-hint">${icon('info')} لا يغيّر بريد الدخول إلى الحساب.</span>
            </div>
            <div class="form-field">
              <label for="profile-phone">الهاتف</label>
              <input id="profile-phone" name="phone" type="tel" maxlength="30" value="${escapeAttr(profile.phone || '')}" placeholder="+966 5x xxx xxxx" dir="ltr">
            </div>
            <div class="form-field span-2">
              <label for="profile-website">الموقع المهني <span class="optional">(اختياري)</span></label>
              <div class="input-wrap">
                ${icon('globe')}
                <input id="profile-website" name="website" type="url" maxlength="300" value="${escapeAttr(profile.website || '')}" placeholder="https://example.com" dir="ltr">
              </div>
            </div>

            <div class="form-separator">النبذة والمهارات</div>
            <div class="form-field span-2">
              <label for="profile-bio">نبذة مهنية</label>
              <textarea id="profile-bio" name="bio" maxlength="3000" rows="4" placeholder="اكتب نبذة قصيرة عن خبرتك، اهتماماتك، وما تحب أن يتركه عملك من أثر...">${escapeHtml(profile.bio || '')}</textarea>
              <span class="field-hint">${icon('sparkles')} النبذة المكتملة تبدأ من 40 حرفًا.</span>
            </div>
            <div class="form-field span-2">
              <label for="profile-skills">المهارات</label>
              <input id="profile-skills" name="skills" type="text" maxlength="400" value="${escapeAttr((profile.skills || []).join('، '))}" placeholder="مثال: القيادة، التخطيط، التدريب، تحليل البيانات">
              <span class="field-hint">افصل بين المهارات بفاصلة. أضف ثلاث مهارات على الأقل ليصبح هذا العنصر مكتملًا.</span>
            </div>

            <div class="form-error span-2" data-form-error hidden></div>
          </div>
          <div class="modal-footer form-footer">
            <span class="form-actions-note">${icon('lock')} تُحفظ التغييرات محليًا</span>
            <button class="btn" type="button" data-form-cancel>إلغاء</button>
            <button class="btn primary" type="submit" data-form-submit>${icon('save')} حفظ الملف</button>
          </div>
        </form>
      `,
      onMount: ({ backdrop: dialog }) => {
        const form = $('#profile-form', dialog);
        const nameInput = $('#profile-name', dialog);
        const photoPreview = $('[data-profile-photo-preview]', dialog);
        const photoInput = $('#profile-photo-input', dialog);
        const uploadButton = $('[data-upload-photo]', dialog);
        const removeButton = $('[data-remove-photo]', dialog);
        const submitButton = $('[data-form-submit]', form);

        function renderPhotoPreview() {
          if (photoPreview) {
            photoPreview.innerHTML = avatarMarkup(nameInput?.value || state.user?.name, photoDraft);
          }
          if (removeButton) removeButton.hidden = !photoDraft;
        }

        renderPhotoPreview();
        nameInput?.addEventListener('input', renderPhotoPreview);

        uploadButton?.addEventListener('click', () => photoInput?.click());
        photoInput?.addEventListener('change', async () => {
          const file = photoInput.files?.[0];
          if (!file) return;
          if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
            toast('اختر صورة بصيغة JPG أو PNG أو WebP.', 'error');
            photoInput.value = '';
            return;
          }
          if (file.size > MAX_IMAGE_SOURCE_SIZE) {
            toast(`حجم الصورة كبير جدًا. الحد الأقصى ${formatBytes(MAX_IMAGE_SOURCE_SIZE)}.`, 'error');
            photoInput.value = '';
            return;
          }
          processing = true;
          setButtonLoading(uploadButton, true, 'جارٍ المعالجة...');
          try {
            const raw = await readFileAsDataUrl(file);
            photoDraft = await compressImage(raw, 720, 0.86);
            renderPhotoPreview();
            toast('تم تجهيز الصورة. احفظ الملف لتثبيت التغيير.', 'info');
          } catch (error) {
            toast(error.message || 'تعذّر معالجة الصورة.', 'error');
          } finally {
            processing = false;
            setButtonLoading(uploadButton, false);
            photoInput.value = '';
          }
        });

        removeButton?.addEventListener('click', () => {
          photoDraft = null;
          renderPhotoPreview();
        });

        $('[data-form-cancel]', form)?.addEventListener('click', () => close(false));

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (processing) {
            toast('انتظر حتى تنتهي معالجة الصورة.', 'info');
            return;
          }
          const fullName = String(form.elements.fullName.value || '').trim().replace(/\s+/g, ' ');
          const email = String(form.elements.email.value || '').trim();
          const websiteRaw = String(form.elements.website.value || '').trim();
          const website = websiteRaw ? makeUrl(websiteRaw, false) : '';

          if (fullName.length < 2) {
            showItemFormError(form, 'أدخل اسمك الكامل (حرفان على الأقل).');
            form.elements.fullName.focus();
            return;
          }
          if (email && !Store.isValidEmail(email)) {
            showItemFormError(form, 'صيغة بريد التواصل غير صحيحة.');
            form.elements.email.focus();
            return;
          }
          if (websiteRaw && !website) {
            showItemFormError(form, 'رابط الموقع غير صالح. اكتبه بالشكل الصحيح، مثل: https://example.com');
            form.elements.website.focus();
            return;
          }
          const yearsRaw = String(form.elements.yearsExperience.value || '').trim();
          const yearsNumber = yearsRaw === '' ? '' : Math.max(0, Math.min(60, Math.round(Number(yearsRaw))));
          if (yearsRaw !== '' && !Number.isFinite(Number(yearsRaw))) {
            showItemFormError(form, 'أدخل عدد سنوات الخبرة بصيغة رقمية صحيحة.');
            form.elements.yearsExperience.focus();
            return;
          }

          const nextProfile = {
            ...profile,
            fullName,
            jobTitle: String(form.elements.jobTitle.value || '').trim().slice(0, 100),
            organization: String(form.elements.organization.value || '').trim().slice(0, 120),
            specialization: String(form.elements.specialization.value || '').trim().slice(0, 100),
            location: String(form.elements.location.value || '').trim().slice(0, 80),
            yearsExperience: yearsNumber === '' ? '' : String(yearsNumber),
            email: email.slice(0, 160),
            phone: String(form.elements.phone.value || '').trim().slice(0, 30),
            website: website || '',
            bio: String(form.elements.bio.value || '').trim().slice(0, 3000),
            skills: parseTags(form.elements.skills.value || '').slice(0, 20),
            photo: photoDraft
              ? {
                  dataUrl: photoDraft,
                  name: 'profile-photo.jpg',
                  type: photoDraft.startsWith('data:image/png') ? 'image/png' : photoDraft.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg',
                  size: base64Size(photoDraft),
                  updatedAt: new Date().toISOString(),
                }
              : null,
            updatedAt: new Date().toISOString(),
          };

          setButtonLoading(submitButton, true, 'جارٍ حفظ الملف...');
          try {
            commitWorkspace((workspace) => {
              workspace.profile = nextProfile;
            }, {
              activity: { kind: 'profile' },
              accountName: fullName,
            });
            state.user.name = fullName;
            close(true);
            updateShellData();
            renderRoute();
            toast('تم تحديث ملفك المهني بنجاح.', 'success');
          } catch (error) {
            showItemFormError(form, error.message || 'تعذّر حفظ الملف. حاول مرة أخرى.');
            setButtonLoading(submitButton, false);
          }
        });
      },
    });
    void backdrop;
  }

  /* ------------------------------------------------------------------ */
  /* الإعدادات                                                          */
  /* ------------------------------------------------------------------ */

  function renderSettings(page) {
    const profile = state.profile || {};
    const user = state.user || {};
    const storage = getStorageInfo();
    const photo = getProfilePhoto();
    const name = profile.fullName || user.name || 'مستخدم';
    const email = user.email || '';
    const lastLogin = user.lastLoginAt ? relativeTime(user.lastLoginAt) : 'الآن';
    const memberSince = user.createdAt ? formatDate(user.createdAt) : '—';

    page.innerHTML = `
      <div class="page-heading">
        <div class="page-heading-main">
          <span class="page-eyebrow">${icon('settings')} الحساب</span>
          <h1 class="page-title">الإعدادات</h1>
          <p class="page-description">تحكّم في حسابك ومظهر التطبيق ومساحة التخزين، واحتفظ بنسخة احتياطية من ملفك في أي وقت.</p>
        </div>
      </div>

      <div class="settings-grid">
        <section class="settings-card" aria-labelledby="settings-account-title">
          <div class="settings-head">
            <span class="settings-icon">${icon('user')}</span>
            <div><h2 id="settings-account-title">الحساب</h2><p>بيانات الدخول الأساسية وملفك المهني.</p></div>
          </div>
          <div class="account-profile-line">
            ${avatarMarkup(name, photo)}
            <div class="account-profile-line-info">
              <strong>${escapeHtml(name)}</strong>
              <span dir="ltr">${escapeHtml(email)}</span>
            </div>
            <span class="badge neutral">${icon('lock')} محلي</span>
          </div>
          <div class="settings-list">
            <div class="settings-line">${icon('calendar')}<span>عضو منذ</span><strong>${escapeHtml(memberSince)}</strong></div>
            <div class="settings-line">${icon('clock')}<span>آخر دخول</span><strong>${escapeHtml(lastLogin)}</strong></div>
            <div class="settings-line">${icon('shield')}<span>خصوصية البيانات</span><strong>على هذا المتصفح فقط</strong></div>
          </div>
          <div class="settings-actions">
            <button class="btn sm primary" type="button" data-edit-profile>${icon('edit')} تعديل الملف</button>
            <button class="btn sm" type="button" data-change-password>${icon('key')} تغيير كلمة المرور</button>
          </div>
        </section>

        <section class="settings-card" aria-labelledby="settings-theme-title">
          <div class="settings-head">
            <span class="settings-icon blue">${icon('palette')}</span>
            <div><h2 id="settings-theme-title">المظهر</h2><p>اختر الوضع المريح لعينيك أثناء العمل.</p></div>
          </div>
          <div class="theme-options" role="group" aria-label="اختيار مظهر التطبيق">
            <button class="theme-option ${state.theme === 'light' ? 'active' : ''}" type="button" data-set-theme="light" aria-pressed="${state.theme === 'light'}">
              <span class="theme-preview light"></span>
              <span class="theme-option-label">${icon('sun')} الوضع النهاري</span>
            </button>
            <button class="theme-option ${state.theme === 'dark' ? 'active' : ''}" type="button" data-set-theme="dark" aria-pressed="${state.theme === 'dark'}">
              <span class="theme-preview dark"></span>
              <span class="theme-option-label">${icon('moon')} الوضع الليلي</span>
            </button>
          </div>
          <div class="info-note">
            ${icon('info')}
            <span>يُحفظ اختيارك في هذا المتصفح، ويُطبَّق تلقائيًا عند العودة إلى التطبيق.</span>
          </div>
        </section>

        <section class="settings-card" aria-labelledby="settings-storage-title">
          <div class="settings-head">
            <span class="settings-icon">${icon('database')}</span>
            <div><h2 id="settings-storage-title">مساحة التخزين</h2><p>سعة مساحتك المحلية وحالة استخدامها.</p></div>
          </div>
          <div class="storage-summary">
            <div class="storage-donut" style="--progress:${storage.percent}">
              <strong>${storage.percent}%</strong>
              <span>مستخدم</span>
            </div>
            <div class="storage-info">
              <h3>${storage.percent >= 82 ? 'المساحة تقترب من الامتلاء' : 'مساحتك في وضع جيد'}</h3>
              <p>${formatBytes(storage.bytes)} مستخدمة من أصل ${formatBytes(storage.limit)}. تُحسب المرفقات والصور ضمن هذه المساحة.</p>
              <div class="storage-track"><span style="width:${Math.max(storage.percent, storage.bytes ? 2 : 0)}%"></span></div>
              <small>${storage.percent >= 82 ? 'احذف المرفقات غير الضرورية أو صدّر نسخة احتياطية.' : 'الصور الكبيرة تُضغط تلقائيًا قبل حفظها.'}</small>
            </div>
          </div>
          <div class="info-note">
            ${icon('shield')}
            <span>التخزين مرتبط بهذا المتصفح وهذا الجهاز. مسح بيانات المتصفح قد يؤدي إلى فقدان المساحة، لذا احتفظ بنسخة احتياطية دوريًا.</span>
          </div>
        </section>

        <section class="settings-card" aria-labelledby="settings-backup-title">
          <div class="settings-head">
            <span class="settings-icon blue">${icon('save')}</span>
            <div><h2 id="settings-backup-title">النسخ الاحتياطي</h2><p>صدّر ملفك أو استعده على متصفح آخر.</p></div>
          </div>
          <div class="backup-actions">
            <button class="btn sm primary" type="button" data-export-backup>${icon('download')} تصدير نسخة</button>
            <button class="btn sm" type="button" data-import-backup>${icon('import')} استيراد نسخة</button>
            <input id="backup-file-input" type="file" accept="application/json,.json" hidden>
          </div>
          <div class="danger-note">
            ${icon('alert-circle')}
            <span>استيراد نسخة احتياطية سيستبدل كل المحتوى الحالي في مساحتك. صدّر نسخة من بياناتك الحالية قبل الاستيراد.</span>
          </div>
          <div class="settings-actions">
            <button class="btn sm danger" type="button" data-logout>${icon('logout')} تسجيل الخروج</button>
          </div>
        </section>
      </div>
    `;

    const backupInput = $('#backup-file-input', page);
    if (backupInput) {
      backupInput.addEventListener('change', () => {
        const file = backupInput.files?.[0];
        backupInput.value = '';
        if (file) void handleBackupFile(file);
      });
    }
  }

  function openPasswordModal() {
    const { backdrop, close } = openModal({
      title: 'تغيير كلمة المرور',
      subtitle: 'اختر كلمة مرور قوية وجديدة لحماية مساحتك المحلية.',
      kicker: 'أمان الحساب',
      kickerIcon: 'key',
      size: 'sm',
      body: `
        <form id="password-form" novalidate>
          <div class="form-grid">
            <div class="form-field span-2">
              <label for="current-password">كلمة المرور الحالية</label>
              <div class="input-wrap has-action">
                ${icon('lock')}
                <input id="current-password" name="currentPassword" type="password" autocomplete="current-password" placeholder="أدخل كلمة المرور الحالية" required autofocus>
                <button class="input-action" type="button" data-toggle-password aria-label="إظهار كلمة المرور">${icon('eye')}</button>
              </div>
            </div>
            <div class="form-field span-2">
              <label for="new-password">كلمة المرور الجديدة</label>
              <div class="input-wrap has-action">
                ${icon('key')}
                <input id="new-password" name="newPassword" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل، مع حرف ورقم" required>
                <button class="input-action" type="button" data-toggle-password aria-label="إظهار كلمة المرور">${icon('eye')}</button>
              </div>
              <span class="field-hint">${icon('info')} استخدم 8 أحرف على الأقل، مع حرف ورقم.</span>
            </div>
            <div class="form-field span-2">
              <label for="confirm-password">تأكيد كلمة المرور الجديدة</label>
              <div class="input-wrap">
                ${icon('lock')}
                <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" placeholder="أعد كتابة كلمة المرور الجديدة" required>
              </div>
            </div>
            <div class="form-error span-2" data-form-error hidden></div>
          </div>
          <div class="modal-footer form-footer">
            <span class="form-actions-note">${icon('shield')} لا تُرسل كلمة المرور إلى أي خادم</span>
            <button class="btn" type="button" data-form-cancel>إلغاء</button>
            <button class="btn primary" type="submit" data-form-submit>${icon('key')} تحديث كلمة المرور</button>
          </div>
        </form>
      `,
      onMount: ({ backdrop: dialog }) => {
        const form = $('#password-form', dialog);
        const submitButton = $('[data-form-submit]', form);

        $$('[data-toggle-password]', dialog).forEach((button) => {
          button.addEventListener('click', () => {
            const input = $('input', button.closest('.input-wrap'));
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            button.innerHTML = icon(show ? 'eye-off' : 'eye');
            button.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
          });
        });

        $('[data-form-cancel]', form)?.addEventListener('click', () => close(false));

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const currentPassword = String(form.elements.currentPassword.value || '');
          const newPassword = String(form.elements.newPassword.value || '');
          const confirmPassword = String(form.elements.confirmPassword.value || '');
          if (!currentPassword) {
            showItemFormError(form, 'أدخل كلمة المرور الحالية للمتابعة.');
            form.elements.currentPassword.focus();
            return;
          }
          const problem = Store.passwordProblem(newPassword);
          if (problem) {
            showItemFormError(form, problem);
            form.elements.newPassword.focus();
            return;
          }
          if (newPassword !== confirmPassword) {
            showItemFormError(form, 'كلمتا المرور الجديدتان غير متطابقتين.');
            form.elements.confirmPassword.focus();
            return;
          }
          if (currentPassword === newPassword) {
            showItemFormError(form, 'اختر كلمة مرور جديدة مختلفة عن كلمة المرور الحالية.');
            form.elements.newPassword.focus();
            return;
          }
          setButtonLoading(submitButton, true, 'جارٍ تحديث كلمة المرور...');
          try {
            await Store.changePassword(state.user.id, currentPassword, newPassword);
            try {
              commitWorkspace(() => {}, { activity: { kind: 'password' } });
            } catch { /* لا تؤثر صعوبة حفظ النشاط في نجاح تغيير كلمة المرور */ }
            close(true);
            toast('تم تحديث كلمة المرور بنجاح.', 'success');
          } catch (error) {
            showItemFormError(form, error.message || 'تعذّر تحديث كلمة المرور.');
            setButtonLoading(submitButton, false);
          }
        });
      },
    });
    void backdrop;
  }

  /* ------------------------------------------------------------------ */
  /* البحث الشامل                                                       */
  /* ------------------------------------------------------------------ */

  function highlightSearchText(value, query) {
    const raw = String(value || '');
    const terms = Array.from(new Set(
      String(query || '')
        .trim()
        .split(/\s+/)
        .filter((term) => term.length >= 2),
    ));
    if (!raw || !terms.length) return escapeHtml(raw);
    const lower = raw.toLocaleLowerCase('ar');
    const ranges = [];
    terms.forEach((term) => {
      const needle = term.toLocaleLowerCase('ar');
      let index = 0;
      while (index < lower.length) {
        const found = lower.indexOf(needle, index);
        if (found === -1) break;
        ranges.push([found, found + needle.length]);
        index = found + needle.length;
      }
    });
    if (!ranges.length) return escapeHtml(raw);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    ranges.forEach((range) => {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    });
    let output = '';
    let cursor = 0;
    merged.forEach(([start, end]) => {
      output += escapeHtml(raw.slice(cursor, start));
      output += `<mark>${escapeHtml(raw.slice(start, end))}</mark>`;
      cursor = end;
    });
    output += escapeHtml(raw.slice(cursor));
    return output;
  }

  function searchExcerpt(item, query) {
    const candidates = [
      item.description,
      item.content,
      item.impact,
      item.category,
      (item.tags || []).join('، '),
      (item.attachments || []).map((file) => file.name).join('، '),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const normalizedQuery = normalizeArabic(query);
    const source = candidates.find((value) => normalizeArabic(value).includes(normalizedQuery))
      || candidates[0]
      || 'لا يوجد وصف مضاف لهذا العنصر.';
    const normalizedSource = normalizeArabic(source);
    const matchIndex = normalizedSource.indexOf(normalizedQuery);
    const maxLength = 180;
    if (matchIndex === -1 || source.length <= maxLength) return truncateText(source, maxLength);
    const ratio = source.length / Math.max(1, normalizedSource.length);
    const approximateIndex = Math.min(source.length - 1, Math.floor(matchIndex * ratio));
    const start = Math.max(0, approximateIndex - Math.floor(maxLength * 0.35));
    const end = Math.min(source.length, start + maxLength);
    return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
  }

  function searchAllItems(query) {
    const normalizedQuery = normalizeArabic(query);
    if (!normalizedQuery) return [];
    return collectAllItems()
      .filter((item) => itemSearchText(item).includes(normalizedQuery))
      .sort((a, b) => {
        const aTitle = normalizeArabic(a.title).includes(normalizedQuery) ? 0 : 1;
        const bTitle = normalizeArabic(b.title).includes(normalizedQuery) ? 0 : 1;
        if (aTitle !== bTitle) return aTitle - bTitle;
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      });
  }

  function searchResultMarkup(item, query) {
    const meta = SECTIONS[item.section];
    const attachmentCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
    return `
      <button class="search-result" type="button" data-view-item data-section="${item.section}" data-id="${escapeAttr(item.id)}">
        <span class="search-result-icon ${item.section === 'evidence' ? 'blue' : ''}">${icon(meta.icon)}</span>
        <span class="search-result-main">
          <span class="search-result-top">
            <span class="section-chip ${item.section === 'evidence' ? 'blue' : ''}">${icon(meta.icon)} ${escapeHtml(meta.title)}</span>
            ${item.category ? `<span class="tag">${escapeHtml(item.category)}</span>` : ''}
          </span>
          <h3>${highlightSearchText(item.title || 'بدون عنوان', query)}</h3>
          <p>${highlightSearchText(searchExcerpt(item, query), query)}</p>
          <span class="search-result-meta">
            ${item.date ? `<span>${icon('calendar')} ${escapeHtml(formatDate(item.date, { short: true }))}</span>` : ''}
            ${attachmentCount ? `<span>${icon('paperclip')} ${attachmentCount} مرفق</span>` : ''}
            <span>${icon('clock')} ${escapeHtml(relativeTime(item.updatedAt))}</span>
          </span>
        </span>
        ${icon('chevron-left')}
      </button>
    `;
  }

  function searchResultsMarkup(query) {
    const cleanQuery = String(query || '').trim();
    const totalItems = collectAllItems().length;
    if (!cleanQuery) {
      return `
        <div class="search-empty">
          <div class="empty-visual">${icon('search')}</div>
          <h3>ابحث في كل ما وثّقته</h3>
          <p>اكتب كلمة أو اسم تصنيف للبحث في ${totalItems} ${totalItems === 1 ? 'عنصر موثق' : 'عنصرًا موثقًا'} داخل إنجازاتك وشواهدك وتقاريرك.</p>
          <div class="settings-actions search-empty-actions">
            <button class="btn sm" type="button" data-route="achievements">${icon('award')} إنجازاتي</button>
            <button class="btn sm" type="button" data-route="evidence">${icon('archive')} شواهدي</button>
            <button class="btn sm" type="button" data-route="reports">${icon('file-text')} تقاريري</button>
          </div>
        </div>
      `;
    }
    const allResults = searchAllItems(cleanQuery);
    if (!allResults.length) {
      return `
        <div class="search-empty">
          <div class="empty-visual">${icon('search')}</div>
          <h3>لا توجد نتائج مطابقة</h3>
          <p>لم نعثر على «${escapeHtml(cleanQuery)}» في ملفك. جرّب كلمة أقصر، أو تحقق من الإملاء، أو ابحث باسم تصنيف أو وسم.</p>
        </div>
      `;
    }
    const results = allResults.slice(0, 200);
    const counts = { achievements: 0, evidence: 0, reports: 0 };
    allResults.forEach((item) => { counts[item.section] += 1; });
    return `
      <div class="search-results-head">
        <h2>${icon('search')} نتائج البحث</h2>
        <p>${allResults.length} ${allResults.length === 1 ? 'نتيجة' : 'نتيجة'} · ${counts.achievements} إنجاز · ${counts.evidence} شاهد · ${counts.reports} تقرير</p>
      </div>
      <div class="search-result-list">
        ${results.map((item) => searchResultMarkup(item, cleanQuery)).join('')}
      </div>
      ${allResults.length > results.length ? `<p class="search-more-note">تُعرض أول ${results.length} نتيجة من ${allResults.length}. جرّب كلمة بحث أكثر تحديدًا.</p>` : ''}
    `;
  }

  function renderSearchPage(page) {
    const categories = new Map();
    collectAllItems().forEach((item) => {
      const category = String(item.category || '').trim();
      if (category) categories.set(category, (categories.get(category) || 0) + 1);
    });
    const keywords = Array.from(categories.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category]) => category);
    const suggestions = keywords.length ? keywords : ['تطوير', 'قيادة', 'شهادة', 'تقرير'];

    page.innerHTML = `
      <section class="search-panel" aria-labelledby="search-page-title">
        <h1 class="search-hero-title" id="search-page-title">ابحث في ملفك</h1>
        <p class="search-hero-sub">نتائج فورية من إنجازاتك وشواهدك وتقاريرك، بما في ذلك التصنيفات والوسوم وأسماء المرفقات.</p>
        <form class="search-big" id="page-search-form" role="search">
          ${icon('search')}
          <input id="page-search" name="q" type="search" value="${escapeAttr(state.searchQuery || '')}" placeholder="اكتب كلمة للبحث..." aria-label="البحث في المحتوى" autocomplete="off" autofocus>
          <button class="btn primary" type="submit">بحث</button>
        </form>
        <div class="search-keywords">
          <span>جرّب:</span>
          ${suggestions.map((keyword) => `<button type="button" data-search-keyword="${escapeAttr(keyword)}">${escapeHtml(keyword)}</button>`).join('')}
        </div>
      </section>
      <div id="search-output">${searchResultsMarkup(state.searchQuery)}</div>
    `;

    const form = $('#page-search-form', page);
    const input = $('#page-search', page);
    const output = $('#search-output', page);
    if (!form || !input || !output) return;

    const applyQuery = (value) => {
      state.searchQuery = String(value || '').trim();
      output.innerHTML = searchResultsMarkup(state.searchQuery);
      const hash = state.searchQuery ? `#search?q=${encodeURIComponent(state.searchQuery)}` : '#search';
      if (window.location.hash !== hash) history.replaceState(null, '', hash);
      const globalSearch = document.getElementById('global-search');
      if (globalSearch) globalSearch.value = state.searchQuery;
    };

    const onInput = debounce(() => applyQuery(input.value), 180);
    input.addEventListener('input', onInput);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      applyQuery(input.value);
      input.focus();
    });
    $$('[data-search-keyword]', page).forEach((button) => {
      button.addEventListener('click', () => {
        input.value = button.dataset.searchKeyword || '';
        applyQuery(input.value);
        input.focus();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* الإضافة السريعة                                                     */
  /* ------------------------------------------------------------------ */

  function openQuickAdd() {
    const options = Object.values(SECTIONS);
    const { backdrop, close } = openModal({
      title: 'ماذا تريد أن تضيف؟',
      subtitle: 'اختر نوع المحتوى، وسنفتح لك نموذجًا جاهزًا بالتفاصيل المناسبة.',
      kicker: 'إضافة سريعة',
      kickerIcon: 'sparkles',
      size: 'sm',
      body: `
        <div class="quick-add-grid">
          ${options.map((meta) => `
            <button class="quick-add-option ${meta.color}" type="button" data-quick-section="${meta.key}">
              <span class="quick-add-icon ${meta.color}">${icon(meta.icon)}</span>
              <span class="quick-add-copy">
                <strong>${escapeHtml(meta.addLabel)}</strong>
                <span>${escapeHtml(meta.description)}</span>
              </span>
              <span class="quick-add-arrow">${icon('chevron-left')}</span>
            </button>
          `).join('')}
        </div>
      `,
      onMount: ({ backdrop: dialog }) => {
        $$('[data-quick-section]', dialog).forEach((button) => {
          button.addEventListener('click', () => {
            const section = button.dataset.quickSection;
            close(false);
            setTimeout(() => openItemForm(section), 80);
          });
        });
      },
    });
    void backdrop;
  }

  /* ------------------------------------------------------------------ */
  /* النسخ الاحتياطي                                                     */
  /* ------------------------------------------------------------------ */

  function downloadFile(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportBackup() {
    if (!state.workspace || !state.user) return;
    const payload = {
      app: 'athari',
      version: 1,
      exportedAt: new Date().toISOString(),
      account: {
        name: state.profile?.fullName || state.user.name,
        email: state.user.email,
      },
      workspace: state.workspace,
    };
    downloadFile(`athari-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2));
    toast('تم تجهيز نسخة احتياطية من ملفك وتنزيلها.', 'success');
  }

  function normalizeImportedWorkspace(source) {
    const now = new Date().toISOString();
    const text = (value, max) => String(value ?? '').trim().slice(0, max);
    const safeDate = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? now : date.toISOString();
    };
    const sourceProfile = source.profile && typeof source.profile === 'object' && !Array.isArray(source.profile)
      ? source.profile
      : {};
    const skills = Array.isArray(sourceProfile.skills)
      ? Array.from(new Set(sourceProfile.skills.map((skill) => text(skill, 40)).filter(Boolean))).slice(0, 20)
      : [];
    let photo = null;
    const photoValue = sourceProfile.photo;
    const photoData = typeof photoValue === 'string'
      ? photoValue
      : photoValue && typeof photoValue === 'object' ? String(photoValue.dataUrl || '') : '';
    if (/^data:image\/(jpeg|png|webp|gif);base64,/i.test(photoData) && photoData.length < MAX_WORKSPACE_BYTES_FALLBACK) {
      photo = {
        dataUrl: photoData,
        name: 'profile-photo.jpg',
        type: photoData.slice(5, photoData.indexOf(';')),
        size: base64Size(photoData),
        updatedAt: now,
      };
    }

    const profile = {
      fullName: text(sourceProfile.fullName || state.user?.name, 80).replace(/\s+/g, ' '),
      jobTitle: text(sourceProfile.jobTitle, 100),
      organization: text(sourceProfile.organization, 120),
      specialization: text(sourceProfile.specialization, 100),
      location: text(sourceProfile.location, 80),
      email: text(sourceProfile.email, 160),
      phone: text(sourceProfile.phone, 30),
      website: makeUrl(sourceProfile.website) || '',
      yearsExperience: text(sourceProfile.yearsExperience, 20),
      bio: text(sourceProfile.bio, 3000),
      skills,
      photo,
      updatedAt: now,
    };

    const normalizeAttachment = (entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const dataUrl = String(entry.dataUrl || '');
      if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) return null;
      if (dataUrl.length > MAX_WORKSPACE_BYTES_FALLBACK) return null;
      const type = text(entry.type || 'application/octet-stream', 120);
      if (/^image\//i.test(type) && !/^image\/(jpeg|png|webp|gif)$/i.test(type)) return null;
      return {
        id: text(entry.id, 64) || uid(),
        name: text(entry.name || 'ملف مرفق', 200),
        type,
        size: Number(entry.size) > 0 ? Number(entry.size) : base64Size(dataUrl),
        dataUrl,
        createdAt: safeDate(entry.createdAt),
      };
    };

    const normalizeItem = (entry, section) => {
      if (!entry || typeof entry !== 'object') return null;
      return {
        id: text(entry.id, 64) || uid(),
        section,
        title: text(entry.title, 160) || 'بدون عنوان',
        category: text(entry.category, 60),
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || '')) ? String(entry.date) : '',
        description: text(entry.description, 2000),
        tags: Array.isArray(entry.tags)
          ? Array.from(new Set(entry.tags.map((tag) => text(tag, 28)).filter(Boolean))).slice(0, 10)
          : [],
        link: makeUrl(entry.link) || '',
        attachments: (Array.isArray(entry.attachments) ? entry.attachments : [])
          .slice(0, MAX_FILES_PER_ITEM)
          .map(normalizeAttachment)
          .filter(Boolean),
        content: section === 'reports' ? text(entry.content, 12000) : '',
        impact: text(entry.impact, 3000),
        status: section === 'reports' ? (REPORT_STATUSES[entry.status] ? String(entry.status) : 'draft') : '',
        evidenceType: section === 'evidence' ? (EVIDENCE_TYPES[entry.evidenceType] ? String(entry.evidenceType) : 'document') : '',
        linkedAchievementId: section === 'evidence' ? text(entry.linkedAchievementId, 64) : '',
        createdAt: safeDate(entry.createdAt),
        updatedAt: safeDate(entry.updatedAt),
      };
    };

    const workspace = {
      version: 1,
      createdAt: safeDate(source.createdAt),
      updatedAt: now,
      profile,
      achievements: [],
      evidence: [],
      reports: [],
      activity: [],
    };
    Object.keys(SECTIONS).forEach((section) => {
      workspace[section] = (Array.isArray(source[section]) ? source[section] : [])
        .slice(0, 2000)
        .map((entry) => normalizeItem(entry, section))
        .filter(Boolean);
    });

    const achievementIds = new Set(workspace.achievements.map((item) => item.id));
    workspace.evidence.forEach((item) => {
      if (item.linkedAchievementId && !achievementIds.has(item.linkedAchievementId)) item.linkedAchievementId = '';
    });

    workspace.activity = (Array.isArray(source.activity) ? source.activity : [])
      .slice(0, 60)
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        return {
          id: text(entry.id, 64) || uid(),
          kind: text(entry.kind, 24) || 'created',
          section: SECTIONS[entry.section] ? String(entry.section) : '',
          title: text(entry.title, 140),
          at: safeDate(entry.at),
        };
      })
      .filter(Boolean);
    pushActivity(workspace, 'imported');
    return workspace;
  }

  async function handleBackupFile(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      toast('حجم ملف النسخة الاحتياطية أكبر من الحد المسموح (12 م.ب).', 'error');
      return;
    }
    let data;
    try {
      const content = await file.text();
      data = JSON.parse(content);
    } catch {
      toast('تعذّر قراءة الملف. تأكد من اختيار نسخة احتياطية صالحة بصيغة JSON.', 'error');
      return;
    }
    const source = data && typeof data === 'object' && data.workspace && typeof data.workspace === 'object'
      ? data.workspace
      : data;
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || (!source.profile && !Array.isArray(source.achievements) && !Array.isArray(source.evidence) && !Array.isArray(source.reports))) {
      toast('الملف المختار لا يحتوي على نسخة احتياطية صالحة من أثري.', 'error');
      return;
    }

    const incomingCounts = ['achievements', 'evidence', 'reports']
      .map((section) => `${Array.isArray(source[section]) ? source[section].length : 0} ${SECTIONS[section].title}`)
      .join(' · ');
    const confirmed = await confirmDialog({
      title: 'استيراد النسخة الاحتياطية؟',
      message: `تحتوي النسخة على: ${incomingCounts}. سيتم استبدال كل المحتوى الحالي في مساحتك بهذه البيانات. لا يمكن التراجع بعد المتابعة.`,
      confirmLabel: 'استيراد واستبدال',
      iconName: 'import',
      danger: true,
    });
    if (!confirmed) return;

    try {
      const imported = normalizeImportedWorkspace(source);
      Store.saveWorkspace(state.user.id, imported);
      state.workspace = imported;
      state.profile = imported.profile;
      state.user.name = imported.profile.fullName || state.user.name;
      Store.updateAccountName(state.user.id, state.user.name);
      renderShell();
      renderRoute();
      toast('تم استيراد النسخة الاحتياطية واستعادة ملفك بنجاح.', 'success');
    } catch (error) {
      toast(error.message || 'تعذّر استيراد النسخة الاحتياطية.', 'error');
    }
  }

  function importBackup() {
    const input = document.getElementById('backup-file-input');
    if (!input) {
      toast('افتح صفحة الإعدادات أولًا لاختيار ملف النسخة الاحتياطية.', 'info');
      return;
    }
    input.value = '';
    input.click();
  }

  const MAX_WORKSPACE_BYTES_FALLBACK = 4.5 * 1024 * 1024;

  /* ------------------------------------------------------------------ */
  /* الأحداث العامة                                                     */
  /* ------------------------------------------------------------------ */

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const routeButton = target.closest('[data-route]');
    if (routeButton) {
      event.preventDefault();
      navigate(routeButton.dataset.route || 'dashboard');
      return;
    }

    const createButton = target.closest('[data-create-item]');
    if (createButton) {
      event.preventDefault();
      const section = createButton.dataset.createItem;
      if (SECTIONS[section]) openItemForm(section);
      return;
    }

    const viewButton = target.closest('[data-view-item]');
    if (viewButton) {
      event.preventDefault();
      if (viewButton.dataset.section && viewButton.dataset.id) {
        openItemDetail(viewButton.dataset.section, viewButton.dataset.id);
      }
      return;
    }

    const editButton = target.closest('[data-edit-item]');
    if (editButton) {
      event.preventDefault();
      const section = editButton.dataset.section;
      const item = findItem(section, editButton.dataset.id);
      if (item) openItemForm(section, item);
      else toast('لم يعد هذا العنصر موجودًا.', 'error');
      return;
    }

    const deleteButton = target.closest('[data-delete-item]');
    if (deleteButton) {
      event.preventDefault();
      deleteItem(deleteButton.dataset.section, deleteButton.dataset.id);
      return;
    }

    if (target.closest('[data-theme-toggle]')) {
      event.preventDefault();
      toggleTheme();
      return;
    }

    const themeButton = target.closest('[data-set-theme]');
    if (themeButton) {
      event.preventDefault();
      applyTheme(themeButton.dataset.setTheme);
      return;
    }

    if (target.closest('[data-logout]')) {
      event.preventDefault();
      logout();
      return;
    }

    if (target.closest('[data-quick-add]')) {
      event.preventDefault();
      openQuickAdd();
      return;
    }

    if (target.closest('[data-open-sidebar]')) {
      event.preventDefault();
      toggleSidebar(true);
      return;
    }

    if (target.closest('[data-close-sidebar]')) {
      event.preventDefault();
      closeSidebar();
      return;
    }

    if (target.closest('[data-edit-profile]')) {
      event.preventDefault();
      openProfileForm();
      return;
    }

    if (target.closest('[data-change-password]')) {
      event.preventDefault();
      openPasswordModal();
      return;
    }

    if (target.closest('[data-export-backup]')) {
      event.preventDefault();
      exportBackup();
      return;
    }

    if (target.closest('[data-import-backup]')) {
      event.preventDefault();
      importBackup();
      return;
    }

    if (target.closest('[data-print-profile]')) {
      event.preventDefault();
      closeSidebar();
      window.print();
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id !== 'global-search-form') return;
    event.preventDefault();
    const input = $('#global-search', form);
    const query = String(input?.value || '').trim();
    navigate('search', query ? { q: query } : {});
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const key = String(event.key || '').toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'k') {
      if (!state.user || modalStack.length) return;
      const search = document.getElementById('global-search');
      if (!search) return;
      event.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (event.key === 'Escape') {
      const sidebar = document.getElementById('sidebar');
      if (sidebar?.classList.contains('open')) {
        event.preventDefault();
        closeSidebar();
      }
    }
  });

  window.addEventListener('hashchange', () => {
    if (!state.user || !state.workspace) return;
    renderRoute();
  });

  window.addEventListener('storage', (event) => {
    if (!state.user) return;
    if (!event.key || event.key === 'athari.v1.session') {
      const session = Store.getSession();
      if (!session) {
        state.user = null;
        state.workspace = null;
        state.profile = null;
        state.currentRoute = 'dashboard';
        state.filters = {};
        document.getElementById('app-view').hidden = true;
        history.replaceState(null, '', window.location.pathname + window.location.search);
        renderAuth('login');
        document.title = 'أثري | ملف إنجازي الرقمي';
        toast('تم تسجيل الخروج من هذا الحساب في نافذة أخرى.', 'info');
        return;
      }
      if (session.id !== state.user.id) {
        enterApp(session);
        return;
      }
    }
    if (!event.key || event.key === `athari.v1.workspace.${state.user.id}`) {
      try {
        state.workspace = Store.getWorkspace(state.user.id);
        state.profile = state.workspace.profile;
        renderShell();
        renderRoute();
      } catch {
        // تجاهل تحديثًا غير صالح من نافذة أخرى.
      }
    }
  });

  function init() {
    const scrim = document.getElementById('sidebar-scrim');
    if (scrim) scrim.addEventListener('click', closeSidebar);

    if (!Store) {
      hideBoot();
      const authView = document.getElementById('auth-view');
      if (authView) {
        authView.hidden = false;
        authView.innerHTML = `<div class="auth-shell"><section class="auth-panel" style="grid-column:1/-1"><div class="auth-card"><h1 class="auth-title">تعذّر تحميل التطبيق</h1><p class="auth-subtitle">لم تتحمّل طبقة البيانات المحلية. أعد تحميل الصفحة أو استخدم متصفحًا حديثًا.</p></div></section></div>`;
      }
      return;
    }

    try {
      const session = Store.getSession();
      if (session) {
        enterApp(session);
      } else {
        renderAuth('login');
        hideBoot();
      }
    } catch (error) {
      console.error(error);
      renderAuth('login');
      hideBoot();
      toast(error.message || 'تعذّر بدء التطبيق.', 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ===== PART 4 ===== */


})();
