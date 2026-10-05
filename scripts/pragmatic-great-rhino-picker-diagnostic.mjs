#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import { summarizeResponse, writeJson } from '../src/lib/common.js';

const URL='https://www.pragmaticplay.com/en/games/great-rhino-megaways/?cur=USD&gamelang=en';

function form(text='') {
  const out={};
  const p=new URLSearchParams(text);
  for(const [k,v] of p) out[k]=v;
  return out;
}

function parsePurInit(text='') {
  const body=form(text);
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

async function inspectRuntime(frame, selection) {
  return frame.evaluate(({selection})=>{
    const roots=globalThis.globalRuntime?.sceneRoots||[];

    const activeButtons=[];
    if(globalThis.XTButton) {
      for(let ri=0;ri<roots.length;ri++) {
        let buttons=[];
        try { buttons=roots[ri].GetComponentsInChildren(XTButton,true)||[]; } catch {}
        for(const button of buttons) {
          try {
            if(button.gameObject?.activeInHierarchy!==true) continue;
            activeButtons.push({
              root:ri,
              name:String(button.gameObject?.name||''),
              event:String(button.eventToCode?.name||''),
              action:button.action??null,
              useParam:button.useParam??null,
              paramValue:button.paramValue??null,
              paramName:button.param?.name??null,
              canClick:typeof button.OnClick==='function',
              canPress:typeof button.OnPress==='function'
            });
          } catch {}
        }
      }
    }

    const props=(object,maxDepth=4)=>{
      const names=[];
      const seen=new Set();
      let current=object;
      for(let depth=0; current && depth<maxDepth; depth++) {
        for(const name of Object.getOwnPropertyNames(current)) {
          if(seen.has(name)) continue;
          seen.add(name);
          names.push(name);
        }
        current=Object.getPrototypeOf(current);
      }
      return names;
    };

    const primitiveFields=object=>{
      const out={};
      if(!object) return out;
      for(const name of props(object,3)) {
        if(name==='constructor') continue;
        try {
          const value=object[name];
          if(value==null || ['string','number','boolean'].includes(typeof value)) out[name]=value??null;
        } catch {}
      }
      return out;
    };

    const methodNames=object=>props(object,4).filter(name=>{
      try { return typeof object?.[name]==='function'; } catch { return false; }
    });

    const methodDetails=(object,rx)=>methodNames(object)
      .filter(name=>rx.test(name))
      .slice(0,30)
      .map(name=>{
        let fn=null;
        let source=null;
        let length=null;
        try {
          fn=object?.[name];
          length=typeof fn==='function' ? fn.length : null;
          source=typeof fn==='function'
            ? Function.prototype.toString.call(fn).slice(0,4000)
            : null;
        } catch {}
        return {name,length,source};
      });

    let target=null;
    let rootIndex=Number(selection?.root);
    const root=roots[rootIndex];
    if(root && globalThis.XTButton) {
      let buttons=[];
      try { buttons=root.GetComponentsInChildren(XTButton,true)||[]; } catch {}
      const matches=buttons.filter(button=>{
        try {
          return (
            String(button.gameObject?.name||'')===String(selection?.name||'') &&
            String(button.eventToCode?.name||'')===String(selection?.event||'')
          );
        } catch { return false; }
      });
      target=matches[Number(selection?.occurrence||0)]||matches[0]||null;
    }

    const varSnapshot={};
    const varKeys=Object.keys(globalThis.Vars||{}).filter(key=>
      /fsbg|bonus.*pick|pick.*bonus|spinswon|free.*spin.*option|resume.*free|picked|selected.*option|option.*selected/i.test(key)
    );

    for(const key of varKeys) {
      const ref=Vars[key];
      if(!ref) continue;
      const values={};
      for(const [getter,label] of [
        ['GetBool','bool'],
        ['GetInt','int'],
        ['GetFloat','float'],
        ['GetString','string'],
        ['GetObject','object']
      ]) {
        try {
          if(typeof XT?.[getter]!=='function') continue;
          const value=XT[getter](ref);
          if(value==null || ['string','number','boolean'].includes(typeof value)) {
            values[label]=value??null;
          } else if(label==='object') {
            values.objectConstructor=value?.constructor?.name??null;
            values.objectFields=primitiveFields(value);
            values.objectMethods=methodNames(value).filter(name=>/pick|select|option|close|confirm|start|continue/i.test(name)).slice(0,60);
          }
        } catch {}
      }
      if(Object.keys(values).length) varSnapshot[key]=values;
    }

    const globalClasses=[];
    for(const key of Object.keys(globalThis)) {
      if(!/fsbg|pick|confirm|free.*spin.*option|bonus.*option/i.test(key)) continue;
      const Ctor=globalThis[key];
      if(typeof Ctor!=='function') continue;
      let count=0;
      const examples=[];
      for(let ri=0;ri<roots.length;ri++) {
        let items=[];
        try { items=roots[ri].GetComponentsInChildren(Ctor,true)||[]; } catch {}
        count+=items.length;
        for(const item of items.slice(0,6)) {
          examples.push({
            root:ri,
            name:(()=>{try{return item.gameObject?.name??null}catch{return null}})(),
            active:(()=>{try{return item.gameObject?.activeInHierarchy??null}catch{return null}})(),
            fields:primitiveFields(item),
            methods:methodNames(item).filter(name=>/pick|select|option|click|press|close|confirm|start|continue/i.test(name)).slice(0,80),
            methodDetails:methodDetails(item,/pick|select|send|handler|click|press|close|confirm|start|continue/i)
          });
        }
      }
      if(count) globalClasses.push({key,count,examples});
    }

    let gameObjectSummary=null;
    if(target?.gameObject) {
      const go=target.gameObject;
      gameObjectSummary={
        fields:primitiveFields(go),
        methods:methodNames(go).slice(0,100)
      };

      const componentKeys=['components','_components','m_Components'];
      for(const k of componentKeys) {
        try {
          const value=go[k];
          if(Array.isArray(value)) {
            gameObjectSummary[k]=value.slice(0,30).map(item=>({
              constructor:item?.constructor?.name??null,
              fields:primitiveFields(item),
              methods:methodNames(item).filter(name=>/pick|select|option|click|press|close|confirm|start|continue/i.test(name)).slice(0,60)
            }));
          }
        } catch {}
      }
    }

    return {
      activeButtons,
      target:target?{
        constructor:target?.constructor?.name??null,
        fields:primitiveFields(target),
        methods:methodNames(target).slice(0,120),
        methodDetails:methodDetails(target,/onclick|onpress|doit|pick|select|send|close|confirm/i),
        eventToCode:target.eventToCode?{
          constructor:target.eventToCode?.constructor?.name??null,
          fields:primitiveFields(target.eventToCode),
          methods:methodNames(target.eventToCode).slice(0,80)
        }:null,
        gameObject:gameObjectSummary
      }:null,
      varSnapshot,
      globalClasses
    };
  },{selection});
}

function buttonKey(button) {
  return [
    button?.root,
    button?.name,
    button?.event,
    button?.action,
    button?.useParam,
    button?.paramValue,
    button?.paramName
  ].join('|');
}

function diffButtons(before,after) {
  const a=new Map((before||[]).map(x=>[buttonKey(x),x]));
  const b=new Map((after||[]).map(x=>[buttonKey(x),x]));
  return {
    added:[...b.entries()].filter(([k])=>!a.has(k)).map(([,v])=>v),
    removed:[...a.entries()].filter(([k])=>!b.has(k)).map(([,v])=>v)
  };
}

function diffVars(before,after) {
  const out={};
  const keys=new Set([...Object.keys(before||{}),...Object.keys(after||{})]);
  for(const key of keys) {
    const a=JSON.stringify(before?.[key]??null);
    const b=JSON.stringify(after?.[key]??null);
    if(a!==b) out[key]={before:before?.[key]??null,after:after?.[key]??null};
  }
  return out;
}

async function oneBranch(browser,branch) {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const responses=[];
  const tasks=new Set();

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

  const row={branch,status:'UNKNOWN',selection:null,before:null,afterClick:null,afterPress:null,afterEvent:null,diffs:{},error:null};

  try {
    await page.goto(URL,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,30000);
    if(!runtime||runtime.provider.id!=='pragmatic') throw new Error('runtime not found');

    const selections=await runtime.provider.listPreBaseSelections(runtime.frame);
    row.selection=selections[branch];
    if(!row.selection) throw new Error('selection missing');

    row.before=await inspectRuntime(runtime.frame,row.selection);

    for (const cls of row.before?.globalClasses || []) {
      if (cls.key !== 'BonusPickConnection') continue;
      for (const ex of cls.examples || []) {
        console.log('RHINO_CONN_EXAMPLE name='+String(ex.name||'-')+' fields='+JSON.stringify(ex.fields||{}));
        for (const m of ex.methodDetails || []) {
          console.log(
            'RHINO_CONN_METHOD name='+m.name+
            ' len='+m.length+
            ' src='+String(m.source||'').replace(/\s+/g,' ').slice(0,2200)
          );
        }
      }
    }

    const strategies=[
      ['click',async()=>runtime.frame.evaluate(sel=>{
        const roots=globalThis.globalRuntime?.sceneRoots||[];
        const root=roots[Number(sel.root)];
        const buttons=root?.GetComponentsInChildren?.(XTButton,true)||[];
        const t=buttons.find(b=>
          String(b.gameObject?.name||'')===String(sel.name||'') &&
          String(b.eventToCode?.name||'')===String(sel.event||'')
        );
        if(!t||typeof t.OnClick!=='function') return {ok:false};
        t.OnClick();
        return {ok:true};
      },row.selection)],
      ['press',async()=>runtime.frame.evaluate(sel=>{
        const roots=globalThis.globalRuntime?.sceneRoots||[];
        const root=roots[Number(sel.root)];
        const buttons=root?.GetComponentsInChildren?.(XTButton,true)||[];
        const t=buttons.find(b=>
          String(b.gameObject?.name||'')===String(sel.name||'') &&
          String(b.eventToCode?.name||'')===String(sel.event||'')
        );
        if(!t||typeof t.OnPress!=='function') return {ok:false};
        t.OnPress(true); t.OnPress(false);
        return {ok:true};
      },row.selection)]
    ];

    let prior=row.before;
    for(const [name,fn] of strategies) {
      const action=await fn();
      await page.waitForTimeout(500);
      const state=await inspectRuntime(runtime.frame,row.selection);
      row['after'+name[0].toUpperCase()+name.slice(1)]={action,state};
      row.diffs[name]=diffVars(prior.varSnapshot,state.varSnapshot);
      row.diffs[name+'Buttons']=diffButtons(prior.activeButtons,state.activeButtons);
      prior=state;
    }

    row.status='DONE';
    console.log(
      'Rhino diagnostic branch='+branch+
      ' varsBefore='+Object.keys(row.before.varSnapshot).length+
      ' classes='+row.before.globalClasses.map(x=>x.key+':'+x.count).join(',')+
      ' clickDiff='+Object.keys(row.diffs.click||{}).join(',')+
      ' pressDiff='+Object.keys(row.diffs.press||{}).join(',')
    );
  } catch(error) {
    row.status='ERROR';
    row.error=String(error?.stack||error?.message||error);
    console.log('Rhino diagnostic branch='+branch+' ERROR '+String(error?.message||error));
  } finally {
    await Promise.allSettled([...tasks]);
    page.off('response',handler);
    await context.close();
  }

  return row;
}

const browser=await chromium.launch({headless:true});
const results=[];
for(const branch of [0]) results.push(await oneBranch(browser,branch));
await browser.close();

await writeJson('results/pragmatic-great-rhino-picker-diagnostic.json',{
  generatedAt:new Date().toISOString(),
  results
});
