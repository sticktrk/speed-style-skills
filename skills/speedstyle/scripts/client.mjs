import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { savePrivate, uuid } from './files.mjs';

export const apiOrigin = 'https://studio.timds.com';
const siteOrigin = 'https://speed.style';
const versionHeader = { 'X-TimDS-API-Version': '1' };
const statusHelp = {
  401: 'Please sign in again with the email you used for the quiz and a fresh code.',
  403: 'Use the email you entered in the quiz. Open the concept before approving it.',
  404: 'This concept is no longer available. Contact Speed Styles and include the link from your email.',
  409: 'This concept has changed or was already approved. Check its status and keep your local edits.',
  413: 'Your files exceed the size limit. Keep each under 8 MiB and the folder under 25 MiB.',
  429: 'There have been too many attempts. Please wait before trying again.',
};

async function bounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error('The download is too large.');
  }
  let size = 0;
  const entries = [];
  for await (const bytes of response.body ?? []) {
    size += bytes.length;
    if (size > limit) throw Error('The download is too large.');
    entries.push(bytes);
  }
  return Buffer.concat(entries);
}

async function checked(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      statusHelp[response.status] ||
        'Speed Styles could not finish this request (' +
          response.status +
          '). Your local files are safe.',
    );
  }
  return response;
}

async function readSaved(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function customerClient({
  origin = apiOrigin,
  site = siteOrigin,
  state = join(homedir(), '.speedstyle'),
  fetcher = fetch,
} = {}) {
  const credentials = join(state, 'account.json');
  const challenge = join(state, 'code.json');
  async function signedIn() {
    const auth = await readSaved(credentials);
    if (
      !auth ||
      auth.origin !== origin ||
      !auth.accessToken ||
      !Number.isFinite(auth.validUntil) ||
      auth.validUntil <= Date.now()
    )
      return null;
    return auth;
  }
  async function current() {
    const auth = await signedIn();
    if (!auth) throw Error('Sign in with the email you used for your quiz.');
    return auth;
  }
  async function request(
    path,
    { body, authenticated = false, bytes, jsonLimit = 2 * 1024 * 1024 } = {},
  ) {
    const headers = { ...versionHeader };
    if (authenticated) headers.Authorization = 'Bearer ' + (await current()).accessToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(origin + '/api/timds/concepts' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.status === 401 && authenticated) await rm(credentials, { force: true });
    const data = await bounded(await checked(response), bytes ?? jsonLimit);
    return bytes !== undefined ? data : JSON.parse(data.toString('utf8'));
  }
  function idFromUrl(url) {
    const id = url.pathname.match(
      /^\/(?:api\/timds\/)?concepts\/([^/]+)(?:\/files\/index\.html|\/)?$/,
    )?.[1];
    return uuid.test(id) ? id.toLowerCase() : null;
  }
  function reviewUrl(url) {
    return (
      url.origin === site &&
      !url.username &&
      !url.password &&
      /^\/api\/audit\/jobs\/[a-f0-9-]{36}\/concepts\/?(?:[abc]\/?)?$/.test(url.pathname)
    );
  }
  async function identify(input) {
    if (uuid.test(input)) return input.toLowerCase();
    let url = new URL(input);
    if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== site))
      throw Error('Use the viewing link from your ready email.');
    // A preview link supplies an ID. Requests for files and sign-in always go to our configured service.
    const direct = idFromUrl(url);
    if (direct) return direct;
    for (let hop = 0; hop < 4 && reviewUrl(url); hop++) {
      const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        await response.body?.cancel();
        url = new URL(response.headers.get('location'), url);
        continue;
      }
      const html = (await bounded(await checked(response), 512 * 1024)).toString('utf8');
      for (const tag of html.match(/<link\s+[^>]*>/gi) || []) {
        const attrs = Object.fromEntries(
          [...tag.matchAll(/\s([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => [
            match[1].toLowerCase(),
            match[2] ?? match[3],
          ]),
        );
        if (
          attrs.type !== 'application/vnd.timds.concept+json' ||
          !attrs.rel?.toLowerCase().split(/\s+/).includes('alternate') ||
          !attrs.href
        )
          continue;
        const alternate = new URL(attrs.href, url);
        const id = idFromUrl(alternate);
        if (alternate.origin === origin && !alternate.username && !alternate.password && id) return id;
      }
      break;
    }
    throw Error(
      'The concept files are unavailable from this link. Check your signed-in list, or contact Speed Styles from the email.',
    );
  }
  async function sendCode(email) {
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Enter the email you used in the quiz.');
    const result = await request('/auth/code', { body: { email } });
    if (typeof result.challengeId !== 'string' || !result.challengeId)
      throw Error('Please request a fresh code.');
    await savePrivate(challenge, { origin, email, challengeId: result.challengeId });
  }
  async function verifyCode(code) {
    const pending = await readSaved(challenge);
    if (pending?.origin !== origin) throw Error('Ask for a sign-in code first.');
    if (!/^\d{6}$/.test(code.trim())) throw Error('Enter the six digits from your email.');
    const { accessToken, expiresAt } = await request('/auth/verify', {
      body: { email: pending.email, challengeId: pending.challengeId, code: code.trim() },
    });
    const validUntil =
      typeof expiresAt === 'number'
        ? expiresAt < 1e12
          ? expiresAt * 1000
          : expiresAt
        : Date.parse(expiresAt);
    if (
      typeof accessToken !== 'string' ||
      !accessToken ||
      !Number.isFinite(validUntil) ||
      validUntil <= Date.now()
    )
      throw Error('Sign-in did not finish. Request a fresh code.');
    await savePrivate(credentials, { origin, email: pending.email, accessToken, validUntil });
    await rm(challenge, { force: true });
    return pending.email;
  }
  async function artwork(id, name, message) {
    const { email } = await current();
    if (!uuid.test(id) || !name?.trim() || !message?.trim())
      throw Error('Include your name and describe the artwork you want.');
    const { concept } = await request('/' + id);
    const view = new URL(concept.viewUrl);
    if (view.protocol !== 'https:' || view.username || view.password || idFromUrl(view) !== id)
      throw Error('The concept link is unavailable.');
    const form = new URLSearchParams({
      name,
      email,
      making: 'A change to my brand concept',
      message: message.trim() + '\n\nMy concept: ' + view.href,
    });
    const response = await fetcher(site + '/contact/', {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const reply = JSON.parse((await bounded(await checked(response), 32768)).toString('utf8'));
    if (reply.redirect !== '/contact/sent')
      throw Error('Check with Speed Styles before sending this artwork request again.');
  }
  return {
    origin,
    signedIn,
    identify,
    sendCode,
    verifyCode,
    artwork,
    signOut: () => Promise.all([credentials, challenge].map((path) => rm(path, { force: true }))),
    mine: () => request('/mine', { authenticated: true, jsonLimit: 16 * 1024 * 1024 }),
    manifest: (id) => request('/' + id),
    file: (id, path, size) =>
      request('/' + id + '/files/' + path.split('/').map(encodeURIComponent).join('/'), { bytes: size }),
    approval: (id, body) => request('/' + id + '/approval', { body, authenticated: true }),
  };
}
