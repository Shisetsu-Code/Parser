import { createHash } from 'node:crypto';
import { findRuntime } from './providers/index.js';
import { summarizeRequest } from './lib/common.js';

function replayDescriptor(control) {
  return {
    kind: control?.kind ?? null,
    name: control?.name ?? null,
    event: control?.event ?? null,
    occurrence: control?.occurrence ?? 0,
    purchaseIndex: control?.purchaseIndex ?? null,
    optionIndex: control?.optionIndex ?? null,
    type: control?.type ?? null,
    active: control?.active ?? null
  };
}

function stateControlKey(control) {
  return JSON.stringify(replayDescriptor(control));
}

function stateSignature(providerId, frameUrl, controls) {
  let path = frameUrl;
  try {
    const u = new URL(frameUrl);
    path = u.hostname + u.pathname;
  } catch {}

  const payload = JSON.stringify({
    provider: providerId,
    frame: path,
    controls: controls.map(stateControlKey).sort()
  });

  return createHash('sha256').update(payload).digest('hex').slice(0, 20);
}

function controlPriority(control) {
  const text = [
    control?.kind,
    control?.name,
    control?.event,
    control?.purchaseIndex,
    control?.optionIndex,
    control?.type
  ].filter(v => v != null).join(' ').toLowerCase();

  let score = 0;
  if (control?.active === true) score += 100;
  if (/(purchase|buy|feature|confirm|rebuy|o_\d|button\d)/i.test(text)) score += 90;
  if (/(intro|continue|start|close|ok)/i.test(text)) score += 45;
  if (/(spin|play)/i.test(text)) score += 30;
  if (control?.active === false) score -= 15;
  return score;
}

function sortControls(controls) {
  return [...controls].sort((a, b) => {
    const p = controlPriority(b) - controlPriority(a);
    if (p) return p;
    return stateControlKey(a).localeCompare(stateControlKey(b));
  });
}

function trafficSignature(requests) {
  const endpoints = [];
  const signals = new Set();

  for (const req of requests) {
    const hay = String(req?.url || '') + ' ' + String(req?.postData || '');
    try {
      endpoints.push(new URL(req.url).pathname);
    } catch {
      endpoints.push(String(req?.url || ''));
    }

    if (/doSpin|action.?[=:].?doSpin|command.?[=:].?(play|spin)/i.test(hay)) signals.add('spin');
    if (/purchased_feature|\bpur(?:chased)?\b|purchase/i.test(hay)) signals.add('purchase');
    if (/doBonus|bonus/i.test(hay)) signals.add('bonus');
    if (/bet/i.test(hay)) signals.add('bet');
  }

  return {
    requestCount: requests.length,
    signals: [...signals],
    endpoints: [...new Set(endpoints)].slice(0, 30)
  };
}

function actionDelay(options) {
  return Math.min(Math.max(Number(options.actionWaitMs) || 600, 300), 1200);
}

async function reacquire(page, expectedProvider, timeoutMs) {
  let runtime = await findRuntime(page, Math.min(timeoutMs, 2500));
  if (!runtime && timeoutMs > 2500) runtime = await findRuntime(page, timeoutMs);
  if (!runtime) return null;
  if (runtime.provider.id !== expectedProvider) return null;
  return runtime;
}

