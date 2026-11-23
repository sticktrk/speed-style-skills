import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  stat,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customerClient } from '../skills/speedstyle/scripts/client.mjs';
import { approve, hash, pull, review } from '../skills/speedstyle/scripts/files.mjs';
import { preview, signInBrowser } from '../skills/speedstyle/scripts/browser.mjs';

const id = '2b53dacb-92aa-48cb-9fa8-100b813ba086';
const apiOrigin = 'https://studio.example.test';
const site = 'https://speed.example.test';
const viewUrl = 'https://preview.example.test/concepts/' + id + '/files/index.html';
const revision = hash('original');
const readyUrl = site + '/api/audit/jobs/6c01b65e-4969-4c04-92ae-3776d84ea93f/concepts';
const json = (body, status = 200) => Response.json(body, { status });

async function fixture(t) {
  const top = await mkdtemp(join(tmpdir(), 'speedstyle-'));
  t.after(() => rm(top, { recursive: true, force: true }));
  const state = join(top, 'account');
  const folder = join(top, 'My concept');
  const files = new Map(
    Object.entries({
      'index.html':
        '<link rel="stylesheet" href="brand.css"><h1>Lantern</h1><img src="images/mark.png"><a href="pieces/card.html">Card</a>',
      'brand.css':
        ':root { --leaf: #468454; --title: Arial, sans-serif; } h1 {color:var(--leaf);font-family:var(--title)}',
      'pieces/card.html': '<link rel="stylesheet" href="../brand.css"><h1>Lantern</h1>',
      'images/mark.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x1a, 0x0]),
    }).map(([path, data]) => [path, Buffer.from(data)]),
  );
  const manifest = {
    id,
    revision,
    viewUrl,
    state: 'open',
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })),
  };
  const calls = [];
  const approvals = [];
  const fetcher = async (address, init = {}) => {
    const url = new URL(address);
    const body =
      init.body instanceof URLSearchParams
        ? Object.fromEntries(init.body)
        : init.body
          ? JSON.parse(init.body)
          : null;
    const auth = init.headers?.Authorization;
    calls.push({ url: url.href, auth, body, method: init.method || 'GET' });
    if (url.origin === site && url.href === readyUrl)
      return new Response(null, { status: 303, headers: { location: readyUrl + '/a' } });
    if (url.href === readyUrl + '/a')
      return new Response(
        '<link type="application/vnd.timds.concept+json" href="' +
          apiOrigin +
          '/api/timds/concepts/' +
          id +
          '" rel="alternate">',
      );
    if (url.origin === site && url.pathname === '/contact/' && body.name && body.email && body.message)
      return json({ redirect: '/contact/sent' });
    assert.equal(url.origin, apiOrigin);
    assert.equal(init.headers['X-TimDS-API-Version'], '1');
    const route = url.pathname.replace('/api/timds/concepts', '');
    if (route === '/auth/code') return json({ challengeId: 'one' });
    if (route === '/auth/verify')
      return body.code === '012345' && body.email === 'me@example.test' && body.challengeId === 'one'
        ? json({
            accessToken: 'example-access',
            expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
          })
        : json({}, 403);
    if (route === '/auth/logout')
      return auth === 'Bearer example-access' ? json({ revoked: true }) : json({}, 401);
    if (route === '/mine')
      return auth === 'Bearer example-access'
        ? json({ concepts: [manifest], pending: false })
        : json({}, 401);
    if (route === '/' + id) return json({ concept: manifest, viewReceipt: 'viewed' });
    if (route.startsWith('/' + id + '/files/'))
      return new Response(files.get(decodeURIComponent(route.split('/files/')[1])));
    if (route === '/' + id + '/approval') {
      if (auth !== 'Bearer example-access') return json({}, 401);
      if (body.baseRevision !== manifest.revision || body.viewReceipt !== 'viewed') return json({}, 409);
      approvals.push(body);
      return json({ concept: { ...manifest, state: 'approved' } });
    }
    return json({}, 404);
  };
  const api = customerClient({ origin: apiOrigin, site, state, fetcher });
  const login = async () => {
    await api.sendCode('Me@Example.test');
    await api.verifyCode('012345');
  };
  return { top, folder, state, files, api, calls, approvals, manifest, login, fetcher };
}

