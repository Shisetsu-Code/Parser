#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { writeJson } from '../src/lib/common.js';

const EXCLUDED_SLUGS = new Set([
  // Historical project coverage.
  'sweet-craze','big-bass-mission-fishin','5-lions-reborn','big-bass-amazon-xtreme',
  'big-bass-christmas-bash','chilli-heat-megaways','extra-juicy-megaways',
  'big-bass-hold-spinner-megaways','release-the-kraken-2','bubble-up','fury-of-anubis',
  'the-dog-house-1000','power-of-thor-megaways','release-the-bison','release-the-kraken',
  'zeus-vs-hades-gods-of-war','zeus-vs-hades-250','the-champions','big-bass-vegas-1000',
  'forever-split-megaways','sugar-rush-1000','freya-1000','coven-rising',

  // First 20-game audit.
  'gates-of-olympus-2500','triple-hop-pots','helios-triple-sun','eternal-diamonds',
  'lucky-drums-88','ra-vs-osiris','gates-of-olympus-pop','heart-of-venus','eastern-fury',
  'jelly-express','fortune-of-olympus','sweet-rush-bonanza','big-bass-bonanza-1000',
  'gates-of-olympus-super-scatter','sweet-bonanza-super-scatter','gates-of-hades',
  'the-dog-house-megaways-1000','starlight-princess-super-scatter',
  'mahjong-wins-super-scatter','bandit-megaways'
]);

function slugFromUrl(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() || '';
  } catch {
    return '';
  }
}

