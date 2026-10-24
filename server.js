'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { handleApi } = require('./src/api');
const { applySecurityHeaders, sendError } = require('./src/http');
const { DATA_DIR, UPLOAD_DIR } = require('./src/database');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'طريقة الطلب غير مدعومة.');
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, 'مسار غير صالح.');
    return;
  }

  if (decoded.includes('\0')) {
    sendError(res, 400, 'مسار غير صالح.');
    return;
  }

  if (decoded === '/favicon.ico') {
    res.writeHead(302, { Location: '/assets/favicon.svg' });
    res.end();
    return;
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.'))) {
    sendError(res, 404, 'الصفحة غير موجودة.');
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, relative);
  const publicPrefix = PUBLIC_DIR + path.sep;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    sendError(res, 404, 'الصفحة غير موجودة.');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendError(res, 404, 'الصفحة غير موجودة.');
    return;
  }

  if (!stat.isFile()) {
    sendError(res, 404, 'الصفحة غير موجودة.');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';
  const isFont = ext === '.woff2' || ext === '.woff';
  const cacheControl = isHtml
    ? 'no-store'
    : isFont
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600';

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'Last-Modified': stat.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) sendError(res, 500, 'تعذّر قراءة الملف.');
      else res.destroy();
    })
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res);

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    sendError(res, 400, 'طلب غير صالح.');
    return;
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number(error.statusCode) || 500;
      if (status >= 500) {
        console.error(`[${new Date().toISOString()}] API error:`, error);
        sendError(res, 500, 'حدث خطأ غير متوقع. حاول مرة أخرى.');
      } else {
        sendError(res, status, error.message || 'تعذّر إتمام الطلب.', error.extra || {});
      }
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.requestTimeout = 30_000;
server.headersTimeout = 20_000;

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  أثري | ملف إنجازي الرقمي');
  console.log(`  يعمل الآن على: http://${HOST}:${PORT}`);
  console.log(`  قاعدة البيانات: ${DATA_DIR}`);
  console.log(`  المرفقات الخاصة: ${UPLOAD_DIR}`);
  console.log('');
});

function shutdown(signal) {
  console.log(`\nإيقاف الخادم (${signal})...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
