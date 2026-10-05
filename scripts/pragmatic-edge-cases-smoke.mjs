#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { summarizeResponse, writeJson } from '../src/lib/common.js';

const urlFor = slug =>
  'https://www.pragmaticplay.com/en/games/' + slug + '/?cur=USD&gamelang=en';

function form(text='') {
  const out={};
  const p=new URLSearchParams(text);
  for(const [k,v] of p) out[k]=v;
  return out;
}

function exchange(summary) {
  const req=form(summary?.requestPostData||'');
  const res=form(summary?.body||'');
  return {
    action:req.action??null,
    pur:req.pur??req.puri??null,
    ind:req.ind??null,
    na:res.na??null,
    fs:res.fs??null,
    fsmax:res.fsmax??null,
    bgid:res.bgid??null,
    end:res.end??null,
    rs:res.rs??null,
    rs_c:res.rs_c??null,
    rs_m:res.rs_m??null,
    trail:res.trail??null
  };
}

function parsePurInit(bodyText='') {
  const body=form(bodyText);
  const raw=body.purInit;
  if(raw==null) return {count:0,options:[]};
  let decoded=raw;
  try { decoded=decodeURIComponent(raw); } catch {}
  let parsed=null;
  try { parsed=JSON.parse(decoded); } catch {}
  let options=[];
  if(Array.isArray(parsed)) options=parsed;
  else if(parsed&&Array.isArray(parsed.options)) options=parsed.options;
  else options=(decoded.match(/\{[^{}]*\}/g)||[]).map((raw,index)=>({index,raw}));
  return {count:options.length,options};
}

function attach(page, responses, tasks) {
  const handler=response=>{
    if(!/gameService/i.test(response.url())) return;
    const task=(async()=>{
      const s=await summarizeResponse(response);
      responses.push(s);
      const req=form(s.requestPostData||'');
      if(req.action==='doInit') {
        const pur=parsePurInit(s.body||'');
        await response.request().frame().evaluate(value=>{
          globalThis.__parserPragmaticPurInit=value;
        },pur).catch(()=>{});
      }
    })().catch(()=>{}).finally(()=>tasks.delete(task));
    tasks.add(task);
  };
  page.on('response',handler);
  return handler;
}

async function waitForResponse(page,responses,before,maxMs=7000) {
  const start=Date.now();
  while(Date.now()-start<maxMs) {
    if(responses.length>before) return true;
    await page.waitForTimeout(150);
  }
  return responses.length>before;
}

async function load(browser,slug) {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const responses=[];
  const tasks=new Set();
  const handler=attach(page,responses,tasks);

  await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForTimeout(2200);
  await bootstrapSupportedPage(page);
  const runtime=await findRuntime(page,30000);
  if(!runtime||runtime.provider.id!=='pragmatic') throw new Error('Pragmatic runtime not found');

  return {context,page,responses,tasks,handler,...runtime};
}

async function close(session) {
  await Promise.allSettled([...session.tasks]);
  session.page.off('response',session.handler);
  await session.context.close();
}

async function greatRhino(browser) {
  const results=[];
  for(let branch=0;branch<4;branch++) {
    const s=await load(browser,'great-rhino-megaways');
    const row={branch,status:'UNKNOWN',selection:null,press:null,ready:null,state:null,traffic:[],error:null};
    try {
      const selections=await s.provider.listPreBaseSelections?.(s.frame) ?? [];
      row.selection=selections[branch] ?? null;
      if(!row.selection) throw new Error('pre-base selection missing branch='+branch);

      const beforeResponses=s.responses.length;
      row.press=await s.provider.pressPreBaseSelection(s.frame,row.selection);
      await s.page.waitForTimeout(900);
      await Promise.allSettled([...s.tasks]);
      row.traffic=s.responses.slice(beforeResponses)
        .map(exchange)
        .filter(x=>x.action||x.na||x.bgid||x.fs||x.rs);
      row.ready=await s.provider.waitReady?.(s.frame,7000);
      row.state=await s.provider.protocolState?.(s.frame);

      row.status=row.press?.ok && row.ready?.ok ? 'PASS' : 'FAIL';
      console.log(
        'Great Rhino branch='+branch+
        ' status='+row.status+
        ' pick='+(row.press?.strategy||'-')+
        ' finalize='+(row.press?.finalize?.strategy||row.press?.finalize?.reason||'-')+
        ' ready='+(row.ready?.ok===true)+
        ' canSpin='+(row.state?.canSpin ?? '-')+
        ' traffic='+row.traffic.map(x=>(x.action||'-')+'/na:'+(x.na??'-')+'/bgid:'+(x.bgid??'-')+'/fs:'+(x.fs??'-')).join(',')
      );
    } catch(error) {
      row.status='ERROR';
      row.error=String(error?.stack||error?.message||error);
      console.log('Great Rhino branch='+branch+' ERROR '+String(error?.message||error));
    } finally {
      results.push(row);
      await close(s);
    }
  }
  return results;
}

