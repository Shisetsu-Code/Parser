#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { summarizeResponse, writeJson } from '../src/lib/common.js';

const GAMES = [
  ['Great Rhino Megaways','great-rhino-megaways'],
  ['Wild Beach Party','wild-beach-party'],
  ['Wild Depths','wild-depths'],
  ['Big Bass Bonanza Keeping It Reel','big-bass-bonanza-keeping-it-reel'],
  ['John Hunter and the Tomb of the Scarab Queen','john-hunter-and-the-tomb-of-the-scarab-queen'],
  ['Diamond Strike','diamond-strike'],
  ['Gates of Olympus','gates-of-olympus'],
  ['Floating Dragon','floating-dragon'],
  ['Empty the Bank','empty-the-bank'],
  ['Big Bass Floats My Boat','big-bass-floats-my-boat'],
  ['Wild West Gold Blazing Bounty','wild-west-gold-blazing-bounty'],
  ['Fruit Party 2','fruit-party-2'],
  ['Down the Rails','down-the-rails'],
  ['888 Dragons','888-dragons'],
  ['Gems Bonanza','gems-bonanza'],
  ['Cash Elevator','cash-elevator'],
  ['Drago Jewels of Fortune','drago-jewels-of-fortune'],
  ['Pyramid Bonanza','pyramid-bonanza'],
  ['Sweet Bonanza Xmas','sweet-bonanza-xmas'],
  ['Starlight Princess','starlight-princess']
];

const urlFor=slug=>'https://www.pragmaticplay.com/en/games/'+slug+'/?cur=USD&gamelang=en';

function parseForm(text){
  const out={};
  try{
    const p=new URLSearchParams(String(text||''));
    for(const [k,v] of p.entries()) out[k]=v;
  }catch{}
  return out;
}

function parsePurInit(text){
  const body=parseForm(text);
  const raw=body.purInit;
  if(raw==null) return {count:0,options:[]};
  let decoded=raw;
  try{decoded=decodeURIComponent(raw);}catch{}
  let parsed=null;
  try{parsed=JSON.parse(decoded);}catch{}
  let options=[];
  if(Array.isArray(parsed)) options=parsed;
  else if(parsed && Array.isArray(parsed.options)) options=parsed.options;
  else options=(decoded.match(/\{[^{}]*\}/g)||[]).map((raw,index)=>({index,raw}));
  return {count:options.length,options};
}

async function openRuntime(browser,slug,branchIndex=null){
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const responseTasks=new Set();
  let purInit=null;

  const onResponse=response=>{
    if(!/gameService/i.test(response.url())) return;
    const task=(async()=>{
      const summary=await summarizeResponse(response);
      const req=parseForm(summary.requestPostData||'');
      if(req.action!=='doInit') return;
      purInit=parsePurInit(summary.body||'');
      try{
        await response.request().frame().evaluate(value=>{
          globalThis.__parserPragmaticPurInit=value;
        },purInit);
      }catch{}
    })().catch(()=>{}).finally(()=>responseTasks.delete(task));
    responseTasks.add(task);
  };
  page.on('response',onResponse);

  try{
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    let runtime=await findRuntime(page,30000);
    if(!runtime || runtime.provider.id!=='pragmatic') throw new Error('Pragmatic runtime not found');
    await Promise.allSettled([...responseTasks]);

    let ready=await runtime.provider.waitReady?.(runtime.frame,4500).catch(()=>null);
    if(!ready?.ok && ready?.preBaseSelection===true){
      const selections=await runtime.provider.listPreBaseSelections?.(runtime.frame) ?? [];
      const idx=branchIndex==null?0:Number(branchIndex);
      const selection=selections[idx];
      if(!selection) throw new Error('pre-base branch unavailable '+idx+'/'+selections.length);
      const press=await runtime.provider.pressPreBaseSelection(runtime.frame,selection);
      if(!press?.ok) throw new Error('pre-base branch failed: '+(press?.reason||'unknown'));
      await page.waitForTimeout(700);
      const refreshed=await findRuntime(page,10000).catch(()=>null);
      if(refreshed?.provider?.id==='pragmatic') runtime=refreshed;
      ready=await runtime.provider.waitReady?.(runtime.frame,10000).catch(()=>null);
    }

    return {context,page,runtime,purInit,responseTasks,onResponse,ready};
  }catch(error){
    await Promise.allSettled([...responseTasks]);
    page.off('response',onResponse);
    await context.close();
    throw error;
  }
}

