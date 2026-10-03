import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { findRuntime } from './providers/index.js';
import { ensureDir, safeName, sleep, summarizeRequest, writeJson } from './lib/common.js';

const DEMO_HOSTS = [
  /(^|\.)3oaks\.com$/i,
  /(^|\.)pragmaticplay\.com$/i,
  /(^|\.)pragmaticplay\.net$/i
];

function permittedTopLevel(url) {
  try { return DEMO_HOSTS.some(rx => rx.test(new URL(url).hostname)); }
  catch { return false; }
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

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const actions = target.actions.length ? target.actions : options.defaultActions;
      const result = await runOne(browser, target.url, actions, options, index + 1, targets.length);
      results.push(result);
    }
  } finally {
    await browser.close();
  }
  return results;
}

function isBuyAllAction(action) {
  return ['buy_all', 'purchase_all'].includes(String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function hasGameplayRequest(requests) {
  return requests.some(req => {
    const hay = String(req?.url || '') + ' ' + String(req?.postData || '');
    return /gameService|gs2c|doSpin|command.?[=:].?(play|spin)|action.?[=:].?doSpin|purchased_feature|\bpur\b/i.test(hay);
  });
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
  page.on('request', req => {
    const u = req.url();
    if (/gameService|doSpin|doBonus|gs2c|spin|bonus|feature|purchase/i.test(u) || req.method() !== 'GET') {
      network.push(summarizeRequest(req));
    }
  });

  const result = {
    option: purchaseOption,
    provider: null,
    press: null,
    spinFallback: null,
    network: [],
    screenshot: null,
    error: null
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);

    const runtime = await findRuntime(page, options.timeoutMs);
    if (!runtime) throw new Error('No supported runtime found for purchase');
    const { provider, frame } = runtime;
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
    await context.close();
  }
  return result;
}

async function runOne(browser, url, actions, options, index, total) {
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
    requests: [],
    error: null
  };

  if (!permittedTopLevel(url)) {
    result.error = 'Blocked by demo-only host allowlist';
    return result;
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const network = [];
  page.on('request', req => {
    const u = req.url();
    if (/gameService|doSpin|doBonus|gs2c|spin|bonus|feature|purchase/i.test(u) || req.method() !== 'GET') {
      network.push(summarizeRequest(req));
    }
  });

  console.log(`\n[${index}/${total}] ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForTimeout(options.settleMs);

    const runtime = await findRuntime(page, options.timeoutMs);
    if (!runtime) throw new Error('No supported runtime found in page/frames');

    const { provider, frame } = runtime;
    result.provider = provider.id;
    result.frameUrl = frame.url();
    const frameDemo = await provider.isDemo(frame);
    const officialDemoPage = permittedTopLevel(url);
    result.demo = Boolean(frameDemo || officialDemoPage);
    if (!result.demo) throw new Error('Runtime found, but demo mode could not be verified');

    result.scan = await provider.scan(frame);
    console.log(`  provider=${provider.id} frame=${frame.url()}`);
    console.log(`  controls=${result.scan?.controls?.length ?? 0}`);

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

    for (const action of actions.filter(action => !isBuyAllAction(action))) {
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
    await writeJson(file, result);
    await context.close();
  }
  return result;
}
