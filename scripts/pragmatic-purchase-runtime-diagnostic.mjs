#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { writeJson } from '../src/lib/common.js';

const CASES = [
  ['Great Rhino Megaways','great-rhino-megaways',0],
  ['Gates of Olympus','gates-of-olympus',0],
  ['Big Bass Floats My Boat','big-bass-floats-my-boat',0],
  ['Wild Beach Party','wild-beach-party',0]
];


function parsePurInit(text){
  if(!text) return {count:0,options:[]};
  const params=new URLSearchParams(text);
  const raw=params.get('purInit');
  if(raw==null) return {count:0,options:[]};
  let decoded=raw;
  try{decoded=decodeURIComponent(raw)}catch{}
  let parsed=null;
  try{parsed=JSON.parse(decoded)}catch{}
  let options=[];
  if(Array.isArray(parsed)) options=parsed;
  else if(parsed&&Array.isArray(parsed.options)) options=parsed.options;
  else options=(decoded.match(/\{[^{}]*\}/g)||[]).map((x,i)=>({index:i,raw:x}));
  return {count:options.length,options};
}

function attachPurInit(page){
  const handler=async response=>{
    try{
      const req=response.request();
      const post=req.postData()||'';
      if(!/gameService/i.test(response.url())) return;
      if(!/(?:^|&)action=doInit(?:&|$)/.test(post)) return;
      const parsed=parsePurInit(await response.text());
      await req.frame().evaluate(value=>{
        globalThis.__parserPragmaticPurInit=value;
      },parsed).catch(()=>{});
    }catch{}
  };
  page.on('response',handler);
  return handler;
}

const urlFor = slug =>
  'https://www.pragmaticplay.com/en/games/' + slug + '/?cur=USD&gamelang=en';

async function inspect(frame) {
  return frame.evaluate(() => {
    const roots = globalThis.globalRuntime?.sceneRoots || [];

    const methodsOf = object => {
      if (!object) return [];
      const out = new Set();
      let current = object;
      for (let depth=0; current && depth<5; depth++) {
        for (const name of Object.getOwnPropertyNames(current)) {
          try {
            if (typeof object[name] === 'function') out.add(name);
          } catch {}
        }
        current = Object.getPrototypeOf(current);
      }
      return [...out]
        .filter(name => /(buy|purchase|confirm|accept|start|spin|close|select|feature|bonus|click|press)/i.test(name))
        .sort()
        .slice(0,120);
    };

    const buttons = [];
    if (globalThis.XTButton) {
      for (let ri=0; ri<roots.length; ri++) {
        let items=[];
        try { items=roots[ri].GetComponentsInChildren(XTButton,true)||[]; } catch {}
        for (const button of items) {
          try {
            if (button.gameObject?.activeInHierarchy === false) continue;
            buttons.push({
              root:ri,
              name:button.gameObject?.name ?? null,
              event:button.eventToCode?.name ?? null,
              methods:methodsOf(button)
            });
          } catch {}
        }
      }
    }

    const fpOptions=[];
    if (globalThis.FeaturePurchaseOption) {
      for (let ri=0; ri<roots.length; ri++) {
        let items=[];
        try { items=roots[ri].GetComponentsInChildren(FeaturePurchaseOption,true)||[]; } catch {}
        for (const item of items) {
          try {
            fpOptions.push({
              root:ri,
              name:item.gameObject?.name ?? null,
              active:item.gameObject?.activeInHierarchy ?? null,
              type:item.type ?? null,
              purchaseIndex:item.purchaseIndex ?? null,
              methods:methodsOf(item)
            });
          } catch {}
        }
      }
    }

    const fpV2=[];
    if (globalThis.FeaturePurchaseV2) {
      for (let ri=0; ri<roots.length; ri++) {
        let managers=[];
        try { managers=roots[ri].GetComponentsInChildren(FeaturePurchaseV2,true)||[]; } catch {}
        for (const manager of managers) {
          fpV2.push({
            root:ri,
            name:manager.gameObject?.name ?? null,
            active:manager.gameObject?.activeInHierarchy ?? null,
            methods:methodsOf(manager),
            optionCount:(manager.purchaseOptions||[]).length,
            options:(manager.purchaseOptions||[]).map((option,index)=>({
              index,
              name:option?.gameObject?.name ?? null,
              active:option?.gameObject?.activeInHierarchy ?? null,
              forceDisabled:option?.forceDisabled ?? null,
              methods:methodsOf(option)
            }))
          });
        }
      }
    }

    const managers=[];
    if (globalThis.FeaturePurchaseManager) {
      for (let ri=0; ri<roots.length; ri++) {
        let items=[];
        try { items=roots[ri].GetComponentsInChildren(FeaturePurchaseManager,true)||[]; } catch {}
        for (const manager of items) {
          managers.push({
            root:ri,
            name:manager.gameObject?.name ?? null,
            active:manager.gameObject?.activeInHierarchy ?? null,
            methods:methodsOf(manager),
            costs:Array.from(manager.purchaseCosts||[]).slice(0,12),
            availability:Array.from(manager.purchaseOptionIsAvailable||[]).slice(0,12)
          });
        }
      }
    }

    const vars=[];
    try {
      for (const key of Object.keys(globalThis.Vars||{})) {
        if (!/(buy|purchase|feature|bonus|spin|confirm|accept|select)/i.test(key)) continue;
        let value=null;
        try {
          const ref=Vars[key];
          if (globalThis.XT) {
            for (const getter of ['GetBool','GetInt','GetFloat','GetString','GetObject']) {
              try {
                const candidate=XT[getter]?.(ref);
                if (candidate != null && typeof candidate !== 'object') {
                  value={getter,value:candidate};
                  break;
                }
                if (candidate && typeof candidate === 'object' && getter==='GetObject') {
                  value={
                    getter,
                    object:{
                      purchaseIndex:candidate.purchaseIndex ?? null,
                      selectedIndex:candidate.selectedIndex ?? null,
                      keys:Object.keys(candidate).slice(0,40)
                    }
                  };
                  break;
                }
              } catch {}
            }
          }
        } catch {}
        vars.push({key,value});
      }
    } catch {}

    return {
      buttons,
      fpOptions,
      fpV2,
      managers,
      vars,
      canSpin:(()=>{try{return Vars.CanSpin?XT.GetBool(Vars.CanSpin):null}catch{return null}})(),
      purchaseWindow:(()=>{try{return Vars.FeaturePurchaseWindowIsOpen?XT.GetBool(Vars.FeaturePurchaseWindowIsOpen):null}catch{return null}})(),
      canonical:(()=>{try{
        const x=Vars.FeaturePurchase?XT.GetObject(Vars.FeaturePurchase):null;
        return x?{
          purchaseIndex:x.purchaseIndex ?? null,
          keys:Object.keys(x).slice(0,80)
        }:null;
      }catch{return null}})()
    };
  });
}

