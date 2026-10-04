import { createHash } from 'node:crypto';
import { bootstrapSupportedPage, findRuntime } from './providers/index.js';
import { summarizeRequest, summarizeResponse } from './lib/common.js';
import { latestPragmaticExchange, classifyPragmaticState } from './protocols/pragmatic.js';

function replayDescriptor(control) {
  return {
    kind: control?.kind ?? null,
    name: control?.name ?? null,
    event: control?.event ?? null,
    occurrence: control?.occurrence ?? 0,
    purchaseIndex: control?.purchaseIndex ?? null,
    optionIndex: control?.optionIndex ?? null,
    type: control?.type ?? null,
    method: control?.method ?? null,
    configKey: control?.configKey ?? null,
    configValue: control?.configValue ?? null,
    economicKind: control?.economicKind ?? null,
    purchaseSubtype: control?.purchaseSubtype ?? null,
    active: control?.active ?? null
  };
}

function stateControlKey(control) {
  const runtimeState = {};
  if (control?.state && typeof control.state === 'object') {
    for (const key of [
      'visible','disabled','enabled','selected','state','text',
      'price','cost','multiplier','value','mode'
    ]) {
      const value = control.state[key];
      if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
        runtimeState[key] = value ?? null;
      }
    }
  }

  return JSON.stringify({
    ...replayDescriptor(control),
    runtimeState
  });
}

