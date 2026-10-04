#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { summarizeRequest, summarizeResponse, writeJson } from '../src/lib/common.js';

const CASES=[
  ['Great Rhino Megaways','great-rhino-megaways',0],
  ['Gates of Olympus','gates-of-olympus',0],
  ['Big Bass Floats My Boat','big-bass-floats-my-boat',0],
  ['Wild West Gold Blazing Bounty','wild-west-gold-blazing-bounty',1]
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

const urlFor=slug=>'https://www.pragmaticplay.com/en/games/'+slug+'/?cur=USD&gamelang=en';

function parseForm(text){
  const out={};
  if(!text) return out;
  const p=new URLSearchParams(text);
  for(const [k,v] of p) out[k]=v;
  return out;
}

const browser=await chromium.launch({headless:true});
const results=[];

for(const [name,slug,index] of CASES){
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const purInitHandler=attachPurInit(page);
  const requests=[];
  const responses=[];
  const tasks=new Set();

  page.on('request',req=>{
    if(/gameService/i.test(req.url())) requests.push(summarizeRequest(req));
  });
  page.on('response',response=>{
    if(!/gameService/i.test(response.url())) return;
    const task=summarizeResponse(response).then(x=>responses.push(x)).catch(()=>{}).finally(()=>tasks.delete(task));
    tasks.add(task);
  });

  const row={name,slug,index,error:null,options:null,press:null,before:null,trigger:null,after:null,requests:[],responses:[]};

  try{
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,30000);
    if(!runtime||runtime.provider.id!=='pragmatic') throw new Error('runtime not found');

    await runtime.provider.waitReady?.(runtime.frame,10000).catch(()=>null);
    row.options=await runtime.provider.listPurchases(runtime.frame);

    row.press=await runtime.provider.purchase(runtime.frame,index);
    row.before=await runtime.frame.evaluate(()=>({
      canSpin:(()=>{try{return Vars.CanSpin?XT.GetBool(Vars.CanSpin):null}catch{return null}})(),
      purchaseIndex:(()=>{try{return XT.GetObject(Vars.FeaturePurchase)?.purchaseIndex??null}catch{return null}})(),
      hasEvent:Boolean(Vars.Evt_ToServer_RequestSpin),
      eventValue:(()=>{try{return Vars.Evt_ToServer_RequestSpin?.name??String(Vars.Evt_ToServer_RequestSpin)}catch{return null}})()
    }));

    const requestBase=requests.length;
    const responseBase=responses.length;

    row.trigger=await runtime.frame.evaluate(()=>{
      try{
        if(!window.XT||!window.Vars) return {ok:false,reason:'XT/Vars unavailable'};
        const event=Vars.Evt_ToServer_RequestSpin;
        if(!event) return {ok:false,reason:'Evt_ToServer_RequestSpin unavailable'};
        if(typeof XT.TriggerEvent!=='function') return {ok:false,reason:'XT.TriggerEvent unavailable'};
        XT.TriggerEvent(event);
        return {ok:true,strategy:'XT.TriggerEvent(Vars.Evt_ToServer_RequestSpin)'};
      }catch(error){
        return {ok:false,reason:String(error?.message||error)};
      }
    });

    await page.waitForTimeout(2500);
    await Promise.allSettled([...tasks]);

    row.after=await runtime.frame.evaluate(()=>({
      canSpin:(()=>{try{return Vars.CanSpin?XT.GetBool(Vars.CanSpin):null}catch{return null}})(),
      purchaseIndex:(()=>{try{return XT.GetObject(Vars.FeaturePurchase)?.purchaseIndex??null}catch{return null}})()
    }));

    row.requests=requests.slice(requestBase).map(x=>({
      endpoint:x.endpoint,
      payload:x.postData,
      parsed:parseForm(x.postData)
    }));
    row.responses=responses.slice(responseBase).map(x=>({
      endpoint:x.endpoint,
      request:parseForm(x.requestPostData),
      response:parseForm(x.body)
    }));

    console.log(name+
      ' purchase='+index+
      ' trigger='+Boolean(row.trigger?.ok)+
      ' beforeCanSpin='+row.before?.canSpin+
      ' requests='+row.requests.length+
      ' first='+(row.requests[0]?.parsed?.action||'-')+
      '/pur:'+(row.requests[0]?.parsed?.pur??'-')
    );
  }catch(error){
    row.error=String(error?.stack||error?.message||error);
    console.log(name+' ERROR '+String(error?.message||error));
  }finally{
    await Promise.allSettled([...tasks]);
    results.push(row);
    page.off('response',purInitHandler);
    await context.close();
  }
}

await browser.close();
await writeJson('results/pragmatic-direct-purchase-spin-test.json',{generatedAt:new Date().toISOString(),results});

const failures=results.filter(r=>r.error||!r.requests.some(x=>x.parsed?.action==='doSpin'&&Number(x.parsed?.pur)===Number(r.index)));
console.log('DIRECT PURCHASE SPIN TEST cases='+results.length+' failures='+failures.length);
if(failures.length) process.exitCode=1;
