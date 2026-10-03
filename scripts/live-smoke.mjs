import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { discoverCatalog } from '../src/runner.js';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'artifacts-out');

const known = {
  threeoaks: [
    'https://3oaks.com/game/3_aztec_temples'
  ],
  pragmatic: [
    'https://www.pragmaticplay.com/en/games/sweet-craze/?gamelang=en&cur=USD'
  ]
};

const options = {
  timeoutMs: 45_000,
  settleMs: 5_000
};

async function writeTargets(file, urls) {
  const body = urls.map(url => `${url} | tree_all`).join('\n') + '\n';
  await fs.writeFile(file, body, 'utf8');
}

async function stashResults(name) {
  const src = path.join(ROOT, 'results');
  const dst = path.join(OUT, name);
  try {
    await fs.rm(dst, { recursive: true, force: true });
    await fs.rename(src, dst);
  } catch {}
}

function runParser(name, targetFile) {
  console.log(`\n========== ${name} ==========\n`);
  const r = spawnSync(process.execPath, [
    'src/index.js',
    '--headless',
    '--targets', targetFile,
    '--timeout', '45000',
    '--settle', '1800',
    '--action-wait', '500',
    '--tree-max-depth', '4',
    '--tree-max-states', '6',
    '--tree-max-edges', '24',
    '--tree-max-controls', '8'
  ], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  return r.status ?? 1;
}

async function discoverNew() {
  const browser = await chromium.launch({ headless: true });
  try {
    const [three, prag] = await Promise.all([
      discoverCatalog(browser, 'https://3oaks.com/games', options).catch(error => {
        console.error('3Oaks catalog discovery failed:', error.message);
        return [];
      }),
      discoverCatalog(browser, 'https://www.pragmaticplay.com/en/games/', options).catch(error => {
        console.error('Pragmatic catalog discovery failed:', error.message);
        return [];
      })
    ]);

    const norm = url => {
      try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
      } catch {
        return url.replace(/\/$/, '');
      }
    };

    const knownSet = new Set([...known.threeoaks, ...known.pragmatic].map(norm));
    const takeNew = items => items
      .map(x => x.url)
      .filter(url => !knownSet.has(norm(url)))
      .slice(0, 1);

    return {
      threeoaks: takeNew(three),
      pragmatic: takeNew(prag)
    };
  } finally {
    await browser.close();
  }
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

const phaseStatus = {};

await writeTargets('ci-known-3oaks.txt', known.threeoaks);
await fs.rm('results', { recursive: true, force: true });
phaseStatus['known-3oaks'] = runParser('KNOWN / 3OAKS', 'ci-known-3oaks.txt');
await stashResults('known-3oaks');

await writeTargets('ci-known-pragmatic.txt', known.pragmatic);
await fs.rm('results', { recursive: true, force: true });
phaseStatus['known-pragmatic'] = runParser('KNOWN / PRAGMATIC', 'ci-known-pragmatic.txt');
await stashResults('known-pragmatic');

console.log('\n========== DISCOVERING NEW GAMES ==========\n');
const discovered = await discoverNew();
console.log('New 3Oaks:', discovered.threeoaks);
console.log('New Pragmatic:', discovered.pragmatic);
await fs.writeFile(path.join(OUT, 'discovered.json'), JSON.stringify(discovered, null, 2));

if (discovered.threeoaks.length) {
  await writeTargets('ci-new-3oaks.txt', discovered.threeoaks);
  await fs.rm('results', { recursive: true, force: true });
  phaseStatus['new-3oaks'] = runParser('NEW / 3OAKS', 'ci-new-3oaks.txt');
  await stashResults('new-3oaks');
} else {
  phaseStatus['new-3oaks'] = 2;
}

if (discovered.pragmatic.length) {
  await writeTargets('ci-new-pragmatic.txt', discovered.pragmatic);
  await fs.rm('results', { recursive: true, force: true });
  phaseStatus['new-pragmatic'] = runParser('NEW / PRAGMATIC', 'ci-new-pragmatic.txt');
  await stashResults('new-pragmatic');
} else {
  phaseStatus['new-pragmatic'] = 2;
}

await fs.writeFile(path.join(OUT, 'phase-status.json'), JSON.stringify(phaseStatus, null, 2));
console.log('\nPhase status:', phaseStatus);

// Keep CI green so evidence is always uploaded. Individual parser failures are
// recorded in phase-status.json and each results/summary.json.
