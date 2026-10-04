#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { summarizeRequest, summarizeResponse, writeJson } from '../src/lib/common.js';

const URL='https://www.pragmaticplay.com/en/games/gates-of-olympus/?cur=USD&gamelang=en';

async function runCase(browser, strategy) {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const requests=[];
  const responses=[];
  const tasks=new Set();

  const onRequest=req=>{
    if (/gameService/i.test(req.url())) requests.push(summarizeRequest(req));
  };
  const onResponse=res=>{
    if (!/gameService/i.test(res.url())) return;
    const task=summarizeResponse(res)
      .then(x=>responses.push(x))
      .catch(()=>{})
      .finally(()=>tasks.delete(task));
    tasks.add(task);
  };
  page.on('request',onRequest);
  page.on('response',onResponse);

  const result={strategy,press:null,requests:[],responses:[],error:null};

  try {
    await page.goto(URL,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,30000);
    if (!runtime || runtime.provider.id!=='pragmatic') throw new Error('runtime not found');

    await runtime.provider.waitReady?.(runtime.frame, 10_000);
    await page.waitForTimeout(300);
    await Promise.allSettled([...tasks]);
    const reqBase=requests.length;
    const resBase=responses.length;

    if (strategy==='button-onpress') {
      result.press=await runtime.provider.press(runtime.frame,'spin');
    } else if (strategy==='xt-trigger-event') {
      result.press=await runtime.frame.evaluate(() => {
        try {
          const event=Vars.Evt_DataToCode_Pressed_Spin || 'Evt_DataToCode_Pressed_Spin';
          if (typeof XT.TriggerEvent!=='function') return {ok:false,reason:'XT.TriggerEvent unavailable'};
          XT.TriggerEvent(event);
          return {ok:true,strategy:'XT.TriggerEvent',event:event?.name ?? String(event)};
        } catch (error) {
          return {ok:false,reason:String(error?.message||error)};
        }
      });
    } else if (strategy==='button-onclick') {
      result.press=await runtime.frame.evaluate(() => {
        const roots=globalRuntime.sceneRoots||[];
        const buttons=[];
        for(const root of roots){
          try{buttons.push(...(root.GetComponentsInChildren(XTButton,true)||[]));}catch{}
        }
        const button=buttons.find(b=>{
          try{
            return /startspin|spin/i.test(String(b.gameObject?.name||'')) &&
              b.gameObject?.activeInHierarchy!==false;
          }catch{return false;}
        });
        if(!button) return {ok:false,reason:'spin button unavailable'};
        if(typeof button.OnClick!=='function') return {ok:false,reason:'OnClick unavailable'};
        button.OnClick();
        return {ok:true,strategy:'XTButton.OnClick',name:button.gameObject?.name??null};
      });
    }

    await page.waitForTimeout(3000);
    await Promise.allSettled([...tasks]);
    result.requests=requests.slice(reqBase);
    result.responses=responses.slice(resBase);
  } catch(error) {
    result.error=String(error?.stack||error?.message||error);
  } finally {
    page.off('request',onRequest);
    page.off('response',onResponse);
    await context.close();
  }

  return result;
}

const browser=await chromium.launch({headless:true});
const results=[];
for(const strategy of ['button-onpress','xt-trigger-event','button-onclick']){
  const r=await runCase(browser,strategy);
  results.push(r);
  console.log(strategy,'press=',r.press,'requests=',r.requests.map(x=>x.postData));
}
await browser.close();
await writeJson('results/pragmatic-spin-diagnostic.json',{results});
