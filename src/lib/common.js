import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const out = {
    targets: 'targets.txt',
    headless: false,
    defaultActions: [],
    timeoutMs: 30_000,
    settleMs: 2_000,
    actionWaitMs: 1_200,
    pauseAfterPurchase: false,
    holdAfterPurchaseMs: 0,
    treeMaxDepth: 4,
    treeMaxStates: 60,
    treeMaxEdges: 200,
    treeMaxControls: 120,
    catalog: [],
    maxGames: 0
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--targets') out.targets = next();
    else if (a === '--headless') out.headless = true;
    else if (a === '--headed') out.headless = false;
    else if (a === '--actions') out.defaultActions = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '--settle') out.settleMs = Number(next());
    else if (a === '--action-wait') out.actionWaitMs = Number(next());
    else if (a === '--pause-after-purchase') out.pauseAfterPurchase = true;
    else if (a === '--hold-after-purchase') out.holdAfterPurchaseMs = Number(next());
    else if (a === '--tree-max-depth') out.treeMaxDepth = Number(next());
    else if (a === '--tree-max-states') out.treeMaxStates = Number(next());
    else if (a === '--tree-max-edges') out.treeMaxEdges = Number(next());
    else if (a === '--tree-max-controls') out.treeMaxControls = Number(next());
    else if (a === '--catalog') out.catalog.push(next());
    else if (a === '--max-games') out.maxGames = Number(next());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

export async function readTargets(file) {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return [];
  }

  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [url, actionsRaw = ''] = line.split('|').map(s => s.trim());
      const actions = actionsRaw ? actionsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      return { url, actions };
    });
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export function safeName(url) {
  try {
    const u = new URL(url);
    const slug = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return slug.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 100);
  } catch {
    return 'game';
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

export function summarizeRequest(req) {
  let postData = null;
  try { postData = req.postData(); } catch {}
  return {
    at: Date.now(),
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    postData: postData && postData.length <= 16_000 ? postData : (postData ? `${postData.slice(0, 16_000)}…` : null)
  };
}

export function normalizeAction(action) {
  return String(action || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}
