#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { writeJson } from '../src/lib/common.js';

const games = [
  ['Gates of Olympus 2500','https://www.pragmaticplay.com/en/games/gates-of-olympus-2500/?cur=USD&gamelang=en'],
  ['Triple Hop Pots','https://www.pragmaticplay.com/en/games/triple-hop-pots/?cur=USD&gamelang=en'],
  ['Helios – Triple Sun','https://www.pragmaticplay.com/en/games/helios-triple-sun/?cur=USD&gamelang=en'],
  ['Eternal Diamonds','https://www.pragmaticplay.com/en/games/eternal-diamonds/?cur=USD&gamelang=en'],
  ['Lucky Drums 88','https://www.pragmaticplay.com/en/games/lucky-drums-88/?cur=USD&gamelang=en'],
  ['Ra vs Osiris','https://www.pragmaticplay.com/en/games/ra-vs-osiris/?cur=USD&gamelang=en'],
  ['Gates of Olympus POP','https://www.pragmaticplay.com/en/games/gates-of-olympus-pop/?cur=USD&gamelang=en'],
  ['Heart of Venus','https://www.pragmaticplay.com/en/games/heart-of-venus/?cur=USD&gamelang=en'],
  ['Eastern Fury','https://www.pragmaticplay.com/en/games/eastern-fury/?cur=USD&gamelang=en'],
  ['Jelly Express','https://www.pragmaticplay.com/en/games/jelly-express/?cur=USD&gamelang=en'],
  ['Fortune of Olympus','https://www.pragmaticplay.com/en/games/fortune-of-olympus/?cur=USD&gamelang=en'],
  ['Sweet Rush Bonanza','https://www.pragmaticplay.com/en/games/sweet-rush-bonanza/?cur=USD&gamelang=en'],
  ['Big Bass Bonanza 1000','https://www.pragmaticplay.com/en/games/big-bass-bonanza-1000/?cur=USD&gamelang=en'],
  ['Gates of Olympus Super Scatter','https://www.pragmaticplay.com/en/games/gates-of-olympus-super-scatter/?cur=USD&gamelang=en'],
  ['Sweet Bonanza Super Scatter','https://www.pragmaticplay.com/en/games/sweet-bonanza-super-scatter/?cur=USD&gamelang=en'],
  ['Gates of Hades','https://www.pragmaticplay.com/en/games/gates-of-hades/?cur=USD&gamelang=en'],
  ['The Dog House Megaways 1000','https://www.pragmaticplay.com/en/games/the-dog-house-megaways-1000/?cur=USD&gamelang=en'],
  ['Starlight Princess Super Scatter','https://www.pragmaticplay.com/en/games/starlight-princess-super-scatter/?cur=USD&gamelang=en'],
  ['Mahjong Wins Super Scatter','https://www.pragmaticplay.com/en/games/mahjong-wins-super-scatter/?cur=USD&gamelang=en'],
  ['Bandit Megaways','https://www.pragmaticplay.com/en/games/bandit-megaways/?cur=USD&gamelang=en']
];

