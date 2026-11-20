#!/usr/bin/env node
// Runs the TypeScript CLI directly through tsx; no build step in phase 1.
// node:sqlite is available without a flag from Node 22.13; fail plainly before loading the CLI.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`polycap needs Node 22.13 or later; this is Node ${process.versions.node}. Run: nvm use 22`);
  process.exit(1);
}
const { register } = await import('tsx/esm/api');
register();
await import('../src/cli.ts');
