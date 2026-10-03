#!/usr/bin/env node
import { parseArgs, readTargets, writeJson } from './lib/common.js';
import { run } from './runner.js';

const HELP = `
Game Control Parser

Usage:
  npm start -- --targets targets.txt --actions spin
  npm start -- --catalog https://3oaks.com/games --actions spin --max-games 10
  npm start -- --catalog https://www.pragmaticplay.com/en/games/ --actions spin --max-games 10

Target format:
  URL
  URL | spin,buy_feature

Options:
  --targets FILE       target file (default: targets.txt)
  --catalog URL        discover game links from official catalog; repeatable
  --actions LIST       default comma-separated actions
  --max-games N        cap discovered/loaded games
  --headless            run Chromium headless
  --headed              run Chromium visible (default)
  --timeout MS          navigation/runtime timeout (default: 30000)
  --settle MS           wait after navigation (default: 2000)
  --action-wait MS      wait after each press (default: 1200)
  --pause-after-purchase wait for Enter before closing each purchase window
  --hold-after-purchase MS keep each purchase window open for N milliseconds
  --tree-max-depth N    maximum replay path depth (default: 4)
  --tree-max-states N   maximum unique states per game (default: 60)
  --tree-max-edges N    maximum tested branches per game (default: 200)
  --tree-max-controls N maximum controls tested from one state (default: 120)
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP.trim());
    return;
  }

  const targets = await readTargets(options.targets);
  if (!targets.length && !options.catalog.length) {
    console.log(HELP.trim());
    throw new Error('No targets. Add URLs to targets.txt or pass --catalog.');
  }

  const results = await run(options, targets);
  const summary = {
    finishedAt: new Date().toISOString(),
    total: results.length,
    ok: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    games: results.map(r => ({ url: r.url, provider: r.provider, demo: r.demo, error: r.error }))
  };
  await writeJson('results/summary.json', summary);
  console.log(`\nDone: ${summary.ok}/${summary.total} OK`);
  if (summary.failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