function normalizeGameUrl(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.searchParams.set('cur','USD');
  u.searchParams.set('gamelang','en');
  return u.toString();
}

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return () => {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return () => {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffleSeeded(items, seedText) {
  const seed = xmur3(seedText)();
  const random = mulberry32(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parsePurInit(text) {
  if (!text) return { count:null, enabled:null, options:[] };
  const params = new URLSearchParams(text);
  const raw = params.get('purInit');
  const enabledRaw = params.get('purInit_e');
  const enabled = enabledRaw == null ? null : Number(enabledRaw);

  if (raw == null) return { count:0, enabled, options:[] };

  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}

  let parsed = null;
  try { parsed = JSON.parse(decoded); } catch {}

  let options = [];
  if (Array.isArray(parsed)) options = parsed;
  else if (parsed && Array.isArray(parsed.options)) options = parsed.options;
  else {
    const matches = decoded.match(/\{[^{}]*\}/g) || [];
    options = matches.map((value,index)=>({index,raw:value}));
  }

  return { count:options.length, enabled, options };
}

const CANDIDATE_SLUGS = [
  'sweet-bonanza',
  'gates-of-olympus',
  'starlight-princess',
  'fruit-party',
  'fruit-party-2',
  'sugar-rush',
  'sugar-rush-xmas',
  'sweet-bonanza-xmas',
  'the-dog-house-megaways',
  'big-bass-bonanza',
  'big-bass-splash',
  'big-bass-hold-spinner',
  'big-bass-floats-my-boat',
  'big-bass-boxing-bonus-round',
  'bigger-bass-bonanza',
  'big-bass-bonanza-keeping-it-reel',
  'big-bass-halloween',
  'buffalo-king-megaways',
  'great-rhino-megaways',
  'madame-destiny-megaways',
  'wild-west-gold',
  'wild-west-gold-blazing-bounty',
  'floating-dragon',
  'floating-dragon-megaways',
  'gems-bonanza',
  'pyramid-bonanza',
  'john-hunter-and-the-book-of-tut',
  'john-hunter-and-the-tomb-of-the-scarab-queen',
  'john-hunter-and-the-aztec-treasure',
  'mustang-gold',
  'wolf-gold',
  'hot-fiesta',
  'chilli-heat',
  'aztec-gems',
  'fire-88',
  '888-dragons',
  'vampires-vs-wolves',
  'cash-elevator',
  'empty-the-bank',
  'hand-of-midas',
  'rise-of-giza-powernudge',
  'north-guardians',
  'bounty-gold',
  'diamond-strike',
  'money-mouse',
  'wild-beach-party',
  'wild-booster',
  'queen-of-gods',
  'spirit-of-adventure',
  'mysterious',
  'wild-wild-riches',
  'wild-wild-riches-megaways',
  'the-great-stick-up',
  'wild-depths',
  'down-the-rails',
  'cash-patrol',
  'cash-bonanza',
  'christmas-carol-megaways',
  'book-of-tut-respin',
  'drago-jewels-of-fortune'
]
  .filter(slug => !EXCLUDED_SLUGS.has(slug))
  .map(slug => ({
    slug,
    name: slug.replace(/-/g,' '),
    url: normalizeGameUrl('https://www.pragmaticplay.com/en/games/' + slug + '/')
  }));


async function auditRuntime(frame) {
  return frame.evaluate(() => {
    const roots=window.globalRuntime?.sceneRoots||[];
    const optionIndices=[];
    const v2Counts=[];
    const managerCounts=[];

    if (window.FeaturePurchaseOption) {
      for (const root of roots) {
        let items=[];
        try { items=root.GetComponentsInChildren(FeaturePurchaseOption,true)||[]; } catch {}
        for (const item of items) {
          try {
            if (Number(item.type)===1) continue;
            const index=Number(item.purchaseIndex);
            if (Number.isFinite(index) && index>=0) optionIndices.push(index);
          } catch {}
        }
      }
    }

    if (window.FeaturePurchaseV2) {
      for (const root of roots) {
        let managers=[];
        try { managers=root.GetComponentsInChildren(FeaturePurchaseV2,true)||[]; } catch {}
        for (const manager of managers) v2Counts.push((manager.purchaseOptions||[]).length);
      }
    }

    if (window.FeaturePurchaseManager) {
      for (const root of roots) {
        let managers=[];
        try { managers=root.GetComponentsInChildren(FeaturePurchaseManager,true)||[]; } catch {}
        for (const manager of managers) managerCounts.push((manager.purchaseCosts||[]).length);
      }
    }

    return {
      optionCount:new Set(optionIndices).size,
      optionIndices:[...new Set(optionIndices)].sort((a,b)=>a-b),
      v2Count:Math.max(0,...v2Counts),
      managerCount:Math.max(0,...managerCounts),
      server:globalThis.__parserPragmaticPurInit ?? null
    };
  });
}

const browser=await chromium.launch({headless:true});
const candidates=shuffleSeeded(CANDIDATE_SLUGS,'pragmatic-more20-2026-10-04-v2');

console.log('candidate pool after exclusions='+candidates.length);

const results=[];
const skipped=[];

for (const candidate of candidates) {
  if (results.length>=20) break;

  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  let server=null;

  const handler=async response => {
    try {
      const request=response.request();
      const post=request.postData()||'';
      if (!/gameService/i.test(response.url())) return;
      if (!/(?:^|&)action=doInit(?:&|$)/.test(post)) return;
      server=parsePurInit(await response.text());
      const frame=request.frame();
      await frame.evaluate(value => {
        globalThis.__parserPragmaticPurInit=value;
      },server).catch(()=>{});
    } catch {}
  };
  page.on('response',handler);

  try {
    console.log('candidate '+candidate.slug);
    await page.goto(candidate.url,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2000);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,12000);

    if (!runtime || runtime.provider.id!=='pragmatic') {
      skipped.push({...candidate,reason:'Pragmatic runtime not found'});
      console.log('  SKIP runtime not found');
      continue;
    }

    await page.waitForTimeout(500);

    const parser=await runtime.provider.listPurchases(runtime.frame);
    const runtimeAudit=await auditRuntime(runtime.frame);
    const authoritative=Number(server?.count ?? runtimeAudit.server?.count);

    if (!Number.isFinite(authoritative)) {
      skipped.push({...candidate,reason:'doInit purInit unavailable'});
      console.log('  SKIP purInit unavailable');
      continue;
    }

    const parserCount=parser.filter(x=>x.available!==false).length;
    const verdict=parserCount===authoritative?'PASS':'MISMATCH';

    const row={
      index:results.length+1,
      ...candidate,
      parserCount,
      serverCount:authoritative,
      parser,
      runtime:runtimeAudit,
      verdict
    };
    results.push(row);

    console.log(
      '  #'+row.index+
      ' parser='+parserCount+
      ' server='+authoritative+
      ' runtime='+runtimeAudit.optionCount+
      '/v2:'+runtimeAudit.v2Count+
      '/mgr:'+runtimeAudit.managerCount+
      ' => '+verdict
    );
  } catch (error) {
    skipped.push({...candidate,reason:String(error?.message||error)});
    console.log('  SKIP '+String(error?.message||error));
  } finally {
    page.off('response',handler);
    await context.close();
  }
}

await browser.close();

const summary={
  generatedAt:new Date().toISOString(),
  seed:'pragmatic-more20-2026-10-04-v2',
  catalogCandidates:candidates.length,
  total:results.length,
  pass:results.filter(x=>x.verdict==='PASS').length,
  mismatch:results.filter(x=>x.verdict==='MISMATCH').length,
  skipped,
  results
};

await writeJson('results/pragmatic-purchase-audit-more20.json',summary);

for (const row of results) {
  console.log(
    [row.index,row.name,row.slug,'parser='+row.parserCount,'server='+row.serverCount,'verdict='+row.verdict].join(' | ')
  );
}
console.log('AUDIT MORE20 DONE pass='+summary.pass+' mismatch='+summary.mismatch+' skipped='+skipped.length);
if (results.length<20 || summary.mismatch) process.exitCode=1;
