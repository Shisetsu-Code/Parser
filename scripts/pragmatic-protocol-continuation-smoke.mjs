#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { summarizeResponse, writeJson } from '../src/lib/common.js';

const CASES=[
  ['Gates of Olympus','gates-of-olympus',0,'free-spins'],
  ['Drago Jewels of Fortune','drago-jewels-of-fortune',0,'bonus-pick']
];

const urlFor=slug=>'https://www.pragmaticplay.com/en/games/'+slug+'/?cur=USD&gamelang=en';

function parseForm(text){
  const out={};
  if(!text) return out;
  const p=new URLSearchParams(text);
  for(const [k,v] of p) out[k]=v;
  return out;
}

function parsePurInit(text){
  const body=parseForm(text);
  const raw=body.purInit;
  if(raw==null) return {count:0,options:[]};
  let decoded=raw;
  try{decoded=decodeURIComponent(raw)}catch{}
  let parsed=null;
  try{parsed=JSON.parse(decoded)}catch{}
  let options=[];
  if(Array.isArray(parsed)) options=parsed;
  else if(parsed&&Array.isArray(parsed.options)) options=parsed.options;
  else options=(decoded.match(/\{[^{}]*\}/g)||[]).map((raw,index)=>({index,raw}));
  return {count:options.length,options};
}

function exchange(summary){
  const req=parseForm(summary?.requestPostData||'');
  const res=parseForm(summary?.body||'');
  return {
    action:req.action??null,
    pur:req.pur??req.puri??null,
    ind:req.ind??null,
    lInd:req.lInd??null,
    na:res.na??null,
    fs:res.fs??null,
    fsmax:res.fsmax??null,
    bgid:res.bgid??null,
    bgt:res.bgt??null,
    end:res.end??null,
    rs:res.rs??null,
    rs_c:res.rs_c??null,
    rs_m:res.rs_m??null,
    trail:res.trail??null,
    request:req,
    response:res
  };
}

async function waitForNewResponse(page,responses,before,maxMs=7000){
  const start=Date.now();
  while(Date.now()-start<maxMs){
    if(responses.length>before) return true;
    await page.waitForTimeout(150);
  }
  return responses.length>before;
}

async function triggerFirstPurchaseSpin(frame){
  return frame.evaluate(()=>{
    try{
      const event=globalThis.Vars?.Evt_ToServer_RequestSpin || globalThis.Vars?.Evt_DataToCode_Pressed_Spin;
      if(!event||typeof globalThis.XT?.TriggerEvent!=='function'){
        return {ok:false,reason:'spin event unavailable'};
      }
      XT.TriggerEvent(event);
      return {ok:true,strategy:event===Vars.Evt_ToServer_RequestSpin?'Evt_ToServer_RequestSpin':'Evt_DataToCode_Pressed_Spin'};
    }catch(error){
      return {ok:false,reason:String(error?.message||error)};
    }
  });
}

const browser=await chromium.launch({headless:true});
const results=[];

for(const [name,slug,purchaseIndex,expected] of CASES){
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const responses=[];
  const tasks=new Set();

  const onResponse=response=>{
    if(!/gameService/i.test(response.url())) return;
    const task=(async()=>{
      const s=await summarizeResponse(response);
      responses.push(s);
      const req=parseForm(s.requestPostData||'');
      if(req.action==='doInit'){
        const pur=parsePurInit(s.body||'');
        await response.request().frame().evaluate(value=>{
          globalThis.__parserPragmaticPurInit=value;
        },pur).catch(()=>{});
      }
    })().catch(()=>{}).finally(()=>tasks.delete(task));
    tasks.add(task);
  };
  page.on('response',onResponse);

  const row={
    name,slug,purchaseIndex,expected,status:'UNKNOWN',error:null,
    purchasePress:null,entry:null,firstContinuation:null,secondContinuation:null,
    choices:[],choicePress:null,next:null,protocolStates:[]
  };

  try{
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,30000);
    if(!runtime||runtime.provider.id!=='pragmatic') throw new Error('runtime not found');

    const provider=runtime.provider;
    const frame=runtime.frame;
    const ready=await provider.waitReady?.(frame,10000);
    if(!ready?.ok) throw new Error('base state not ready: '+(ready?.reason||'unknown'));

    const options=await provider.listPurchases(frame);
    if(!options[purchaseIndex]) throw new Error('purchase option missing');

    row.purchasePress=await provider.purchase(frame,purchaseIndex);
    const beforeEntry=responses.length;
    const trigger=await triggerFirstPurchaseSpin(frame);
    if(!trigger?.ok) throw new Error('first purchase spin trigger failed: '+(trigger?.reason||'unknown'));
    await waitForNewResponse(page,responses,beforeEntry,7000);
    await Promise.allSettled([...tasks]);

    const gameplay=responses.map(exchange).filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
    row.entry=gameplay.at(-1)||null;
    if(!row.entry) throw new Error('purchase produced no gameplay response');

    row.protocolStates.push(await provider.protocolState?.(frame));

    const before1=responses.length;
    row.firstContinuation=await provider.continueProtocol(frame,row.entry);
    row.choices=row.firstContinuation?.choices||[];

    if(row.firstContinuation?.needsSelection){
      if(!row.choices.length) throw new Error('bonus selection required but no picker choices found');
      row.choicePress=await provider.pressProtocolChoice(frame,row.choices[0]);
      await waitForNewResponse(page,responses,before1,7000);
      await Promise.allSettled([...tasks]);
      const fresh=responses.slice(before1).map(exchange).filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
      row.next=fresh.at(-1)||null;
      row.status=row.choicePress?.ok && row.next?.action==='doBonus' ? 'PASS' : 'FAIL';
    }else if(row.firstContinuation?.ok){
      await page.waitForTimeout(700);
      row.protocolStates.push(await provider.protocolState?.(frame));

      const fresh1=responses.slice(before1).map(exchange).filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
      if(fresh1.length){
        row.next=fresh1.at(-1);
        row.status='PASS';
      }else{
        const before2=responses.length;
        row.secondContinuation=await provider.continueProtocol(frame,row.entry);
        await waitForNewResponse(page,responses,before2,7000);
        await Promise.allSettled([...tasks]);
        const fresh2=responses.slice(before2).map(exchange).filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
        row.next=fresh2.at(-1)||null;
        row.status=row.secondContinuation?.ok && row.next?.action==='doSpin' ? 'PASS' : 'FAIL';
      }
    }else{
      row.status='FAIL';
    }

    console.log(
      name+
      ' expected='+expected+
      ' status='+row.status+
      ' entry='+row.entry?.action+'/na:'+(row.entry?.na??'-')+
      ' first='+(row.firstContinuation?.kind||'-')+
      ' choices='+row.choices.length+
      ' second='+(row.secondContinuation?.kind||'-')+
      ' next='+(row.next?.action||'-')+
      '/ind:'+(row.next?.ind??'-')+
      '/fs:'+(row.next?.fs??'-')
    );
  }catch(error){
    row.status='ERROR';
    row.error=String(error?.stack||error?.message||error);
    console.log(name+' ERROR '+String(error?.message||error));
  }finally{
    await Promise.allSettled([...tasks]);
    page.off('response',onResponse);
    results.push(row);
    await context.close();
  }
}

await browser.close();
await writeJson('results/pragmatic-protocol-continuation-smoke.json',{
  generatedAt:new Date().toISOString(),
  results
});
const failures=results.filter(x=>x.status!=='PASS');
console.log('PROTOCOL CONTINUATION SMOKE pass='+(results.length-failures.length)+' fail='+failures.length);
if(failures.length) process.exitCode=1;