async function branchCount(browser,slug){
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  try{
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,12000);
    if(!runtime || runtime.provider.id!=='pragmatic') return 1;
    const selections=await runtime.provider.listPreBaseSelections?.(runtime.frame) ?? [];
    return Math.max(1,selections.length);
  }catch{
    return 1;
  }finally{
    await context.close();
  }
}

function normalizePurchase(item,branch){
  return {
    id:item?.id ?? null,
    subtype:item?.subtype ?? 'unknown',
    execution:item?.execution ?? null,
    available:item?.available !== false,
    cost:item?.cost ?? null,
    multiplier:item?.multiplier ?? null,
    mode:item?.mode ?? null,
    index:item?.index ?? null,
    ordinal:item?.ordinal ?? null,
    branch,
    control:item?.control ?? null
  };
}

const browser=await chromium.launch({headless:true});
const results=[];

for(let gi=0;gi<GAMES.length;gi++){
  const [name,slug]=GAMES[gi];
  const branches=await branchCount(browser,slug);
  const branchResults=[];
  const union=new Map();
  let error=null;

  for(let branch=0;branch<branches;branch++){
    let session=null;
    try{
      session=await openRuntime(browser,slug,branches>1?branch:null);
      const provider=session.runtime.provider;
      const inventory=await provider.listEconomicPurchases(session.runtime.frame);
      const normalized=inventory.map(item=>normalizePurchase(item,branch));
      const featureCount=normalized.filter(x=>x.subtype==='buy_feature').length;
      const serverCount=session.purInit?.count ?? null;

      branchResults.push({
        branch,
        serverBuyFeatureCount:serverCount,
        detectedBuyFeatureCount:featureCount,
        inventory:normalized
      });

      for(const item of normalized){
        const key=[
          item.subtype,
          item.execution,
          item.index ?? '',
          item.control?.name ?? '',
          item.control?.event ?? '',
          item.mode ?? '',
          item.multiplier ?? ''
        ].join('|');
        if(!union.has(key)) union.set(key,item);
      }
    }catch(e){
      branchResults.push({branch,error:String(e?.message||e),inventory:[]});
      error=String(e?.message||e);
    }finally{
      if(session){
        await Promise.allSettled([...session.responseTasks]);
        session.page.off('response',session.onResponse);
        await session.context.close();
      }
    }
  }

  const inventory=[...union.values()];
  const bySubtype={};
  for(const item of inventory) bySubtype[item.subtype]=(bySubtype[item.subtype]||0)+1;

  const result={
    index:gi+1,
    name,
    slug,
    branches,
    totalEconomicPurchases:inventory.length,
    bySubtype,
    inventory,
    branchResults,
    error
  };
  results.push(result);

  console.log(
    '['+(gi+1)+'/20] '+name+
    ' total='+inventory.length+
    ' '+Object.entries(bySubtype).map(([k,v])=>k+':'+v).join(' ') +
    (error?' error='+error:'')
  );
}

await browser.close();

const summary={
  generatedAt:new Date().toISOString(),
  totalGames:results.length,
  errors:results.filter(x=>x.error).length,
  results
};

await writeJson('results/pragmatic-economic-purchase-audit.json',summary);

for(const r of results){
  console.log(
    r.index+' | '+r.name+
    ' | total='+r.totalEconomicPurchases+
    ' | '+Object.entries(r.bySubtype).map(([k,v])=>k+'='+v).join(',')+
    ' | branches='+r.branches+
    ' | error='+(r.error||'-')
  );
}
console.log('ECONOMIC AUDIT DONE games='+summary.totalGames+' errors='+summary.errors);
if(summary.errors) process.exitCode=1;
