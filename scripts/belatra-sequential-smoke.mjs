#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const games = [
  ['01-20-super-stars', 'https://free-slot.belatragames.com/play/20-super-stars'],
  ['02-3x-super-peppers', 'https://free-slot.belatragames.com/play/3x-super-peppers'],
  ['03-5-wild-wild-peppers', 'https://free-slot.belatragames.com/play/5-wild-wild-peppers'],
  ['04-500-juicy-fruits', 'https://free-slot.belatragames.com/play/500-juicy-fruits'],
  ['05-7-days-spanish-armada', 'https://free-slot.belatragames.com/play/7-days-the-spanish-armada'],
  ['06-88-bingo-88', 'https://free-slot.belatragames.com/play/88-bingo-88'],
  ['07-88-dragons-bounty', 'https://free-slot.belatragames.com/play/88-dragons-bounty'],
  ['08-88-golden-88', 'https://free-slot.belatragames.com/play/88-golden-88'],
  ['09-big-bang', 'https://free-slot.belatragames.com/play/big-bang'],
  ['10-book-of-doom', 'https://free-slot.belatragames.com/play/book-of-doom']
];

const targets = games
  .map(([, url]) => url + ' | tree_all')
  .join('\n') + '\n';

const targetFile = 'targets-belatra-sequential.txt';
await fs.writeFile(targetFile, targets, 'utf8');

console.log('Belatra sequential smoke:');
console.log('- one Chromium process');
console.log('- one BrowserContext');
console.log('- one page');
console.log('- games and tree branches are navigated strictly one at a time');
console.log('- Cloudflare clearance is preserved in the shared context');
console.log('- if a challenge appears, solve it in the visible browser; Parser waits for runtime');

const child = spawn(process.execPath, [
  'src/index.js',
  '--headed',
  '--reuse-context',
  '--targets', targetFile,
  '--timeout', '120000',
  '--settle', '2200',
  '--action-wait', '450',
  '--tree-max-depth', '3',
  '--tree-max-states', '8',
  '--tree-max-edges', '20',
  '--tree-max-controls', '16',
  '--tree-auto-wait', '5000',
  '--tree-quiet', '800',
  '--tree-repeat-limit', '10'
], { stdio: 'inherit' });

child.on('exit', async code => {
  try { await fs.rm(targetFile, { force: true }); } catch {}
  process.exitCode = code ?? 1;
});
