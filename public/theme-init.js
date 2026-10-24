(function () {
  'use strict';
  try {
    var stored = localStorage.getItem('athari-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#071517' : '#f3f7f7');
  } catch (error) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
