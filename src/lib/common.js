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
    treeAutoWaitMs: 8_000,
    treeQuietMs: 900,
    treeRepeatLimit: 20,
    reuseContext: false,
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
    else if (a === '--tree-auto-wait') out.treeAutoWaitMs = Number(next());
    else if (a === '--tree-quiet') out.treeQuietMs = Number(next());
    else if (a === '--tree-repeat-limit') out.treeRepeatLimit = Number(next());
    else if (a === '--reuse-context') out.reuseContext = true;
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

const SECRET_KEY_RX = /^(?:sid|session|sessionid|session_id|token|auth|authorization|key|mgckey|launch_token|jwt)$/i;

function truncateText(value, max = 64_000) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= max ? text : text.slice(0, max) + '…';
}

export function sanitizeTransportUrl(value) {
  try {
    const u = new URL(String(value));
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_KEY_RX.test(key)) u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return truncateText(value, 8_000);
  }
}

export function sanitizeTransportText(value, max = 64_000) {
  if (value == null) return null;
  const text = String(value);

  // URL-encoded Pragmatic/Belatra-style payloads: preserve semantic fields
  // while redacting reusable credentials/session material.
  if (/(?:^|&)[A-Za-z0-9_]+=[^&]*/.test(text)) {
    try {
      const params = new URLSearchParams(text);
      let recognized = false;
      for (const [key] of params.entries()) {
        recognized = true;
        if (SECRET_KEY_RX.test(key)) params.set(key, '[redacted]');
      }
      if (recognized) return truncateText(params.toString(), max);
    } catch {}
  }

  // JSON payloads: recursively redact obvious credential fields.
  try {
    const parsed = JSON.parse(text);
    const seen = new WeakSet();
    const clean = JSON.stringify(parsed, (key, current) => {
      if (SECRET_KEY_RX.test(String(key))) return '[redacted]';
      if (current && typeof current === 'object') {
        if (seen.has(current)) return '[circular]';
        seen.add(current);
      }
      return current;
    });
    return truncateText(clean, max);
  } catch {}

  return truncateText(
    text
      .replace(/((?:sid|session|token|mgckey|launch_token)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/("(?:sid|session|token|mgckey|launch_token)"\s*:\s*")[^"]+/gi, '$1[redacted]'),
    max
  );
}

export function summarizeRequest(req) {
  let postData = null;
  try { postData = req.postData(); } catch {}
  const url = sanitizeTransportUrl(req.url());
  let endpoint = url;
  try {
    const u = new URL(url);
    endpoint = u.pathname;
  } catch {}

  return {
    at: Date.now(),
    direction: 'request',
    method: req.method(),
    url,
    endpoint,
    resourceType: req.resourceType(),
    postData: sanitizeTransportText(postData, 64_000)
  };
}

export async function summarizeResponse(response) {
  const request = response.request();
  const url = sanitizeTransportUrl(response.url());
  let endpoint = url;
  try {
    const u = new URL(url);
    endpoint = u.pathname;
  } catch {}

  let body = null;
  let bodyUnavailable = null;
  try {
    body = sanitizeTransportText(await response.text(), 128_000);
  } catch (error) {
    bodyUnavailable = String(error?.message || error);
  }

  return {
    at: Date.now(),
    direction: 'response',
    method: request.method(),
    url,
    endpoint,
    status: response.status(),
    contentType: response.headers()['content-type'] || null,
    requestPostData: sanitizeTransportText(request.postData(), 64_000),
    body,
    bodyUnavailable
  };
}

export function normalizeAction(action) {
  return String(action || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}