const browser=await chromium.launch({headless:true});
const results=[];

for (const [name,slug,index] of CASES) {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const purInitHandler=attachPurInit(page);
  const row={name,slug,index,error:null,before:null,options:null,discoveryReady:null,executionReady:null,press:null,after:null,afterWait:null};

  try {
    console.log('CASE '+name);
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,30000);
    if (!runtime || runtime.provider.id!=='pragmatic') throw new Error('Pragmatic runtime not found');

    row.discoveryReady=await runtime.provider.waitReady?.(runtime.frame,10000).catch(error=>({ok:false,reason:String(error?.message||error)}));
    row.options=await runtime.provider.listPurchases(runtime.frame);

    // Execute from a clean post-discovery session, matching production buy_all.
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const executionRuntime=await findRuntime(page,30000);
    if(!executionRuntime || executionRuntime.provider.id!=='pragmatic') throw new Error('execution runtime not found');
    const ready=await executionRuntime.provider.waitReady?.(executionRuntime.frame,10000).catch(error=>({ok:false,reason:String(error?.message||error)}));
    row.executionReady=ready;
    if(!ready?.ok) {
      row.before=await inspect(executionRuntime.frame);
      throw new Error(
        'execution base state not ready '+
        JSON.stringify({
          purInitReady:ready?.purInitReady,
          canSpin:ready?.canSpin,
          safeControls:ready?.safeControls,
          actions:ready?.actions,
          reason:ready?.reason
        })
      );
    }

    row.before=await inspect(executionRuntime.frame);
    row.press=await executionRuntime.provider.purchase(executionRuntime.frame,index);
    row.after=await inspect(executionRuntime.frame);
    await page.waitForTimeout(1500);
    row.afterWait=await inspect(executionRuntime.frame);

    console.log(
      '  options='+row.options.length+
      ' strategy='+(row.press?.strategy||'-')+
      ' canSpin '+row.before?.canSpin+' -> '+row.after?.canSpin+' -> '+row.afterWait?.canSpin+
      ' buttonsAfter='+row.after?.buttons?.length
    );
  } catch (error) {
    row.error=String(error?.stack||error?.message||error);
    console.log('  ERROR '+String(error?.message||error));
  } finally {
    results.push(row);
    page.off('response',purInitHandler);
    await context.close();
  }
}

await browser.close();
await writeJson('results/pragmatic-purchase-runtime-diagnostic.json',{generatedAt:new Date().toISOString(),results});

for (const row of results) {
  console.log('=== '+row.name+' ===');
  console.log(JSON.stringify({
    error:row.error,
    discoveryReady:row.discoveryReady,
    executionReady:row.executionReady,
    press:row.press,
    before:{
      canSpin:row.before?.canSpin,
      purchaseWindow:row.before?.purchaseWindow,
      canonical:row.before?.canonical,
      buttons:row.before?.buttons
    },
    after:{
      canSpin:row.after?.canSpin,
      purchaseWindow:row.after?.purchaseWindow,
      canonical:row.after?.canonical,
      buttons:row.after?.buttons,
      fpOptions:row.after?.fpOptions,
      fpV2:row.after?.fpV2,
      managers:row.after?.managers,
      vars:row.after?.vars
    },
    afterWait:{
      canSpin:row.afterWait?.canSpin,
      purchaseWindow:row.afterWait?.purchaseWindow,
      canonical:row.afterWait?.canonical,
      buttons:row.afterWait?.buttons
    }
  }));
}