function stateSignature(providerId, frameUrl, controls, snapshot = null) {
  let path = frameUrl;
  try {
    const u = new URL(frameUrl);
    path = u.hostname + u.pathname;
  } catch {}

  const payload = JSON.stringify({
    provider: providerId,
    frame: path,
    snapshot,
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
    control?.type,
    control?.method,
    control?.configKey,
    control?.configValue,
    control?.economicKind,
    control?.purchaseSubtype
  ].filter(v => v != null).join(' ').toLowerCase();

  let score = 0;
  if (control?.active === true) score += 100;
  if (/belatra_config|config_lines/i.test(text)) score += 700;
  if (/purchasefeature/i.test(text)) score += 650;
  if (/(purchase|buy|feature|ante|chance|boost|super.?spin|enhanced.?spin|confirm|rebuy|o_\d|button\d)/i.test(text)) score += 300;
  if (/(intro|continue|start|close|ok)/i.test(text)) score += 160;
  if (/(spin|play)/i.test(text)) score += 40;
  if (control?.active === false) score -= 15;
  return score;
}

function snapshotHasPendingPurchase(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  for (const key of ['featurePurchaseIndex', 'purchaseIndex', 'pendingPurchaseIndex']) {
    const value = Number(snapshot[key]);
    if (Number.isFinite(value) && value >= 0) return true;
  }
  return snapshot.pendingPurchase === true;
}

function isSpinControl(control) {
  const name = String(control?.name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const event = String(control?.event || '').toLowerCase();

  if (/evt_datatocode_pressed_spin(?:$|_)/i.test(event)) return true;

  return new Set([
    'spin',
    'spin_button',
    'startspin_button',
    'start_spin_button',
    'play',
    'play_button',
    'startplay_button',
    'start_play_button'
  ]).has(name);
}

function isFeatureishControl(control) {
  const text = [
    control?.kind,
    control?.name,
    control?.event,
    control?.method,
    control?.purchaseIndex,
    control?.optionIndex,
    control?.economicKind,
    control?.purchaseSubtype
  ].filter(v => v != null).join(' ').toLowerCase();

  return /(purchase|buy|feature|bonus|free.?spin|ante|chance|boost|super.?spin|enhanced.?spin|confirm|rebuy|o_\d|button\d)/i.test(text);
}

function pathHasFeatureish(path) {
  return Array.isArray(path) && path.some(isFeatureishControl);
}

function sortControls(controls, snapshot = null) {
  const pendingPurchase = snapshotHasPendingPurchase(snapshot);
  return [...controls].sort((a, b) => {
    if (pendingPurchase) {
      const spinDelta = Number(isSpinControl(b)) - Number(isSpinControl(a));
      if (spinDelta) return spinDelta;
    }
    const p = controlPriority(b) - controlPriority(a);
    if (p) return p;
    return stateControlKey(a).localeCompare(stateControlKey(b));
  });
}

function isGameplayResponse(response) {
  try {
    const request = response.request();
    const url = response.url();
    const post = request.postData() || '';
    return (
      /gameService|\/gs2c\/|\/game(?:$|\?)|\/api(?:\/|$)|spin|bonus|feature|purchase/i.test(url) ||
      /(?:^|[&?{,\s])(action|command|pur|purchased_feature|bet|q)[=:"']/i.test(post) ||
      request.method() !== 'GET' && /demo\.|pragmatic|bgaming|bltrm|3oaks/i.test(url)
    );
  } catch {
    return false;
  }
}

function attachResponseCapture(page, responses, tasks) {
  const handler = response => {
    if (!isGameplayResponse(response)) return;
    const task = summarizeResponse(response)
      .then(summary => responses.push(summary))
      .catch(() => {})
      .finally(() => tasks.delete(task));
    tasks.add(task);
  };
  page.on('response', handler);
  return handler;
}

async function flushResponseTasks(tasks) {
  if (!tasks?.size) return;
  await Promise.allSettled([...tasks]);
}

function trafficSignature(requests) {
  const endpoints = [];
  const signals = new Set();
  let actionRequestCount = 0;

  for (const req of requests) {
    const url = String(req?.url || '');
    const body = String(req?.postData || '');
    const method = String(req?.method || 'GET').toUpperCase();

    try {
      endpoints.push(new URL(url).pathname);
    } catch {
      endpoints.push(url);
    }

    const combined = body + ' ' + url;
    const actionish =
      /gameService|doSpin|doBonus/i.test(url) ||
      /(?:^|[&?{,\s])(command|action|pur|purchased_feature|bet)[=:"']/i.test(body) ||
      /(?:doSpin|doBonus|purchased_feature)/i.test(body);

    if (!actionish) continue;
    actionRequestCount++;

    if (/doSpin|action.?[=:].?doSpin|command.?[=:].?(play|spin)/i.test(combined)) signals.add('spin');
    if (
      /purchased_feature|(?:^|[&?{,\s])pur(?:chased)?[=:"']|command.?[=:"'].*purchase/i.test(body) ||
      /(?:ante(?:_?bet)?|bonus_?chance|double_?chance|feature_?bet|extra_?bet|booster|super_?spin|enhanced_?spin)[=:"'&?]/i.test(body + ' ' + url)
    ) signals.add('purchase');
    if (/doBonus|command.?[=:"'].*bonus/i.test(body + ' ' + url)) signals.add('bonus');
    if (/(?:^|[&?{,\s])bet[=:"']/i.test(body)) signals.add('bet');
  }

  return {
    requestCount: requests.length,
    actionRequestCount,
    signals: [...signals],
    endpoints: [...new Set(endpoints)].slice(0, 30)
  };
}

function semanticControlKey(control) {
  return [
    control?.kind ?? '',
    control?.name ?? '',
    control?.event ?? '',
    control?.purchaseIndex ?? '',
    control?.optionIndex ?? '',
    control?.type ?? '',
    control?.method ?? '',
    control?.configKey ?? '',
    control?.configValue ?? '',
    control?.economicKind ?? '',
    control?.purchaseSubtype ?? ''
  ].map(String).join('|');
}

function dedupeControlsForExploration(controls, snapshot = null) {
  const chosen = new Map();
  for (const control of controls) {
    const key = semanticControlKey(control);
    const previous = chosen.get(key);
    if (!previous || (control?.active === true && previous?.active !== true)) {
      chosen.set(key, control);
    }
  }
  return sortControls([...chosen.values()], snapshot);
}

function controlIdentity(control) {
  return [
    control?.kind ?? '',
    control?.name ?? '',
    control?.event ?? '',
    control?.purchaseIndex ?? '',
    control?.optionIndex ?? '',
    control?.type ?? '',
    control?.method ?? '',
    control?.configKey ?? '',
    control?.configValue ?? '',
    control?.economicKind ?? '',
    control?.purchaseSubtype ?? ''
  ].map(String).join('|');
}

function controlAvailable(controls, wanted) {
  const id = controlIdentity(wanted);
  const matches = controls.filter(control => controlIdentity(control) === id);
  if (!matches.length) return false;
  if (wanted?.active === true) return matches.some(control => control?.active === true);
  return true;
}

async function readStateSnapshot(provider, frame) {
  if (typeof provider?.stateSnapshot !== 'function') return null;
  try {
    const snapshot = await provider.stateSnapshot(frame);
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

async function readProtocolCursor(provider, frame) {
  if (typeof provider?.protocolCursor !== 'function') return null;
  try {
    const value = await provider.protocolCursor(frame);
    return Number.isFinite(Number(value)) ? Number(value) : null;
  } catch {
    return null;
  }
}

async function readProtocolEvents(provider, frame, since = null) {
  if (since == null || typeof provider?.protocolEvents !== 'function') return [];
  try {
    const events = await provider.protocolEvents(frame, since);
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

async function observeControls(provider, frame, page, timeoutMs = 3000) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  let best = [];
  let lastSignature = null;
  let stable = 0;

  while (Date.now() < deadline) {
    let controls = [];
    try {
      controls = sortControls(await provider.listControls(frame));
    } catch {}

    if (controls.length >= best.length) best = controls;

    const sig = controls.map(stateControlKey).sort().join('\n');
    if (controls.length && sig === lastSignature) stable++;
    else stable = 0;
    lastSignature = sig;

    if (controls.length && stable >= 2) return controls;
    await page.waitForTimeout(180);
  }

  return best;
}

async function waitForControl(provider, frame, page, wanted, timeoutMs = 3000) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  while (Date.now() < deadline) {
    let controls = [];
    try { controls = await provider.listControls(frame); } catch {}
    if (controlAvailable(controls, wanted)) return true;
    await page.waitForTimeout(180);
  }
  return false;
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

async function captureRuntimeState(runtime) {
  if (!runtime) {
    return {
      runtime: null,
      controls: null,
      snapshot: null,
      signature: null
    };
  }

  let controls = [];
  try { controls = await runtime.provider.listControls(runtime.frame); } catch {}
  const snapshot = await readStateSnapshot(runtime.provider, runtime.frame);
  controls = sortControls(controls || [], snapshot);

  return {
    runtime,
    controls,
    snapshot,
    signature: stateSignature(runtime.provider.id, runtime.frame.url(), controls, snapshot)
  };
}

async function settleAutomaticActivity(page, network, expectedProvider, options, initialState = null, initialProtocolCursor = null) {
  const maxWaitMs = Math.max(500, Number(options.treeAutoWaitMs) || 8000);
  const quietMs = Math.max(300, Number(options.treeQuietMs) || 900);
  const pollMs = Math.min(350, Math.max(120, Math.floor(quietMs / 4)));

  const started = Date.now();
  let lastActivityAt = Date.now();
  let lastActionRequestCount = trafficSignature(network).actionRequestCount;
  let lastProtocolCursor = initialProtocolCursor;
  let current = initialState;
  let lastSignature = current?.signature ?? null;
  const transitions = [];

  while (Date.now() - started < maxWaitMs) {
    await page.waitForTimeout(pollMs);

    let runtime = null;
    try { runtime = await reacquire(page, expectedProvider, Math.min(options.timeoutMs, 1800)); } catch {}

    if (!runtime) {
      return {
        ...current,
        runtime: null,
        terminal: true,
        waitedMs: Date.now() - started,
        transitions
      };
    }

    const next = await captureRuntimeState(runtime);
    const actionRequestCount = trafficSignature(network).actionRequestCount;
    const protocolCursor = await readProtocolCursor(runtime.provider, runtime.frame);
    const networkChanged = actionRequestCount !== lastActionRequestCount;
    const protocolChanged =
      protocolCursor != null &&
      lastProtocolCursor != null &&
      protocolCursor !== lastProtocolCursor;
    const stateChanged = next.signature !== lastSignature;

    if (networkChanged || protocolChanged || stateChanged) {
      transitions.push({
        atMs: Date.now() - started,
        actionRequestCount,
        signature: next.signature,
        networkChanged,
        protocolChanged,
        protocolCursor,
        stateChanged
      });
      lastActivityAt = Date.now();
      lastActionRequestCount = actionRequestCount;
      if (protocolCursor != null) lastProtocolCursor = protocolCursor;
      lastSignature = next.signature;
      current = next;
    } else if (!current) {
      current = next;
      lastSignature = next.signature;
    }

    if (Date.now() - lastActivityAt >= quietMs) {
      return {
        ...current,
        terminal: false,
        waitedMs: Date.now() - started,
        transitions
      };
    }
  }

  return {
    ...current,
    terminal: !current?.runtime,
    waitedMs: Date.now() - started,
    transitions,
    timedOut: true
  };
}

async function openAtPath(browser, url, expectedProvider, path, options, sharedSession = null) {
  const ownsContext = !sharedSession;
  const context = sharedSession?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = sharedSession?.page ?? await context.newPage();
  const network = [];
  const responses = [];
  const responseTasks = new Set();
  const replay = [];
  const onRequest = req => network.push(summarizeRequest(req));
  const onResponse = attachResponseCapture(page, responses, responseTasks);

  page.on('request', onRequest);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);
    await bootstrapSupportedPage(page);

    let runtime = await reacquire(page, expectedProvider, options.timeoutMs);
    if (!runtime) throw new Error('Tree replay: provider runtime not found');

    await observeControls(runtime.provider, runtime.frame, page, Math.min(options.timeoutMs, 4500));

    const frameDemo = await runtime.provider.isDemo(runtime.frame).catch(() => false);
    if (!frameDemo) {
      // The parent runner already restricts top-level URLs to official DEMO/provider
      // hosts. Keep the runtime check here as an extra signal, not as the sole gate.
      replay.push({ warning: 'runtime did not self-identify as demo' });
    }

    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      await waitForControl(runtime.provider, runtime.frame, page, step, Math.min(options.timeoutMs, 3500));
      const before = network.length;
      const beforeResponses = responses.length;
      const protocolBefore = await readProtocolCursor(runtime.provider, runtime.frame);
      let press;
      try {
        press = await runtime.provider.pressControl(runtime.frame, step);
      } catch (error) {
        press = { ok: false, reason: String(error?.message || error) };
      }

      await page.waitForTimeout(actionDelay(options));
      await flushResponseTasks(responseTasks);
      const delta = network.slice(before);
      const responseDelta = responses.slice(beforeResponses);
      const protocol = await readProtocolEvents(runtime.provider, runtime.frame, protocolBefore);
      replay.push({
        index: i,
        control: step,
        press,
        traffic: trafficSignature(delta),
        network: delta,
        responses: responseDelta,
        protocol
      });

      if (!press?.ok) {
        throw new Error('Tree replay failed at step ' + i + ': ' + (press?.reason || 'press failed'));
      }

      runtime = await reacquire(page, expectedProvider, options.timeoutMs);
      if (!runtime) {
        throw new Error('Tree replay lost runtime at step ' + i);
      }
      await observeControls(runtime.provider, runtime.frame, page, Math.min(options.timeoutMs, 2500));
    }

    await flushResponseTasks(responseTasks);
    return {
      context,
      page,
      network,
      responses,
      responseTasks,
      replay,
      ownsContext,
      onRequest,
      onResponse,
      ...runtime
    };
  } catch (error) {
    await flushResponseTasks(responseTasks);
    try { page.off('request', onRequest); } catch {}
    try { page.off('response', onResponse); } catch {}
    if (ownsContext) await context.close();
    throw error;
  }
}

async function disposeTreeSession(session) {
  if (!session) return;
  await flushResponseTasks(session.responseTasks);
  try { session.page?.off('request', session.onRequest); } catch {}
  try { session.page?.off('response', session.onResponse); } catch {}
  if (session.ownsContext) {
    await session.context.close().catch(() => {});
  }
}

export async function runTreeCrawler(browser, url, expectedProvider, options, sharedSession = null) {
  const maxDepth = Math.max(1, Number(options.treeMaxDepth) || 4);
  const maxStates = Math.max(1, Number(options.treeMaxStates) || 60);
  const maxEdges = Math.max(1, Number(options.treeMaxEdges) || 200);
  const maxControls = Math.max(1, Number(options.treeMaxControls) || 120);
  const repeatLimit = Math.max(0, Number(options.treeRepeatLimit) || 20);

  const tree = {
    provider: expectedProvider,
    sessionMode: sharedSession ? 'shared-context-page' : 'fresh-context-per-branch',
    limits: {
      maxDepth,
      maxStates,
      maxEdges,
      maxControls,
      autoWaitMs: Math.max(500, Number(options.treeAutoWaitMs) || 8000),
      quietMs: Math.max(300, Number(options.treeQuietMs) || 900),
      repeatLimit
    },
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
      stateSession = await openAtPath(browser, url, expectedProvider, queued.path, options, sharedSession);
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
      controls = await observeControls(stateSession.provider, stateSession.frame, stateSession.page, Math.min(options.timeoutMs, 4500));
    } catch (error) {
      tree.errors.push({
        phase: 'list-controls',
        depth: queued.depth,
        path: queued.path,
        error: String(error?.message || error)
      });
      await disposeTreeSession(stateSession);
      continue;
    }

    const snapshot = await readStateSnapshot(stateSession.provider, stateSession.frame);
    controls = sortControls(controls, snapshot);
    const signature = stateSignature(expectedProvider, stateSession.frame.url(), controls, snapshot);

    if (seenStates.has(signature)) {
      tree.stats.dedupedStates++;
      await disposeTreeSession(stateSession);
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
      snapshot,
      replay: stateSession.replay
    });

    console.log(
      '  tree state=' + stateId +
      ' depth=' + queued.depth +
      ' controls=' + controls.length +
      ' hash=' + signature
    );

    await disposeTreeSession(stateSession);

    if (queued.depth >= maxDepth) continue;

    const candidates = dedupeControlsForExploration(controls, snapshot).slice(0, maxControls);

    for (let ci = 0; ci < candidates.length && tree.edges.length < maxEdges; ci++) {
      const control = replayDescriptor(candidates[ci]);
      let edgeSession;

      try {
        edgeSession = await openAtPath(browser, url, expectedProvider, queued.path, options, sharedSession);
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
      const beforeResponses = edgeSession.responses?.length ?? 0;
      const protocolBefore = await readProtocolCursor(edgeSession.provider, edgeSession.frame);
      const started = Date.now();
      let press;

      try {
        press = await edgeSession.provider.pressControl(edgeSession.frame, control);
      } catch (error) {
        press = { ok: false, reason: String(error?.message || error) };
      }

      await edgeSession.page.waitForTimeout(actionDelay(options));

      let childRuntime = null;
      try {
        childRuntime = await reacquire(edgeSession.page, expectedProvider, Math.min(options.timeoutMs, 3000));
      } catch {}

      let childState = await captureRuntimeState(childRuntime);
      let delta = edgeSession.network.slice(before);
      let traffic = trafficSignature(delta);
      let protocol = await readProtocolEvents(
        childRuntime?.provider ?? edgeSession.provider,
        childRuntime?.frame ?? edgeSession.frame,
        protocolBefore
      );

      const initialStateChanged = Boolean(childState.signature && childState.signature !== signature);
      const shouldObserveAutomatic =
        press?.ok &&
        (
          traffic.actionRequestCount > 0 ||
          protocol.length > 0 ||
          initialStateChanged ||
          isFeatureishControl(control) ||
          pathHasFeatureish(queued.path)
        );

      let automatic = null;
      if (shouldObserveAutomatic && childRuntime) {
        automatic = await settleAutomaticActivity(
          edgeSession.page,
          edgeSession.network,
          expectedProvider,
          options,
          childState,
          protocolBefore
        );
        childState = automatic;
        childRuntime = automatic.runtime;
        delta = edgeSession.network.slice(before);
        traffic = trafficSignature(delta);
        protocol = await readProtocolEvents(
          childRuntime?.provider ?? edgeSession.provider,
          childRuntime?.frame ?? edgeSession.frame,
          protocolBefore
        );
      }

      await flushResponseTasks(edgeSession.responseTasks);
      const responseDelta = (edgeSession.responses || []).slice(beforeResponses);

      const continuations = [];
      const featureContext =
        pathHasFeatureish(queued.path) ||
        isFeatureishControl(control) ||
        snapshotHasPendingPurchase(snapshot) ||
        snapshotHasPendingPurchase(childState.snapshot);

      if (
        repeatLimit > 0 &&
        press?.ok &&
        isSpinControl(control) &&
        featureContext &&
        childRuntime
      ) {
        for (let repeatIndex = 0; repeatIndex < repeatLimit; repeatIndex++) {
          const available = controlAvailable(childState.controls || [], control);
          if (!available) break;

          const repeatBefore = edgeSession.network.length;
          let repeatPress;
          try {
            repeatPress = await childRuntime.provider.pressControl(childRuntime.frame, control);
          } catch (error) {
            repeatPress = { ok: false, reason: String(error?.message || error) };
          }

          if (!repeatPress?.ok) {
            continuations.push({
              index: repeatIndex,
              control,
              press: repeatPress,
              traffic: { requestCount: 0, actionRequestCount: 0, signals: [], endpoints: [] }
            });
            break;
          }

          await edgeSession.page.waitForTimeout(actionDelay(options));

          let nextRuntime = null;
          try {
            nextRuntime = await reacquire(edgeSession.page, expectedProvider, Math.min(options.timeoutMs, 3000));
          } catch {}

          let nextState = await captureRuntimeState(nextRuntime);
          const immediateRepeatTraffic = trafficSignature(edgeSession.network.slice(repeatBefore));

          let repeatAutomatic = null;
          if (
            nextRuntime &&
            (
              immediateRepeatTraffic.actionRequestCount > 0 ||
              nextState.signature !== childState.signature
            )
          ) {
            repeatAutomatic = await settleAutomaticActivity(
              edgeSession.page,
              edgeSession.network,
              expectedProvider,
              options,
              nextState
            );
            nextState = repeatAutomatic;
            nextRuntime = repeatAutomatic.runtime;
          }

          const repeatDelta = edgeSession.network.slice(repeatBefore);
          const repeatTraffic = trafficSignature(repeatDelta);

          continuations.push({
            index: repeatIndex,
            control,
            press: repeatPress,
            traffic: repeatTraffic,
            waitedMs: repeatAutomatic?.waitedMs ?? 0,
            transitions: repeatAutomatic?.transitions ?? [],
            toSignature: nextState.signature ?? null
          });

          childState = nextState;
          childRuntime = nextRuntime;

          if (!childRuntime) break;
          if (repeatTraffic.actionRequestCount === 0 && repeatTraffic.signals.length === 0) break;

          // If another interaction replaces the spin/play path, let the normal tree
          // explore that new state instead of forcing more repeats.
          if (!controlAvailable(childState.controls || [], control)) break;
        }

        delta = edgeSession.network.slice(before);
        traffic = trafficSignature(delta);
      }

      const normalizedProtocol =
        expectedProvider === 'pragmatic'
          ? (() => {
              const exchange = latestPragmaticExchange(
                (edgeSession.responses || []).slice(beforeResponses)
              );
              return exchange
                ? {
                    exchange,
                    state: classifyPragmaticState(exchange)
                  }
                : null;
            })()
          : null;

      const childSignature = childState.signature ?? null;
      const childControls = childState.controls ?? null;
      const childControlsCount = childControls?.length ?? null;
      const childSnapshot = childState.snapshot ?? null;

      const edge = {
        id: 'e' + tree.edges.length,
        from: stateId,
        depth: queued.depth + 1,
        control,
        press,
        elapsedMs: Date.now() - started,
        traffic,
        protocol,
        network: delta,
        responses: responseDelta,
        normalizedProtocol,
        terminal: !childRuntime,
        toSignature: childSignature,
        childControlsCount,
        childSnapshot,
        automatic: automatic ? {
          waitedMs: automatic.waitedMs,
          timedOut: Boolean(automatic.timedOut),
          transitions: automatic.transitions
        } : null,
        continuations
      };

      tree.edges.push(edge);

      if (
        traffic.actionRequestCount > 0 ||
        traffic.signals.length > 0 ||
        protocol.length > 0 ||
        childSignature !== signature
      ) {
        tree.interestingEdges.push(edge.id);
      }

      console.log(
        '    tree edge=' + edge.id +
        ' control=' + (control.name ?? control.kind ?? '?') +
        ' kind=' + (control.kind ?? '-') +
        ' method=' + (control.method ?? '-') +
        ' ok=' + Boolean(press?.ok) +
        ' pending=' + (press?.pendingPurchaseIndex ?? childSnapshot?.featurePurchaseIndex ?? '-') +
        ' req=' + traffic.requestCount +
        ' protocol=' + protocol.length +
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
          path: [
            ...queued.path,
            control,
            ...continuations
              .filter(item => item?.press?.ok)
              .map(item => item.control)
          ],
          depth: queued.depth + 1,
          predictedSignature: childSignature
        });
      }

      await disposeTreeSession(edgeSession);
    }
  }

  tree.stats.states = tree.states.length;
  tree.stats.edges = tree.edges.length;
  tree.stats.interesting = tree.interestingEdges.length;
  tree.stats.queueRemaining = queue.length;
  return tree;
}