function parsePurInit(text) {
  if (!text) return { present:false, count:null, raw:null, enabled:null };
  const params = new URLSearchParams(text);
  const raw = params.get('purInit');
  const enabledRaw = params.get('purInit_e');
  const enabled = enabledRaw == null ? null : Number(enabledRaw);

  if (raw == null) return { present:false, count:0, raw:null, enabled };

  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}

  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed)) return { present:true, count:parsed.length, raw:decoded.slice(0,4000), enabled };
    if (parsed && Array.isArray(parsed.options)) return { present:true, count:parsed.options.length, raw:decoded.slice(0,4000), enabled };
  } catch {}

  const objectMatches = decoded.match(/\{[^{}]*\}/g);
  if (objectMatches?.length) return { present:true, count:objectMatches.length, raw:decoded.slice(0,4000), enabled };

  const betMatches = decoded.match(/(?:^|[,\[{])\s*bet\s*:/g);
  if (betMatches?.length) return { present:true, count:betMatches.length, raw:decoded.slice(0,4000), enabled };

  return { present:true, count:null, raw:decoded.slice(0,4000), enabled };
}

async function auditRuntime(frame) {
  return frame.evaluate(() => {
    const roots = window.globalRuntime?.sceneRoots || [];
    const featurePurchaseOption = [];
    const featurePurchaseV2 = [];
    const featurePurchaseManager = [];

    if (window.FeaturePurchaseOption) {
      for (let ri=0; ri<roots.length; ri++) {
        let items=[];
        try { items=roots[ri].GetComponentsInChildren(FeaturePurchaseOption,true)||[]; } catch {}
        for (const item of items) {
          try {
            featurePurchaseOption.push({
              root:ri,
              name:item.gameObject?.name ?? null,
              active:item.gameObject?.activeInHierarchy ?? null,
              type:item.type ?? null,
              purchaseIndex:item.purchaseIndex ?? null,
              cost:item.purchaseData?.purchaseCosts?.[Number(item.purchaseIndex)] ?? null,
              available:item.purchaseData?.purchaseOptionIsAvailable?.[Number(item.purchaseIndex)] ?? null
            });
          } catch {}
        }
      }
    }

    if (window.FeaturePurchaseV2) {
      for (let ri=0; ri<roots.length; ri++) {
        let managers=[];
        try { managers=roots[ri].GetComponentsInChildren(FeaturePurchaseV2,true)||[]; } catch {}
        for (const manager of managers) {
          const opts=manager.purchaseOptions||[];
          featurePurchaseV2.push({
            root:ri,
            name:manager.gameObject?.name ?? null,
            active:manager.gameObject?.activeInHierarchy ?? null,
            optionCount:opts.length,
            costs:Array.from(manager.featurePurchaseData?.purchaseCosts || []).slice(0,20),
            availability:Array.from(manager.featurePurchaseData?.purchaseOptionIsAvailable || []).slice(0,20)
          });
        }
      }
    }

    if (window.FeaturePurchaseManager) {
      for (let ri=0; ri<roots.length; ri++) {
        let managers=[];
        try { managers=roots[ri].GetComponentsInChildren(FeaturePurchaseManager,true)||[]; } catch {}
        for (const manager of managers) {
          featurePurchaseManager.push({
            root:ri,
            name:manager.gameObject?.name ?? null,
            active:manager.gameObject?.activeInHierarchy ?? null,
            costs:Array.from(manager.purchaseCosts || []).slice(0,20),
            availability:Array.from(manager.purchaseOptionIsAvailable || []).slice(0,20)
          });
        }
      }
    }

    const purchaseIndices=[...new Set(featurePurchaseOption
      .filter(x => Number(x.type)!==1 && Number.isFinite(Number(x.purchaseIndex)))
      .map(x => Number(x.purchaseIndex)))].sort((a,b)=>a-b);

    const v2Count=Math.max(0,...featurePurchaseV2.map(x=>Number(x.optionCount)||0));
    const managerCount=Math.max(0,...featurePurchaseManager.map(x=>x.costs.length));

    return {
      purchaseIndices,
      optionCount:purchaseIndices.length,
      v2Count,
      managerCount,
      featurePurchaseOption,
      featurePurchaseV2,
      featurePurchaseManager
    };
  });
}

const browser=await chromium.launch({headless:true});
const results=[];

for (let i=0;i<games.length;i++) {
  const [name,url]=games[i];
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const initBodies=[];

  page.on('response', async response => {
    try {
      const req=response.request();
      const post=req.postData()||'';
      if (/gameService/i.test(response.url()) && /(?:^|&)action=doInit(?:&|$)/.test(post)) {
        initBodies.push(await response.text());
      }
    } catch {}
  });

  const row={index:i+1,name,url,error:null,provider:null,frame:null,parser:[],parserCount:null,runtime:null,server:null,verdict:null};

  try {
    console.log(`[${i+1}/${games.length}] ${name}`);
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,30000);
    if (!runtime) throw new Error('runtime not found');
    row.provider=runtime.provider.id;
    row.frame=runtime.frame.url();
    if (runtime.provider.id!=='pragmatic') throw new Error('expected pragmatic, got '+runtime.provider.id);

    row.parser=await runtime.provider.listPurchases(runtime.frame);
    row.parserCount=row.parser.filter(x=>x.available!==false).length;
    row.runtime=await auditRuntime(runtime.frame);

    await page.waitForTimeout(700);
    const server=parsePurInit(initBodies.at(-1) || null);
    row.server=server;

    const comparator =
      Number.isFinite(server.count) ? server.count :
      row.runtime.optionCount > 0 ? row.runtime.optionCount :
      row.runtime.v2Count > 0 ? row.runtime.v2Count :
      row.runtime.managerCount;

    row.verdict = row.parserCount === comparator ? 'PASS' : 'MISMATCH';

    console.log(
      `  parser=${row.parserCount} server=${server.count ?? '-'} runtime=${row.runtime.optionCount}/v2:${row.runtime.v2Count}/mgr:${row.runtime.managerCount} => ${row.verdict}`
    );
  } catch (error) {
    row.error=String(error?.stack || error?.message || error);
    row.verdict='ERROR';
    console.log('  ERROR '+String(error?.message||error));
  } finally {
    results.push(row);
    await context.close();
  }
}

await browser.close();

const summary={
  generatedAt:new Date().toISOString(),
  total:results.length,
  pass:results.filter(x=>x.verdict==='PASS').length,
  mismatch:results.filter(x=>x.verdict==='MISMATCH').length,
  errors:results.filter(x=>x.verdict==='ERROR').length,
  results
};

await writeJson('results/pragmatic-purchase-audit.json',summary);
console.log(`AUDIT DONE pass=${summary.pass} mismatch=${summary.mismatch} errors=${summary.errors}`);
if (summary.mismatch || summary.errors) process.exitCode=1;
