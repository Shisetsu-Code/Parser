import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from './providers/index.js';
import { runTreeCrawler } from './tree-crawler.js';
import { ensureDir, safeName, sleep, summarizeRequest, summarizeResponse, writeJson } from './lib/common.js';

const DEMO_HOSTS = [
  /(^|\.)3oaks\.com$/i,
  /(^|\.)pragmaticplay\.com$/i,
  /(^|\.)pragmaticplay\.net$/i,
  /(^|\.)bgaming\.com$/i,
  /(^|\.)belatragames\.com$/i,
  /(^|\.)bgaming-network\.com$/i,
  /(^|\.)bltrm\.com$/i
];

function permittedTopLevel(url) {
  try { return DEMO_HOSTS.some(rx => rx.test(new URL(url).hostname)); }
  catch { return false; }
}

async function runtimeDebug(page) {
  const out = [];
  for (const frame of page.frames()) {
    let info = null;
    try {
      info = await frame.evaluate(() => {
        const visible = el => {
          try {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
          } catch { return false; }
        };

        const attrs = el => {
          const out = {};
          for (const a of [...el.attributes]) {
            if (
              /^(href|src|id|class|role|target|onclick)$/i.test(a.name) ||
              /^data-/i.test(a.name)
            ) out[a.name] = String(a.value).slice(0, 500);
          }
          return out;
        };

        const controls = [...document.querySelectorAll('button,a,[role="button"],[tabindex]')]
          .filter(visible)
          .slice(0, 40)
          .map(el => ({
            text: String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 120),
            tag: el.tagName.toLowerCase(),
            attrs: attrs(el)
          }))
          .filter(item => item.text);

        const iframes = [...document.querySelectorAll('iframe')].slice(0, 20).map(el => ({
          src: el.getAttribute('src') || null,
          attrs: attrs(el)
        }));

        return {
          title: document.title,
          canvas: document.querySelectorAll('canvas').length,
          iframe: document.querySelectorAll('iframe').length,
          iframes,
          svg: document.querySelectorAll('svg').length,
          video: document.querySelectorAll('video').length,
          controls,
          bodyText: String(document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500)
        };
      });
    } catch (error) {
      info = { error: String(error?.message || error) };
    }
    out.push({ url: frame.url(), ...info });
  }
  return out;
}

function classifyRuntimeBlock(debug) {
  const text = JSON.stringify(debug || []);
  if (
    /challenges\.cloudflare\.com/i.test(text) ||
    /Performing security verification/i.test(text) ||
    /Checking your Browser/i.test(text) ||
    /"title":"Just a moment\.\.\."/i.test(text)
  ) {
    return 'CI_ACCESS_BLOCK';
  }
  return null;
}


