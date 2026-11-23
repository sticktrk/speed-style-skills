#!/usr/bin/env node
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import { customerClient } from './client.mjs';
import { pull, review, approve, localInfo, uuid } from './files.mjs';
import { preview, signInBrowser } from './browser.mjs';

const api = customerClient();
const [action, ...args] = process.argv.slice(2);
const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
async function input(maxLength) {
  let text = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    text += chunk;
    if (text.length > maxLength) throw Error('The input is too long.');
  }
  return text.trim();
}
async function privateCode() {
  if (!process.stdin.isTTY) return input(32);
  const muted = new Writable({
    write(_chunk, _encoding, next) {
      next();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('Six-digit email code (hidden): ');
  try {
    return await prompt.question('');
  } finally {
    prompt.close();
    process.stderr.write('\n');
  }
}
function delivery(url) {
  try {
    const kit = new URL(url);
    if (kit.protocol !== 'https:' || kit.username || kit.password || kit.search || kit.hash) return;
    return { website: kit.href, brandGuide: new URL('llms.txt', kit.href.replace(/\/?$/, '/')).href };
  } catch {
    return;
  }
}
async function mine() {
  const result = await api.mine();
  const concepts = result.concepts.map((item) => ({
    id: item.id,
    state: item.state,
    viewUrl: item.viewUrl,
    expiresAt: item.expiresAt,
    ...(item.delivery?.publicUrl ? { delivery: delivery(item.delivery.publicUrl) } : {}),
  }));
  const deliveries = (result.deliveries ?? []).map((item) => delivery(item.publicUrl)).filter(Boolean);
  return { concepts, pending: Boolean(result.pending), deliveries };
}
async function main() {
  switch (action) {
    case 'signin': {
      const account = await api.signedIn();
      if (account) {
        print('Signed in as ' + account.email);
        return;
      }
      const { url } = await signInBrowser(api);
      print('Enter your quiz email and code in this local window: ' + url);
      break;
    }
    case 'code':
      if (!args[0]) throw Error('Enter the email you used in the quiz.');
      await api.sendCode(args[0]);
      print('Check your email for a six-digit sign-in code.');
      break;
    case 'verify':
      print('Signed in as ' + (await api.verifyCode(await privateCode())));
      break;
    case 'signout':
      await api.signOut();
      print('Signed out of Speed Styles on this machine.');
      break;
    case 'status':
      print(await mine());
      break;
    case 'pull': {
      let id;
      if (args[0]) id = await api.identify(args[0]);
      else {
        const { concepts, pending } = await mine();
        const open = concepts.filter((item) => ['open', 'claimed'].includes(item.state));
        if (open.length !== 1) {
          print(
            open.length
              ? { message: 'Choose a concept to open.', concepts: open }
              : {
                  message: pending
                    ? 'Your concept is being made. We will email you when it is ready.'
                    : 'Check the status of your concepts and your latest Speed Styles email.',
                  concepts,
                },
          );
          return;
        }
        id = open[0].id;
      }
      if (!uuid.test(id)) throw Error('This concept link is invalid.');
      print(await pull(args[1] || join(homedir(), 'Speed Styles', id), id, api));
      break;
    }
    case 'preview':
      if (!args[0]) throw Error('Choose your concept folder.');
      print((await preview(resolve(args[0]))).url);
      break;
    case 'changes': {
      if (!args[0]) throw Error('Choose your concept folder.');
      const { changes, key } = await review(resolve(args[0]));
      print({ changes, reviewKey: key });
      break;
    }
    case 'approve':
      if (!args[0] || !args[1]) throw Error('Show and confirm the changes first.');
      await approve(resolve(args[0]), args[1], api);
      print('Approved. We will email you when your full Design System is ready.');
      break;
    case 'artwork':
      if (!args[0] || !args[1]) throw Error('Include your concept folder and name.');
      await api.artwork((await localInfo(resolve(args[0]))).id, args[1], await input(4000));
      print('Speed Styles received your artwork request.');
      break;
    default:
      throw Error(
        'Choose signin, status, pull, preview, changes, approve, artwork, code, verify or signout.',
      );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