test('the ready email opens the chosen concept without credentials; offline review and preview keep all edits local', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.api.identify(readyUrl), id);
  assert.equal(await f.api.identify(viewUrl), id);
  await pull(f.folder, id, f.api);
  assert.ok(f.calls.every((call) => !call.auth && call.method === 'GET'));
  const before = f.calls.length;
  const { url, server } = await preview(f.folder, { openBrowser: false });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  assert.match(await (await fetch(url)).text(), /Lantern/);
  const first = await fetch(new URL('pieces/card.html', url));
  assert.match(first.headers.get('content-security-policy'), /script-src 'none'/);
  assert.match(await first.text(), /\.\.\/brand\.css/);
  await writeFile(join(f.folder, 'brand.css'), ':root { --leaf: #0a3317; --title: Georgia, serif; }');
  await writeFile(
    join(f.folder, 'pieces/card.html'),
    '<link rel="stylesheet" href="../brand.css"><h1>Bicycle delivery</h1>',
  );
  await writeFile(join(f.folder, 'new.html'), '<p>Deliveries</p>');
  await unlink(join(f.folder, 'images/mark.png'));
  assert.match(await (await fetch(new URL('brand.css', url))).text(), /#0a3317/);
  assert.equal((await fetch(new URL('.speedstyle/original.json', url))).status, 404);
  const { changes, key } = await review(f.folder);
  assert.deepEqual(
    changes.map(({ path, change }) => [path, change]),
    [
      ['brand.css', 'edited'],
      ['new.html', 'added'],
      ['pieces/card.html', 'edited'],
      ['images/mark.png', 'removed'],
    ],
  );
  assert.match(changes[0].after, /Georgia/);
  await assert.rejects(approve(f.folder, key, f.api), /Sign in/);
  await pull(f.folder, id, f.api); // Opening again preserves the local files.
  assert.equal(before, f.calls.length);
  await f.login();
  assert.deepEqual((await f.api.mine()).concepts, [f.manifest]);
  await approve(f.folder, key, f.api);
  const approved = f.approvals[0];
  assert.equal(approved.viewReceipt, 'viewed');
  assert.equal(approved.baseRevision, revision);
  assert.deepEqual(
    approved.files.map((file) => file.path),
    ['brand.css', 'index.html', 'new.html', 'pieces/card.html'],
  );
  for (const file of approved.files)
    assert.deepEqual(Buffer.from(file.content, 'base64'), await readFile(join(f.folder, file.path)));
});

test('the same approval works without edits, rejects files changed since review and preserves work after a stale base', async (t) => {
  const f = await fixture(t);
  await f.login();
  await pull(f.folder, id, f.api);
  const initial = await review(f.folder);
  await approve(f.folder, initial.key, f.api);
  assert.deepEqual(f.approvals[0], { baseRevision: revision, viewReceipt: 'viewed' });
  await writeFile(join(f.folder, 'brand.css'), 'h1 { color: navy }');
  await assert.rejects(approve(f.folder, initial.key, f.api), /changed after the review/);
  const edited = await review(f.folder);
  f.manifest.revision = hash('already approved');
  await assert.rejects(approve(f.folder, edited.key, f.api), /already approved/);
  assert.equal(await readFile(join(f.folder, 'brand.css'), 'utf8'), 'h1 { color: navy }');
  assert.equal(f.approvals.length, 1);
});

test('an interrupted or corrupt pull leaves the destination empty and a subsequent pull can succeed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    pull(f.folder, id, { ...f.api, file: async () => Buffer.from('incomplete') }),
    /interrupted/,
  );
  assert.deepEqual(await readdir(f.top), []);
  await pull(f.folder, id, f.api);
  await symlink(join(f.top, 'account'), join(f.folder, 'account.json'));
  await assert.rejects(review(f.folder), /link.+account\.json/);
});

test('an unsupported file list cannot write outside the download; existing folders are left intact', async (t) => {
  const f = await fixture(t);
  f.manifest.files[0].path = '../test.html';
  await assert.rejects(pull(f.folder, id, f.api), /unsupported/);
  assert.deepEqual(await readdir(f.top), []);
  await mkdir(f.folder);
  await writeFile(join(f.folder, 'my-file.txt'), 'keep');
  await assert.rejects(pull(f.folder, id, f.api), /already contains/);
  assert.equal(await readFile(join(f.folder, 'my-file.txt'), 'utf8'), 'keep');
});