export async function discoverCatalog(browser, catalogUrl, options) {
  if (!permittedTopLevel(catalogUrl)) throw new Error(`Catalog host is not allowed by demo-only mode: ${catalogUrl}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(catalogUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);
    const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(a => a.href));
    const uniq = [...new Set(links)].filter(url => {
      try {
        const u = new URL(url);
        if (/3oaks\.com$/i.test(u.hostname)) return /\/game\//i.test(u.pathname);
        if (/pragmaticplay\.com$/i.test(u.hostname)) return /\/games\//i.test(u.pathname) && !/\/games\/?$/i.test(u.pathname);
      } catch {}
      return false;
    });
    return uniq.map(url => ({ url, actions: [] }));
  } finally {
    await context.close();
  }
}

export async function run(options, initialTargets) {
  const browser = await chromium.launch({ headless: options.headless });
  const results = [];
  let sharedContext = null;
  let sharedPage = null;
  try {
    let targets = [...initialTargets];
    for (const catalog of options.catalog) {
      const found = await discoverCatalog(browser, catalog, options);
      targets.push(...found);
    }

    const deduped = [];
    const seen = new Set();
    for (const target of targets) {
      if (!target?.url || seen.has(target.url)) continue;
      seen.add(target.url);
      deduped.push(target);
    }
    targets = options.maxGames > 0 ? deduped.slice(0, options.maxGames) : deduped;

    if (options.reuseContext) {
      sharedContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      sharedPage = await sharedContext.newPage();
      console.log('Reusing one browser context/page across targets.');
    }

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const actions = target.actions.length ? target.actions : options.defaultActions;
      const sharedSession = sharedContext ? { context: sharedContext, page: sharedPage } : null;
      const result = await runOne(
        browser,
        target.url,
        actions,
        options,
        index + 1,
        targets.length,
        sharedSession
      );
      results.push(result);
    }
  } finally {
    if (sharedContext) await sharedContext.close().catch(() => {});
    await browser.close();
  }
  return results;
}

function isBuyAllAction(action) {
  return ['buy_all', 'purchase_all'].includes(String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function isSweepAction(action) {
  return ['sweep', 'sweep_all', 'fuzz', 'fuzz_all'].includes(String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function isTreeAction(action) {
  return ['tree', 'tree_all', 'crawl', 'crawl_tree', 'tree_crawl'].includes(String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function trafficSignature(requests) {
  const endpoints = [];
  const signals = new Set();

  for (const req of requests) {
    const hay = String(req?.url || '') + ' ' + String(req?.postData || '');
    try {
      const u = new URL(req.url);
      endpoints.push(u.pathname);
    } catch {
      endpoints.push(String(req?.url || ''));
    }

    if (/doSpin|action.?[=:].?doSpin|command.?[=:].?(play|spin)/i.test(hay)) signals.add('spin');
    if (/purchased_feature|\bpur(?:chased)?[=:]/i.test(hay)) signals.add('purchase');
    if (/doBonus|bonus/i.test(hay)) signals.add('bonus');
    if (/bet/i.test(hay)) signals.add('bet');
  }

  return {
    requestCount: requests.length,
    signals: [...signals],
    endpoints: [...new Set(endpoints)].slice(0, 20)
  };
}

function hasGameplayRequest(requests) {
  return requests.some(req => {
    const hay = String(req?.url || '') + ' ' + String(req?.postData || '');
    return /gameService|gs2c|doSpin|command.?[=:].?(play|spin)|action.?[=:].?doSpin|purchased_feature|\bpur\b/i.test(hay);
  });
}

function isGameplayTransport(responseOrRequest) {
  try {
    const request = typeof responseOrRequest.request === 'function'
      ? responseOrRequest.request()
      : responseOrRequest;
    const url = typeof responseOrRequest.url === 'function'
      ? responseOrRequest.url()
      : request.url();
    const method = request.method();
    const post = request.postData() || '';
    return (
      /gameService|\/gs2c\/|\/game(?:$|\?)|\/api(?:\/|$)|spin|bonus|feature|purchase/i.test(url) ||
      /(?:^|[&?{,\s])(action|command|pur|purchased_feature|bet|q)[=:"']/i.test(post) ||
      method !== 'GET' && /demo\.|pragmatic|bgaming|bltrm|3oaks/i.test(url)
    );
  } catch {
    return false;
  }
}

function attachGameplayResponseCapture(page, target, tasks) {
  const handler = response => {
    if (!isGameplayTransport(response)) return;
    const task = summarizeResponse(response)
      .then(summary => target.push(summary))
      .catch(() => {})
      .finally(() => tasks.delete(task));
    tasks.add(task);
  };
  page.on('response', handler);
  return handler;
}

function parsePragmaticPurInit(text) {
  if (!text) return null;

  const params = new URLSearchParams(text);
  const raw = params.get('purInit');
  const enabledRaw = params.get('purInit_e');
  const enabled = enabledRaw == null ? null : Number(enabledRaw);

  if (raw == null) {
    return { count: 0, enabled, options: [] };
  }

  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}

  let parsed = null;
  try { parsed = JSON.parse(decoded); } catch {}

  let options = [];
  if (Array.isArray(parsed)) options = parsed;
  else if (parsed && Array.isArray(parsed.options)) options = parsed.options;
  else {
    const matches = decoded.match(/\{[^{}]*\}/g) || [];
    options = matches.map((value, index) => ({ index, raw: value }));
  }

  return {
    count: options.length,
    enabled,
    options
  };
}

function attachPragmaticPurInitCapture(page) {
  const handler = async response => {
    try {
      const request = response.request();
      const post = request.postData() || '';
      if (!/gameService/i.test(response.url())) return;
      if (!/(?:^|&)action=doInit(?:&|$)/.test(post)) return;

      const parsed = parsePragmaticPurInit(await response.text());
      if (!parsed) return;

      const frame = request.frame();
      await frame.evaluate(value => {
        globalThis.__parserPragmaticPurInit = value;
      }, parsed).catch(() => {});
    } catch {}
  };

  page.on('response', handler);
  return handler;
}

async function settleSweepProvider(provider, frame, page, options, protocolBefore = null) {
  if (provider?.id !== 'belatra') return { waitedMs: 0, transitions: 0 };

  const maxWaitMs = Math.max(1200, Math.min(Number(options.treeAutoWaitMs) || 5000, 8000));
  const quietMs = Math.max(500, Math.min(Number(options.treeQuietMs) || 800, 1400));
  const pollMs = 180;

  const started = Date.now();
  let lastActivityAt = Date.now();
  let lastCursor = protocolBefore;
  let lastSnapshot = null;
  let transitions = 0;

  try {
    if (typeof provider.stateSnapshot === 'function') {
      const snapshot = await provider.stateSnapshot(frame);
      lastSnapshot = JSON.stringify(snapshot ?? null);
    }
  } catch {}

  while (Date.now() - started < maxWaitMs) {
    await page.waitForTimeout(pollMs);

    let cursor = lastCursor;
    try {
      if (typeof provider.protocolCursor === 'function') {
        cursor = await provider.protocolCursor(frame);
      }
    } catch {}

    let snapshotText = lastSnapshot;
    try {
      if (typeof provider.stateSnapshot === 'function') {
        const snapshot = await provider.stateSnapshot(frame);
        snapshotText = JSON.stringify(snapshot ?? null);
      }
    } catch {}

    const cursorChanged =
      cursor != null &&
      lastCursor != null &&
      Number(cursor) !== Number(lastCursor);
    const stateChanged =
      snapshotText != null &&
      lastSnapshot != null &&
      snapshotText !== lastSnapshot;

    if (cursorChanged || stateChanged) {
      transitions++;
      lastActivityAt = Date.now();
      if (cursor != null) lastCursor = cursor;
      if (snapshotText != null) lastSnapshot = snapshotText;
      continue;
    }

    if (Date.now() - lastActivityAt >= quietMs) break;
  }

  return {
    waitedMs: Date.now() - started,
    transitions
  };
}

async function pauseForInspection(message) {
  if (!input.isTTY) {
    console.log('    stdin is not interactive; skipping Enter pause');
    return;
  }
  const rl = createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function runPurchaseFresh(browser, url, expectedProvider, purchaseOption, options) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const network = [];
  const responses = [];
  const responseTasks = new Set();
  page.on('request', req => {
    const u = req.url();
    if (/gameService|doSpin|doBonus|gs2c|spin|bonus|feature|purchase/i.test(u) || req.method() !== 'GET') {
      network.push(summarizeRequest(req));
    }
  });
  const gameplayResponseHandler = attachGameplayResponseCapture(page, responses, responseTasks);
  const pragmaticPurInitHandler = attachPragmaticPurInitCapture(page);

  const result = {
    option: purchaseOption,
    provider: null,
    press: null,
    spinFallback: null,
    network: [],
    responses,
    screenshot: null,
    error: null
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);
    await bootstrapSupportedPage(page);

    const runtime = await findRuntime(page, options.timeoutMs);
    if (!runtime) throw new Error('No supported runtime found for purchase');
    const provider = runtime.provider;
    let frame = runtime.frame;
    result.provider = provider.id;
    if (provider.id !== expectedProvider) throw new Error('Provider changed during purchase reload');

    const frameDemo = await provider.isDemo(frame);
    if (!(frameDemo || permittedTopLevel(url))) throw new Error('Purchase blocked: DEMO mode not verified');
    if (typeof provider.purchase !== 'function') throw new Error('Provider does not implement purchase()');

    const before = network.length;
    result.press = await provider.purchase(frame, purchaseOption.index);
    await page.waitForTimeout(Math.max(options.actionWaitMs, 1200));

    let delta = network.slice(before);
    if (result.press?.ok && result.press?.needsSpin && !hasGameplayRequest(delta)) {
      result.spinFallback = await provider.press(frame, 'spin');
      await page.waitForTimeout(Math.max(options.actionWaitMs, 1200));
      delta = network.slice(before);
    }

    result.network = delta;

    const shotDir = path.join('results', 'screenshots');
    await ensureDir(shotDir);
    const shotName = `${safeName(url)}-buy-${purchaseOption.ordinal ?? purchaseOption.index}.png`;
    const shotPath = path.join(shotDir, shotName);
    await page.screenshot({ path: shotPath, fullPage: true });
    result.screenshot = shotPath;
    console.log(`    screenshot=${shotPath}`);

    if (options.holdAfterPurchaseMs > 0) {
      console.log(`    holding purchase window for ${options.holdAfterPurchaseMs} ms...`);
      await page.waitForTimeout(options.holdAfterPurchaseMs);
    }

    if (options.pauseAfterPurchase) {
      await pauseForInspection('    Purchase window is paused. Press Enter to close it and continue...');
    }
  } catch (error) {
    result.error = String(error?.stack || error?.message || error);
  } finally {
    await Promise.allSettled([...responseTasks]);
    try { page.off('response', gameplayResponseHandler); } catch {}
    try { page.off('response', pragmaticPurInitHandler); } catch {}
    await context.close();
  }
  return result;
}

async function runOne(browser, url, actions, options, index, total, sharedSession = null) {
  const result = {
    url,
    index,
    total,
    startedAt: new Date().toISOString(),
    provider: null,
    frameUrl: null,
    demo: false,
    scan: null,
    actions: [],
    purchaseOptions: [],
    purchases: [],
    sweep: [],
    tree: null,
    requests: [],
    responses: [],
    failureClass: null,
    error: null
  };

  if (!permittedTopLevel(url)) {
    result.error = 'Blocked by demo-only host allowlist';
    return result;
  }

  const ownsContext = !sharedSession;
  const context = sharedSession?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = sharedSession?.page ?? await context.newPage();
  const network = [];
  const onRequest = req => {
    const u = req.url();
    if (/gameService|doSpin|doBonus|gs2c|spin|bonus|feature|purchase/i.test(u) || req.method() !== 'GET') {
      network.push(summarizeRequest(req));
    }
  };
  page.on('request', onRequest);
  const responseTasks = new Set();
  const gameplayResponseHandler = attachGameplayResponseCapture(page, result.responses, responseTasks);
  const pragmaticPurInitHandler = attachPragmaticPurInitCapture(page);

  console.log(`\n[${index}/${total}] ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);
    await bootstrapSupportedPage(page);

    let runtime = await findRuntime(page, Math.min(options.timeoutMs, 3500));
    if (!runtime) {
      result.runtimeDebug = await runtimeDebug(page);
      result.failureClass = classifyRuntimeBlock(result.runtimeDebug);

      if (result.failureClass === 'CI_ACCESS_BLOCK') {
        console.log('  runtime-debug=' + JSON.stringify(result.runtimeDebug));

        if (process.env.CI || options.headless) {
          throw new Error('CI_ACCESS_BLOCK: provider security verification blocked DEMO runtime');
        }

        // Local headed mode: allow the user to complete Cloudflare/Turnstile
        // in the visible browser. Keep the same context so the clearance cookie
        // survives all subsequent tree replays and targets.
        console.log('  security challenge detected; complete it in the browser. Waiting for runtime...');
        result.failureClass = null;
      }

      runtime = await findRuntime(page, options.timeoutMs);
    }

    if (!runtime) {
      result.runtimeDebug = await runtimeDebug(page);
      result.failureClass = classifyRuntimeBlock(result.runtimeDebug);
      console.log('  runtime-debug=' + JSON.stringify(result.runtimeDebug));
      throw new Error('No supported runtime found in page/frames');
    }

    const provider = runtime.provider;
    let frame = runtime.frame;
    result.provider = provider.id;
    result.frameUrl = frame.url();
    const frameDemo = await provider.isDemo(frame);
    const officialDemoPage = permittedTopLevel(url);
    result.demo = Boolean(frameDemo || officialDemoPage);
    if (!result.demo) throw new Error('Runtime found, but demo mode could not be verified');

    result.scan = await provider.scan(frame);
    console.log(`  provider=${provider.id} frame=${frame.url()}`);
    console.log(`  controls=${result.scan?.controls?.length ?? 0}`);

    const treeAll = actions.some(isTreeAction);
    if (treeAll) {
      if (typeof provider.listControls !== 'function' || typeof provider.pressControl !== 'function') {
        throw new Error(`Provider ${provider.id} does not implement control tree crawling`);
      }

      console.log(
        `  tree-crawl depth=${options.treeMaxDepth} states=${options.treeMaxStates} ` +
        `edges=${options.treeMaxEdges} controls/state=${options.treeMaxControls}`
      );

      const treeSharedSession =
        provider.id === 'belatra' || options.reuseContext
          ? { context, page }
          : null;

      result.tree = await runTreeCrawler(browser, url, provider.id, options, treeSharedSession);

      // Tree replay may navigate the shared page. Reacquire the current frame
      // before any subsequent action family uses it.
      if (treeSharedSession) {
        const current = await findRuntime(page, Math.min(options.timeoutMs, 5000)).catch(() => null);
        if (current?.provider?.id === provider.id) frame = current.frame;
      }

      console.log(
        `  tree done states=${result.tree.stats.states} edges=${result.tree.stats.edges} ` +
        `interesting=${result.tree.stats.interesting} replayFailures=${result.tree.stats.replayFailures}`
      );
    }

    const sweepAll = actions.some(isSweepAction);
    if (sweepAll) {
      if (typeof provider.listControls !== 'function' || typeof provider.pressControl !== 'function') {
        throw new Error(`Provider ${provider.id} does not implement control sweep`);
      }

      const controlKey = control => JSON.stringify({
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
        runtimeSource: control?.runtimeSource ?? null,
        runtimeName: control?.runtimeName ?? null,
        runtimeMethod: control?.runtimeMethod ?? null,
        semantic: control?.semantic ?? null,
        active: control?.active ?? null
      });

      const controls = await provider.listControls(frame);
      const seenControls = new Set(controls.map(controlKey));
      console.log(`  sweep-controls=${controls.length}`);
      let sweepFrame = frame;

      for (let controlIndex = 0; controlIndex < controls.length && controlIndex < 250; controlIndex++) {
        const control = controls[controlIndex];
        const before = network.length;
        const protocolBefore =
          typeof provider.protocolCursor === 'function'
            ? await provider.protocolCursor(sweepFrame).catch(() => null)
            : null;
        const started = Date.now();
        let press;

        try {
          press = await provider.pressControl(sweepFrame, control);
        } catch (error) {
          press = { ok: false, reason: String(error?.message || error) };
        }

        await page.waitForTimeout(Math.min(Math.max(options.actionWaitMs, 250), 900));

        let delta = network.slice(before);
        let signature = trafficSignature(delta);
        let protocol =
          protocolBefore != null && typeof provider.protocolEvents === 'function'
            ? await provider.protocolEvents(sweepFrame, protocolBefore).catch(() => [])
            : [];

        const shouldSettle =
          provider.id === 'belatra' &&
          press?.ok &&
          (
            signature.requestCount > 0 ||
            protocol.length > 0 ||
            /^BELATRA_/.test(String(control?.kind || '')) ||
            ['spin', 'buy', 'bonus', 'ante'].includes(String(control?.semantic || ''))
          );

        const settled = shouldSettle
          ? await settleSweepProvider(provider, sweepFrame, page, options, protocolBefore)
          : { waitedMs: 0, transitions: 0 };

        if (shouldSettle) {
          delta = network.slice(before);
          signature = trafficSignature(delta);
          protocol =
            protocolBefore != null && typeof provider.protocolEvents === 'function'
              ? await provider.protocolEvents(sweepFrame, protocolBefore).catch(() => [])
              : [];
        }

        const protocolNames = protocol
          .map(item => item?.payload?.q || item?.payload?.action || item?.payload?.command || null)
          .filter(Boolean);

        const protocolSignals = new Set();
        if (provider.id === 'belatra') {
          for (const name of protocolNames.map(value => String(value).toLowerCase())) {
            if (name === 'start' || name === 'play') protocolSignals.add('spin');
            else if (name === 'saveplayerchoice') protocolSignals.add('pick');
            else if (name === 'finish') protocolSignals.add('finish');
            else if (/buy|purchase/.test(name)) protocolSignals.add('purchase');
          }
        }

        const combinedSignals = [...new Set([...signature.signals, ...protocolSignals])];

        result.sweep.push({
          index: controlIndex,
          control,
          press,
          elapsedMs: Date.now() - started,
          traffic: { ...signature, signals: combinedSignals },
          protocol,
          settled,
          network: delta
        });

        const failureDetail =
          press?.ok === false
            ? ` reason=${press?.reason ?? '-'}` +
              (Array.isArray(press?.availableLineControls)
                ? ` lineControls=${press.availableLineControls.slice(0, 12).join(',') || '-'}`
                : '')
            : '';

        console.log(
          `  sweep[${controlIndex + 1}/${controls.length}] ${control.name ?? '?'} ` +
          `event=${control.event ?? '-'} ok=${Boolean(press?.ok)}` +
          failureDetail + ' ' +
          `requests=${signature.requestCount} protocol=${protocol.length} ` +
          `wait=${settled.waitedMs}ms transitions=${settled.transitions} ` +
          `q=${[...new Set(protocolNames)].join(',') || '-'} ` +
          `signals=${combinedSignals.join(',') || '-'}`
        );

        // If a control navigated away, destroyed the frame or left the game runtime,
        // reload the same DEMO game and continue with the next discovered control.
        let runtimeStillThere = false;
        try {
          runtimeStillThere = Boolean(await findRuntime(page, 1200));
        } catch {}

        if (!runtimeStillThere && controlIndex < controls.length - 1) {
          if (provider.id === 'belatra') {
            console.log('    Belatra runtime left current game; stopping in-place sweep to avoid creating a new demo session');
            break;
          }

          console.log('    runtime lost; reloading game before next control');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
          await page.waitForTimeout(options.settleMs);
          const recovered = await findRuntime(page, options.timeoutMs);
          if (!recovered || recovered.provider.id !== provider.id) {
            throw new Error('Could not recover provider runtime during sweep');
          }
          sweepFrame = recovered.frame;
        }

        // Discover controls exposed by the action we just took (menus, buy-feature
        // options, confirm buttons, etc.) and append only genuinely new states.
        try {
          const discovered = await provider.listControls(sweepFrame);
          const fresh = [];
          for (const candidate of discovered) {
            const key = controlKey(candidate);
            if (seenControls.has(key)) continue;
            seenControls.add(key);
            fresh.push(candidate);
          }

          if (fresh.length) {
            // Explore newly exposed controls immediately while the menu/state that
            // revealed them is still alive. Active controls get first priority.
            fresh.sort((a, b) => Number(b?.active === true) - Number(a?.active === true));
            controls.splice(controlIndex + 1, 0, ...fresh);
            console.log(`    discovered +${fresh.length} controls, prioritizing now (queue=${controls.length})`);
          }
        } catch {}
      }
    }

    const buyAll = actions.some(isBuyAllAction);
    if (buyAll) {
      if (typeof provider.listPurchases !== 'function' || typeof provider.purchase !== 'function') {
        throw new Error(`Provider ${provider.id} does not implement purchase discovery/execution`);
      }

      result.purchaseOptions = await provider.listPurchases(frame);
      console.log(`  purchase-options=${result.purchaseOptions.length}`);

      for (const purchaseOption of result.purchaseOptions) {
        if (purchaseOption.available === false) {
          result.purchases.push({
            option: purchaseOption,
            skipped: true,
            reason: 'option reported unavailable'
          });
          continue;
        }
        console.log(`  buying option ${purchaseOption.ordinal ?? purchaseOption.index}`);
        const purchaseResult = await runPurchaseFresh(browser, url, provider.id, purchaseOption, options);
        result.purchases.push(purchaseResult);
        console.log(`    ok=${Boolean(purchaseResult.press?.ok)} requests=${purchaseResult.network?.length ?? 0} error=${purchaseResult.error ?? '-'}`);
      }
    }

    for (const action of actions.filter(action => !isBuyAllAction(action) && !isSweepAction(action) && !isTreeAction(action))) {
      const before = network.length;
      const started = Date.now();
      const press = await provider.press(frame, action);
      await sleep(options.actionWaitMs);
      const delta = network.slice(before);
      result.actions.push({ action, press, elapsedMs: Date.now() - started, network: delta });
      console.log(`  action=${action} ok=${Boolean(press?.ok)} strategy=${press?.strategy ?? '-'} requests=${delta.length}`);
    }

    result.requests = network;
  } catch (error) {
    result.error = String(error?.stack || error?.message || error);
    console.error(`  ERROR: ${error?.message || error}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    const file = path.join('results', `${String(index).padStart(4, '0')}-${safeName(url)}.json`);
    await Promise.allSettled([...responseTasks]);
    await writeJson(file, result);
    try { page.off('request', onRequest); } catch {}
    try { page.off('response', gameplayResponseHandler); } catch {}
    try { page.off('response', pragmaticPurInitHandler); } catch {}
    if (ownsContext) await context.close();
  }
  return result;
}
