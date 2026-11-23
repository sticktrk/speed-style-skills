#!/usr/bin/env node
// Load the runtime only after answering older Node installations in plain language.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(
    'Speed Styles needs Node.js 22 or later. Ask your AI tool to use a newer Node.js, or install it from https://nodejs.org and try again.',
  );
  process.exitCode = 1;
} else {
  import('./commands.mjs').catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
