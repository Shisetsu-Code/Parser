#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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

const root = path.resolve('results-belatra-sequential');
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });

function runOne(id, url) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      'src/index.js',
      '--headed',
      '--targets', 'target.txt',
      '--timeout', '30000',
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

    child.on('exit', code => resolve(code ?? 1));
  });
}

let anyFailed = false;

for (const [id, url] of games) {
  console.log('\n===== BEGIN ' + id + ' =====');

  await fs.rm('results', { recursive: true, force: true });
  await fs.writeFile('target.txt', url + ' | tree_all\n', 'utf8');

  // Strictly one Parser/Chromium process at a time.
  // The next game cannot begin until the prior process has exited.
  const code = await runOne(id, url);

  const dest = path.join(root, id);
  await fs.mkdir(dest, { recursive: true });
  try {
    await fs.cp('results', dest, { recursive: true });
  } catch {}
  await fs.writeFile(path.join(dest, 'exit-code.txt'), String(code), 'utf8');

  console.log('===== END ' + id + ' rc=' + code + ' =====');

  if (code !== 0) anyFailed = true;

  // Explicit provider cooldown between complete Chromium sessions.
  await new Promise(resolve => setTimeout(resolve, 2000));
}

process.exitCode = anyFailed ? 1 : 0;
