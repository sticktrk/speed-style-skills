import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { localFile, localInfo, types } from './files.mjs';

function launch(url) {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {}); // The printed local address also works without an OS opener.
  child.unref();
}

async function localServer(handler, { openBrowser = true, timeout } = {}) {
  const prefix = '/' + randomUUID() + '/';
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(origin).host || !req.url?.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    try {
      await handler(req, res, req.url.slice(prefix.length), origin, server);
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Please open the local link again.');
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  const url = origin + prefix;
  if (timeout) {
    const timer = setTimeout(() => server.close(), timeout);
    timer.unref();
    server.once('close', () => clearTimeout(timer));
  }
  if (openBrowser) launch(url);
  return { url, server };
}

export async function preview(folder, options) {
  await localInfo(folder);
  return localServer(async (req, res, raw) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    const path = decodeURIComponent(raw.split('?')[0]) || 'index.html';
    const bytes = await localFile(folder, path).catch(() => null);
    if (!bytes) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'; sandbox allow-same-origin",
    );
    res
      .writeHead(200, { 'Content-Type': types.get(extname(path).toLowerCase()) })
      .end(req.method === 'HEAD' ? undefined : bytes);
  }, options);
}

function escapeHtml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

export function signInBrowser(api, options) {
  let step = 'email';
  function page(res, notice, status = 200) {
    const field =
      step === 'email'
        ? '<label>Quiz email <input type="email" name="email" autocomplete="email" required autofocus></label> <button>Send code</button>'
        : '<label>Email code <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus></label> <button>Sign in</button>';
    res
      .writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Speed Styles</title><main><h1>Sign in to Speed Styles</h1><p role="status">' +
          escapeHtml(notice) +
          '</p>' +
          (step === 'done' ? '' : '<form method="post">' + field + '</form>') +
          '</main></html>',
      );
  }
  return localServer(
    async (req, res, path, origin, server) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      if (path) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET') {
        page(
          res,
          step === 'email'
            ? 'Use the address you gave in the quiz.'
            : 'Enter the six digits we emailed you.',
        );
        return;
      }
      if (
        req.method !== 'POST' ||
        req.headers.origin !== origin ||
        req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
      ) {
        res.writeHead(403).end();
        return;
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2048) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      try {
        if (step === 'email') {
          await api.sendCode(form.get('email') || '');
          step = 'code';
          page(res, 'Enter the six digits we emailed you.');
        } else if (step === 'code') {
          await api.verifyCode(form.get('code') || '');
          step = 'done';
          page(res, 'You are signed in. Close this page and return to your AI tool.');
          server.close();
        } else page(res, 'You are signed in.');
      } catch (error) {
        page(res, error.message, 400);
      }
    },
    { timeout: 12 * 60_000, ...options },
  );
}
