import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

export const types = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  }),
);
export const maxFile = 8 * 1024 * 1024;
const maxTotal = 25 * 1024 * 1024;
const privateName = '.speedstyle';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
export const hash = (value) => createHash('sha256').update(value).digest('hex');
const label = (path) => JSON.stringify(String(path).slice(0, 240));
const textual = (path) => /\.(html|css|json|svg)$/i.test(path);

export function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 240 &&
    path
      .split('/')
      .every(
        (part) =>
          /^[a-z\d_][a-z\d._ -]*$/i.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

function checkFileList(files) {
  if (!Array.isArray(files) || files.length > 300) throw Error('A concept can contain up to 300 files.');
  const names = new Map();
  const paths = new Set();
  let size = 0;
  for (const file of files) {
    const path = file.path;
    if (!safePath(path) || !types.has(extname(path).toLowerCase()))
      throw Error('The concept contains an unsupported file name or type: ' + label(path));
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const name = parts.slice(0, index + 1).join('/');
      const key = name.toLowerCase();
      const isFile = index + 1 === parts.length;
      const prior = names.get(key);
      if (prior && (prior.name !== name || prior.isFile || isFile))
        throw Error('This file or folder name overlaps another: ' + label(path));
      names.set(key, { name, isFile });
    }
    paths.add(path);
    if (
      !digest.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > maxFile
    )
      throw Error('This file is too large or has an invalid description: ' + label(path));
    size += file.size;
  }
  if (size > maxTotal) throw Error('Keep the concept under 25 MiB.');
  if (!paths.has('index.html')) throw Error('Your concept needs its index.html welcome page.');
}

export async function savePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), '.' + randomUUID());
  try {
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function localInfo(folder) {
  const info = JSON.parse(await readFile(join(folder, privateName, 'original.json'), 'utf8'));
  if (
    !uuid.test(info.id) ||
    !digest.test(info.revision) ||
    typeof info.viewReceipt !== 'string' ||
    !info.viewReceipt
  )
    throw Error('Open your concept from its link again in a fresh folder.');
  checkFileList(info.files);
  return info;
}

// Directory replacement happens only after every file has passed its digest check.
export async function pull(folder, id, api) {
  folder = resolve(folder);
  const exists = await lstat(folder).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (exists) {
    const info = exists.isDirectory() ? await localInfo(folder).catch(() => null) : null;
    if (info?.id === id && info.origin === api.origin) {
      await api.remember?.(id, info.viewReceipt);
      return folder;
    }
    throw Error('Choose a new folder. This one already contains other work.');
  }
  const { concept, viewReceipt } = await api.manifest(id);
  if (
    concept?.id !== id ||
    !digest.test(concept.revision) ||
    typeof viewReceipt !== 'string' ||
    !viewReceipt
  )
    throw Error('This concept could not be opened. Ask Speed Styles for a fresh link.');
  checkFileList(concept.files);
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(dirname(folder), '.speedstyle-download-'));
  try {
    let next = 0;
    const originals = new Map();
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(6, concept.files.length) }, async () => {
        while (next < concept.files.length) {
          const file = concept.files[next++];
          const bytes = await api.file(id, file.path, file.size);
          if (bytes.length !== file.size || hash(bytes) !== file.sha256)
            throw Error('Your download changed or was interrupted. Open the link again.');
          await mkdir(dirname(join(temp, file.path)), { recursive: true, mode: 0o700 });
          await writeFile(join(temp, file.path), bytes, { flag: 'wx', mode: 0o600 });
          if (textual(file.path)) originals.set(file.path, bytes.toString('utf8'));
        }
      }),
    );
    const failure = results.find((item) => item.status === 'rejected');
    if (failure) throw failure.reason;
    await savePrivate(join(temp, privateName, 'original.json'), {
      id,
      origin: api.origin,
      revision: concept.revision,
      viewReceipt,
      files: concept.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      originals: Object.fromEntries(originals),
    });
    await rename(temp, folder);
    await api.remember?.(id, viewReceipt);
    return folder;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function localFile(folder, path) {
  if (!safePath(path) || !types.has(extname(path).toLowerCase()))
    throw Error('Unsupported file name or type: ' + label(path));
  // Check every component before opening. Never follow a linked folder to a file outside this concept.
  for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    if (!(await lstat(join(folder, parent))).isDirectory())
      throw Error('Keep your concept files together in this folder.');
  }
  const file = await open(
    join(folder, path),
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxFile)
      throw Error('Use an ordinary file under 8 MiB for ' + label(path));
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function review(folder) {
  const info = await localInfo(folder);
  const files = [];
  let total = 0;
  async function walk(parent) {
    for (const entry of await readdir(join(folder, parent), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = parent ? parent + '/' + entry.name : entry.name;
      if (!safePath(path) || entry.isSymbolicLink())
        throw Error('Move this link or unsupported name outside your concept folder: ' + label(path));
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw Error('Use an ordinary file for ' + label(path));
      const bytes = await localFile(folder, path);
      total += bytes.length;
      if (total > maxTotal || files.length >= 300)
        throw Error('Keep your concept under 25 MiB and within 300 files.');
      files.push({ path, size: bytes.length, sha256: hash(bytes), bytes });
    }
  }
  await walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  checkFileList(files);
  const previous = new Map(info.files.map((file) => [file.path, file]));
  const changes = [];
  for (const file of files) {
    const original = previous.get(file.path);
    previous.delete(file.path);
    if (original?.sha256 === file.sha256) continue;
    const change = { path: file.path, change: original ? 'edited' : 'added' };
    if (original && textual(file.path)) {
      const [before, after] = excerpt(info.originals[file.path] ?? '', file.bytes.toString('utf8'));
      Object.assign(change, { before, after });
    }
    changes.push(change);
  }
  for (const path of previous.keys()) changes.push({ path, change: 'removed' });
  const key = hash(
    JSON.stringify([
      info.origin,
      info.id,
      info.revision,
      files.map(({ path, sha256 }) => [path, sha256]),
    ]),
  );
  return { info, files, changes, key };
}

// Show a small piece of the first changed text, including changes within a single long line.
function excerpt(before, after) {
  let first = 0;
  while (first < Math.min(before.length, after.length) && before[first] === after[first]) first++;
  const start = Math.max(0, first - 32);
  return [before, after].map((value) => value.slice(start, first + 160));
}

export async function approve(folder, key, api) {
  const snapshot = await review(folder);
  if (snapshot.key !== key)
    throw Error(
      'Your files changed after the review. Show the updated changes and confirm them before approving.',
    );
  if (snapshot.info.origin !== api.origin)
    throw Error('This concept belongs to a different Speed Styles service.');
  const body = { baseRevision: snapshot.info.revision, viewReceipt: snapshot.info.viewReceipt };
  if (snapshot.changes.length)
    body.files = snapshot.files.map(({ path, bytes }) => ({
      path,
      encoding: 'base64',
      content: bytes.toString('base64'),
    }));
  return api.approval(snapshot.info.id, body);
}