async function openAtPath(browser, url, expectedProvider, path, options) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const network = [];
  const replay = [];

  page.on('request', req => network.push(summarizeRequest(req)));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);

    let runtime = await reacquire(page, expectedProvider, options.timeoutMs);
    if (!runtime) throw new Error('Tree replay: provider runtime not found');

    const frameDemo = await runtime.provider.isDemo(runtime.frame).catch(() => false);
    if (!frameDemo) {
      // The parent runner already restricts top-level URLs to official DEMO/provider
      // hosts. Keep the runtime check here as an extra signal, not as the sole gate.
      replay.push({ warning: 'runtime did not self-identify as demo' });
    }

    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      const before = network.length;
      let press;
      try {
        press = await runtime.provider.pressControl(runtime.frame, step);
      } catch (error) {
        press = { ok: false, reason: String(error?.message || error) };
      }

      await page.waitForTimeout(actionDelay(options));
      const delta = network.slice(before);
      replay.push({
        index: i,
        control: step,
        press,
        traffic: trafficSignature(delta)
      });

      if (!press?.ok) {
        throw new Error('Tree replay failed at step ' + i + ': ' + (press?.reason || 'press failed'));
      }

      runtime = await reacquire(page, expectedProvider, options.timeoutMs);
      if (!runtime) {
        throw new Error('Tree replay lost runtime at step ' + i);
      }
    }

    return { context, page, network, replay, ...runtime };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function runTreeCrawler(browser, url, expectedProvider, options) {
  const maxDepth = Math.max(1, Number(options.treeMaxDepth) || 4);
  const maxStates = Math.max(1, Number(options.treeMaxStates) || 60);
  const maxEdges = Math.max(1, Number(options.treeMaxEdges) || 200);
  const maxControls = Math.max(1, Number(options.treeMaxControls) || 120);

  const tree = {
    provider: expectedProvider,
    limits: { maxDepth, maxStates, maxEdges, maxControls },
    states: [],
    edges: [],
    interestingEdges: [],
    errors: [],
    stats: {
      openedSessions: 0,
      replayFailures: 0,
      dedupedStates: 0
    }
  };

  const seenStates = new Map();
  const scheduledStates = new Set();
  const queue = [{ path: [], depth: 0, predictedSignature: null }];

  while (queue.length && tree.states.length < maxStates && tree.edges.length < maxEdges) {
    const queued = queue.shift();
    let stateSession;

    try {
      stateSession = await openAtPath(browser, url, expectedProvider, queued.path, options);
      tree.stats.openedSessions++;
    } catch (error) {
      tree.stats.replayFailures++;
      tree.errors.push({
        phase: 'open-state',
        depth: queued.depth,
        path: queued.path,
        error: String(error?.message || error)
      });
      continue;
    }

    let controls;
    try {
      controls = sortControls(await stateSession.provider.listControls(stateSession.frame));
    } catch (error) {
      tree.errors.push({
        phase: 'list-controls',
        depth: queued.depth,
        path: queued.path,
        error: String(error?.message || error)
      });
      await stateSession.context.close();
      continue;
    }

    const signature = stateSignature(expectedProvider, stateSession.frame.url(), controls);

    if (seenStates.has(signature)) {
      tree.stats.dedupedStates++;
      await stateSession.context.close();
      continue;
    }

    const stateId = 's' + tree.states.length;
    seenStates.set(signature, stateId);
    scheduledStates.add(signature);

    tree.states.push({
      id: stateId,
      signature,
      depth: queued.depth,
      path: queued.path,
      controlsCount: controls.length,
      controls: controls.slice(0, maxControls).map(replayDescriptor),
      replay: stateSession.replay
    });

    console.log(
      '  tree state=' + stateId +
      ' depth=' + queued.depth +
      ' controls=' + controls.length +
      ' hash=' + signature
    );

    await stateSession.context.close();

    if (queued.depth >= maxDepth) continue;

    const candidates = controls.slice(0, maxControls);

    for (let ci = 0; ci < candidates.length && tree.edges.length < maxEdges; ci++) {
      const control = replayDescriptor(candidates[ci]);
      let edgeSession;

      try {
        edgeSession = await openAtPath(browser, url, expectedProvider, queued.path, options);
        tree.stats.openedSessions++;
      } catch (error) {
        tree.stats.replayFailures++;
        tree.errors.push({
          phase: 'open-edge',
          from: stateId,
          control,
          path: queued.path,
          error: String(error?.message || error)
        });
        continue;
      }

      const before = edgeSession.network.length;
      const started = Date.now();
      let press;

      try {
        press = await edgeSession.provider.pressControl(edgeSession.frame, control);
      } catch (error) {
        press = { ok: false, reason: String(error?.message || error) };
      }

      await edgeSession.page.waitForTimeout(actionDelay(options));
      const delta = edgeSession.network.slice(before);
      const traffic = trafficSignature(delta);

      let childRuntime = null;
      try {
        childRuntime = await reacquire(edgeSession.page, expectedProvider, Math.min(options.timeoutMs, 3000));
      } catch {}

      let childSignature = null;
      let childControlsCount = null;
      let childControls = null;

      if (childRuntime) {
        try {
          childControls = sortControls(await childRuntime.provider.listControls(childRuntime.frame));
          childControlsCount = childControls.length;
          childSignature = stateSignature(expectedProvider, childRuntime.frame.url(), childControls);
        } catch {}
      }

      const edge = {
        id: 'e' + tree.edges.length,
        from: stateId,
        depth: queued.depth + 1,
        control,
        press,
        elapsedMs: Date.now() - started,
        traffic,
        network: delta,
        terminal: !childRuntime,
        toSignature: childSignature,
        childControlsCount
      };

      tree.edges.push(edge);

      if (traffic.requestCount > 0 || traffic.signals.length > 0) {
        tree.interestingEdges.push(edge.id);
      }

      console.log(
        '    tree edge=' + edge.id +
        ' control=' + (control.name ?? control.kind ?? '?') +
        ' ok=' + Boolean(press?.ok) +
        ' req=' + traffic.requestCount +
        ' signals=' + (traffic.signals.join(',') || '-') +
        ' child=' + (childSignature || 'terminal')
      );

      if (
        press?.ok &&
        childSignature &&
        queued.depth + 1 <= maxDepth &&
        childSignature !== signature &&
        !seenStates.has(childSignature) &&
        !scheduledStates.has(childSignature)
      ) {
        scheduledStates.add(childSignature);
        queue.push({
          path: [...queued.path, control],
          depth: queued.depth + 1,
          predictedSignature: childSignature
        });
      }

      await edgeSession.context.close();
    }
  }

  tree.stats.states = tree.states.length;
  tree.stats.edges = tree.edges.length;
  tree.stats.interesting = tree.interestingEdges.length;
  tree.stats.queueRemaining = queue.length;
  return tree;
}