test('the sign-in window keeps the code in the browser and saves a reusable private credential', async (t) => {
  const f = await fixture(t);
  const { url, server } = await signInBrowser(f.api, { openBrowser: false });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const send = (form, origin) =>
    fetch(url, { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams(form) });
  assert.match(await (await fetch(url)).text(), /Quiz email/);
  assert.equal((await send({ email: 'me@example.test' }, 'https://other.example.test')).status, 403);
  const origin = new URL(url).origin;
  assert.match(await (await send({ email: 'me@example.test' }, origin)).text(), /Email code/);
  assert.equal((await send({ code: '000000' }, origin)).status, 400);
  assert.match(await (await send({ code: '012345' }, origin)).text(), /You are signed in/);
  assert.equal((await stat(join(f.state, 'account.json'))).mode & 0o777, 0o600);
  const reopened = customerClient({ origin: apiOrigin, site, state: f.state, fetcher: f.fetcher });
  assert.equal((await reopened.signedIn()).email, 'me@example.test');
  await reopened.mine();
  await reopened.signOut();
  assert.equal(await reopened.signedIn(), null);
  assert.ok(
    f.calls.some((call) => call.url.endsWith('/auth/logout') && call.auth === 'Bearer example-access'),
  );
});

test('artwork sends only the authorized note and contact details; preview links cannot set the sign-in destination', async (t) => {
  const f = await fixture(t);
  await f.login();
  assert.equal(
    await f.api.identify('https://someone.example.test/concepts/' + id + '/files/index.html'),
    id,
  );
  const before = f.calls.length;
  await f.api.artwork(id, 'Flower Shop', 'Could we try a photograph of the bike?');
  const calls = f.calls.slice(before);
  assert.deepEqual(
    calls.map((call) => call.url),
    [apiOrigin + '/api/timds/concepts/' + id, site + '/contact/'],
  );
  const note = calls.at(-1);
  assert.deepEqual(note.body, {
    name: 'Flower Shop',
    email: 'me@example.test',
    making: 'A change to my brand concept',
    message: 'Could we try a photograph of the bike?\n\nMy concept: ' + viewUrl,
  });
  assert.equal(note.auth, undefined);
});

test('hidden local extras remain private and the helper names unsupported visible files', async (t) => {
  const f = await fixture(t);
  await pull(f.folder, id, f.api);
  await mkdir(join(f.folder, '.editor'));
  await writeFile(join(f.folder, '.editor', 'private.json'), 'private');
  await symlink(f.top, join(f.folder, '.editor-link'));
  await writeFile(join(f.folder, 'pieces', '.DS_Store'), 'settings');
  const { files, changes } = await review(f.folder);
  assert.deepEqual(changes, []);
  assert.ok(files.every((file) => !file.path.split('/').some((part) => part.startsWith('.'))));
  await writeFile(join(f.folder, 'pieces', 'notes.txt'), 'read me');
  await assert.rejects(review(f.folder), /Unsupported file name or type: "pieces\/notes\.txt"/);
});

test('a maximum-size edited approval has no duration cap; ordinary requests remain bounded', async (t) => {
  const f = await fixture(t);
  await f.login();
  let capturedBytes;
  const client = customerClient({
    origin: apiOrigin,
    site,
    state: f.state,
    fetcher: async (url, init) => {
      if (url.endsWith('/approval')) {
        assert.equal(init.signal, undefined);
        capturedBytes = Buffer.byteLength(init.body);
        return json({ concept: { state: 'approved' } });
      }
      assert.ok(init.signal instanceof AbortSignal);
      return f.fetcher(url, init);
    },
  });
  await client.mine();
  const files = [8, 8, 8, 1].map((mib, i) => ({
    path: i + '.webp',
    encoding: 'base64',
    content: Buffer.alloc(mib * 1024 * 1024).toString('base64'),
  }));
  await client.approval(id, { files, viewReceipt: 'viewed', baseRevision: revision });
  assert.ok(capturedBytes > 33 * 1024 * 1024);
});

test('sign-in carries the concept opened from its link, and only for the same service', async (t) => {
  const f = await fixture(t);
  const sent = () => f.calls.findLast((call) => call.url.endsWith('/auth/code')).body;
  await f.api.sendCode('me@example.test');
  assert.deepEqual(sent(), { email: 'me@example.test' });
  await pull(f.folder, id, f.api);
  await f.api.sendCode('me@example.test');
  assert.deepEqual(sent(), { email: 'me@example.test', conceptId: id, viewReceipt: 'viewed' });
  const elsewhere = customerClient({
    origin: 'https://other.example',
    site,
    state: f.state,
    fetcher: async (url, init) => {
      assert.deepEqual(JSON.parse(init.body), { email: 'me@example.test' });
      return json({ challengeId: 'two' });
    },
  });
  await elsewhere.sendCode('me@example.test');
});