async function triggerPurchaseSpin(frame) {
  return frame.evaluate(()=>{
    try {
      const event=globalThis.Vars?.Evt_ToServer_RequestSpin || globalThis.Vars?.Evt_DataToCode_Pressed_Spin;
      if(!event||typeof globalThis.XT?.TriggerEvent!=='function') return {ok:false,reason:'spin event unavailable'};
      XT.TriggerEvent(event);
      return {ok:true};
    } catch(error) {
      return {ok:false,reason:String(error?.message||error)};
    }
  });
}

async function gems(browser) {
  const s=await load(browser,'gems-bonanza');
  const row={status:'UNKNOWN',entry:null,steps:[],error:null};
  try {
    const ready=await s.provider.waitReady?.(s.frame,10000);
    if(!ready?.ok) throw new Error('base state not ready: '+(ready?.reason||'unknown'));

    const purchases=await s.provider.listPurchases(s.frame);
    if(!purchases[0]) throw new Error('purchase 0 missing');

    const press=await s.provider.purchase(s.frame,0);
    row.steps.push({kind:'purchase',press});

    const before=s.responses.length;
    const spin=await triggerPurchaseSpin(s.frame);
    row.steps.push({kind:'entry-spin',press:spin});
    await waitForResponse(s.page,s.responses,before,7000);
    await Promise.allSettled([...s.tasks]);

    const gameplay=s.responses.map(exchange).filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
    let last=gameplay.at(-1)||null;
    row.entry=last;

    for(let i=0;i<12;i++) {
      const state=await s.provider.protocolState?.(s.frame);
      const beforeStep=s.responses.length;
      const continuation=await s.provider.continueProtocol(s.frame,last);

      await s.page.waitForTimeout(250);
      await waitForResponse(s.page,s.responses,beforeStep,4500);
      await Promise.allSettled([...s.tasks]);

      const fresh=s.responses.slice(beforeStep)
        .map(exchange)
        .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
      if(fresh.length) last=fresh.at(-1);

      row.steps.push({
        iteration:i,
        state:{
          canSpin:state?.canSpin ?? null,
          stopActive:state?.stopActive ?? null,
          confirmFSActive:state?.confirmFSActive ?? null
        },
        continuation:{
          ok:continuation?.ok ?? false,
          kind:continuation?.kind ?? null,
          reason:continuation?.reason ?? null,
          strategy:continuation?.strategy ?? null
        },
        fresh
      });

      console.log(
        'Gems iteration='+i+
        ' in='+row.steps.at(-1)?.fresh?.[0]?.action+
        ' cont='+(continuation?.kind||'-')+
        ' ok='+(continuation?.ok===true)+
        ' stop='+(state?.stopActive ?? '-')+
        ' fresh='+fresh.length+
        ' last='+(last?.action||'-')+
        '/na:'+(last?.na??'-')+
        '/rs:'+(last?.rs??'-')
      );

      if(
        last &&
        String(last.na||'').toLowerCase()==='s' &&
        String(last.rs||'').toLowerCase()!=='mc' &&
        !last.fsmax &&
        !last.bgid
      ) {
        const snapshot=await s.provider.stateSnapshot?.(s.frame);
        if(snapshot?.canSpin===true) {
          row.status='PASS';
          break;
        }
      }
    }

    if(row.status==='UNKNOWN') {
      row.status=row.steps.some(step=>step?.fresh?.length>0) ? 'PROGRESSED' : 'FAIL';
    }
  } catch(error) {
    row.status='ERROR';
    row.error=String(error?.stack||error?.message||error);
    console.log('Gems ERROR '+String(error?.message||error));
  } finally {
    await close(s);
  }
  return row;
}

const browser=await chromium.launch({headless:true});
const output={
  generatedAt:new Date().toISOString(),
  greatRhino:await greatRhino(browser),
  gems:await gems(browser)
};
await browser.close();

await writeJson('results/pragmatic-edge-cases-smoke.json',output);

const rhinoPass=output.greatRhino.filter(x=>x.status==='PASS').length;
console.log('EDGE SMOKE rhino='+rhinoPass+'/4 gems='+output.gems.status);
if(rhinoPass<4 || !['PASS','PROGRESSED'].includes(output.gems.status)) process.exitCode=1;
