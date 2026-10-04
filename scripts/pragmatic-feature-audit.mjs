#!/usr/bin/env node
import { chromium } from 'playwright';
import { bootstrapSupportedPage, findRuntime } from '../src/providers/index.js';
import {
  summarizeRequest,
  summarizeResponse,
  writeJson
} from '../src/lib/common.js';

const GAMES = [
  ['Great Rhino Megaways','great-rhino-megaways',1],
  ['Wild Beach Party','wild-beach-party',1],
  ['Big Bass Bonanza Keeping It Reel','big-bass-bonanza-keeping-it-reel',1],
  ['Gates of Olympus','gates-of-olympus',1],
  ['Empty the Bank','empty-the-bank',1],
  ['Big Bass Floats My Boat','big-bass-floats-my-boat',2],
  ['Wild West Gold Blazing Bounty','wild-west-gold-blazing-bounty',2],
  ['Fruit Party 2','fruit-party-2',1],
  ['Gems Bonanza','gems-bonanza',1],
  ['Drago Jewels of Fortune','drago-jewels-of-fortune',1],
  ['Starlight Princess','starlight-princess',1]
];

const urlFor = slug =>
  'https://www.pragmaticplay.com/en/games/' + slug + '/?cur=USD&gamelang=en';

function parseForm(text) {
  if (!text || typeof text !== 'string') return {};
  const params = new URLSearchParams(text);
  const out = {};
  for (const [key,value] of params.entries()) out[key] = value;
  return out;
}

function parsedExchange(response) {
  const request = parseForm(response?.requestPostData || '');
  const body = parseForm(response?.body || '');
  return {
    action: request.action ?? null,
    pur: request.pur ?? request.puri ?? null,
    ind: request.ind ?? null,
    lInd: request.lInd ?? null,
    symbol: request.symbol ?? null,
    na: body.na ?? null,
    fs: body.fs ?? null,
    fsmax: body.fsmax ?? null,
    bgid: body.bgid ?? null,
    bgt: body.bgt ?? null,
    end: body.end ?? null,
    bw: body.bw ?? null,
    rs: body.rs ?? null,
    rs_c: body.rs_c ?? null,
    rs_m: body.rs_m ?? null,
    trail: body.trail ?? null,
    rawRequest: request,
    rawResponse: body
  };
}

function numberOrNull(value) {
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

function responseRequiresInput(exchange) {
  if (!exchange) return false;
  if (String(exchange.na||'').toLowerCase()==='b') return true;
  if (exchange.bgid != null && String(exchange.end ?? '') !== '1') return true;
  return false;
}

function responseFeatureActive(exchange) {
  if (!exchange) return false;
  if (responseRequiresInput(exchange)) return true;

  const fs=numberOrNull(exchange.fs);
  const fsmax=numberOrNull(exchange.fsmax);
  if (fsmax != null && fsmax > 0 && fs != null && fs < fsmax) return true;

  if (String(exchange.rs||'').toLowerCase()==='mc') return true;
  if (exchange.trail != null && /pending|feature/i.test(String(exchange.trail))) return true;

  const na=String(exchange.na||'').toLowerCase();
  if (['b','c'].includes(na)) return true;

  return false;
}

function controlText(control) {
  return [
    control?.kind,
    control?.name,
    control?.event,
    control?.method,
    control?.purchaseIndex,
    control?.optionIndex
  ].filter(v=>v!=null).join(' ').toLowerCase();
}

function continuationProtocolKey(exchange) {
  if (!exchange) return 'none';
  return JSON.stringify({
    action:exchange.action ?? null,
    na:exchange.na ?? null,
    fs:exchange.fs ?? null,
    fsmax:exchange.fsmax ?? null,
    bgid:exchange.bgid ?? null,
    bgt:exchange.bgt ?? null,
    end:exchange.end ?? null,
    bw:exchange.bw ?? null,
    rs:exchange.rs ?? null,
    rs_c:exchange.rs_c ?? null,
    rs_m:exchange.rs_m ?? null,
    trail:exchange.trail ?? null,
    ind:exchange.ind ?? null,
    lInd:exchange.lInd ?? null
  });
}


function scoreContinuation(control, exchange) {
  if (control?.active === false) return -10000;
  const text=controlText(control);

  if (/(purchase|buy|rebuy|autoplay|bet|stake|sound|music|settings|rules|history|home|fullscreen|close|cancel|stop.?spin|pressed.?stop)/i.test(text)) {
    return -1000;
  }

  let score=0;

  if (/(confirmfsstart|confirm.*free.?spin|free.?spin.*confirm|evt_datatocode_confirmfsstart)/i.test(text)) {
    score+=1000;
  }

  if (responseRequiresInput(exchange)) {
    if (/(bonus|pick|select|choice|option|itempicked|o_\d|button\d|confirm)/i.test(text)) score+=800;
    if (/(continue|start|ok)/i.test(text)) score+=450;
  } else {
    if (/(continue|collect|start|ok)/i.test(text)) score+=500;
    if (/(free.?spin|respin)/i.test(text)) score+=450;
    if (/(startspin|start.?spin|pressed.?spin|^.*\bspin\b.*$)/i.test(text)) score+=320;
    else if (/(spin|play)/i.test(text)) score+=120;
  }

  if (/xtbutton/i.test(text)) score+=30;
  return score;
}

async function waitGameplayQuiet(page, responses, {
  maxMs=15000,
  quietMs=2200,
  minMs=500
}={}) {
  const started=Date.now();
  let lastCount=responses.length;
  let lastChange=Date.now();

  while (Date.now()-started < maxMs) {
    await page.waitForTimeout(180);
    if (responses.length!==lastCount) {
      lastCount=responses.length;
      lastChange=Date.now();
    }
    if (
      Date.now()-started >= minMs &&
      Date.now()-lastChange >= quietMs
    ) break;
  }

  return {
    waitedMs:Date.now()-started,
    responses:responses.length
  };
}

async function snapshotState(provider, frame) {
  try { return await provider.stateSnapshot(frame); }
  catch { return null; }
}

async function waitPragmaticRuntimeReady(provider, frame, page, exchange, maxMs = 12_000) {
  const started=Date.now();
  let last=null;

  while (Date.now()-started < maxMs) {
    last=await snapshotState(provider,frame);
    const rb=last?.runtimeButtons || {};

    const needsInput=responseRequiresInput(exchange);
    const featureActive=responseFeatureActive(exchange);

    const actionable=
      rb.introCloseActive === true ||
      rb.bonusContinueActive === true ||
      rb.freeSpinsContinueActive === true ||
      Number(rb.activePickerCount || 0) > 0 ||
      last?.canSpin === true ||
      rb.spinActive === true;

    const animationRunning=rb.stopActive === true;

    if (!animationRunning && actionable) {
      return {
        ok:true,
        waitedMs:Date.now()-started,
        snapshot:last,
        reason:'runtime-actionable'
      };
    }

    // Protocol can itself provide the next action even while every UI control
    // remains disabled (e.g. purchased free spins waiting for ConfirmFSStart).
    if (!animationRunning && featureActive && !needsInput) {
      return {
        ok:true,
        waitedMs:Date.now()-started,
        snapshot:last,
        reason:'protocol-actionable'
      };
    }

    if (
      !animationRunning &&
      !featureActive &&
      !needsInput &&
      last?.canSpin !== false
    ) {
      return {
        ok:true,
        waitedMs:Date.now()-started,
        snapshot:last,
        reason:'runtime-settled'
      };
    }

    await page.waitForTimeout(180);
  }

  return {
    ok:false,
    waitedMs:Date.now()-started,
    snapshot:last,
    reason:'runtime-ready-timeout'
  };
}

function terminalCandidate(exchange, snapshot) {
  if (!exchange) return false;
  if (responseFeatureActive(exchange)) return false;

  const na=String(exchange.na||'').toLowerCase();
  if (na && na!=='s') return false;

  if (snapshot?.featurePurchaseWindowIsOpen === true) return false;
  if (snapshot?.canSpin === false) return false;

  return na==='s' || snapshot?.canSpin===true;
}

async function runPurchase(browser, gameName, slug, expectedCount, purchaseIndex, preBaseSelectionIndex = null) {
  let context=await browser.newContext({viewport:{width:1440,height:900}});
  let page=await context.newPage();
  const requests=[];
  const responses=[];
  const responseTasks=new Set();
  let serverPurInit=null;

  const onRequest=req=>{
    if (!/gameService/i.test(req.url())) return;
    requests.push(summarizeRequest(req));
  };

  const onResponse=response=>{
    if (!/gameService/i.test(response.url())) return;

    const task=(async()=>{
      const summary=await summarizeResponse(response);
      responses.push(summary);

      const req=parseForm(summary.requestPostData||'');
      if (req.action==='doInit') {
        const body=parseForm(summary.body||'');
        const raw=body.purInit ?? null;
        if (raw==null) {
          serverPurInit={count:0,options:[]};
        } else {
          let decoded=raw;
          try { decoded=decodeURIComponent(raw); } catch {}
          let parsed=null;
          try { parsed=JSON.parse(decoded); } catch {}
          let options=[];
          if (Array.isArray(parsed)) options=parsed;
          else if (parsed && Array.isArray(parsed.options)) options=parsed.options;
          else options=(decoded.match(/\{[^{}]*\}/g)||[]).map((x,i)=>({index:i,raw:x}));
          serverPurInit={count:options.length,options};
        }

        try {
          const frame=response.request().frame();
          await frame.evaluate(value=>{
            globalThis.__parserPragmaticPurInit=value;
          },serverPurInit);
        } catch {}
      }
    })().catch(()=>{}).finally(()=>responseTasks.delete(task));

    responseTasks.add(task);
  };

  page.on('request',onRequest);
  page.on('response',onResponse);

  const result={
    game:gameName,
    slug,
    expectedPurchaseCount:expectedCount,
    purchaseIndex,
    preBaseSelectionIndex,
    preBaseSelection:null,
    status:'UNKNOWN',
    error:null,
    detectedCount:null,
    serverCount:null,
    purchasePress:null,
    entry:null,
    terminal:null,
    steps:[],
    requests,
    responses
  };

  try {
    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);

    const runtime=await findRuntime(page,30000);
    if (!runtime || runtime.provider.id!=='pragmatic') {
      throw new Error('Pragmatic runtime not found');
    }

    const provider=runtime.provider;
    let frame=runtime.frame;

    await page.waitForTimeout(500);
    await Promise.allSettled([...responseTasks]);

    let discoveryReady=await provider.waitReady?.(frame,5000).catch(()=>null);
    if (!discoveryReady?.ok && discoveryReady?.preBaseSelection === true) {
      const selections=await provider.listPreBaseSelections?.(frame) ?? [];
      const branchIndex=
        preBaseSelectionIndex == null
          ? 0
          : Number(preBaseSelectionIndex);
      const selection=selections[branchIndex];
      if (!selection) {
        throw new Error(
          'pre-base selection unavailable index='+branchIndex+
          ' count='+selections.length
        );
      }
      const press=await provider.pressPreBaseSelection(frame,selection);
      result.preBaseSelection={selection,press,phase:'discovery'};
      if (!press?.ok) throw new Error('pre-base selection press failed: '+(press?.reason||'unknown'));
      await page.waitForTimeout(600);

      const refreshedDiscoveryRuntime=await findRuntime(page,10000).catch(()=>null);
      if (
        refreshedDiscoveryRuntime?.provider?.id === 'pragmatic'
      ) {
        frame=refreshedDiscoveryRuntime.frame;
      }

      discoveryReady=await provider.waitReady?.(frame,10000).catch(()=>null);
      if (!discoveryReady?.ok) {
        throw new Error('discovery base state not ready after pre-base selection: '+(discoveryReady?.reason||'unknown'));
      }
    }

    const options=await provider.listPurchases(frame);
    result.detectedCount=options.length;
    result.serverCount=serverPurInit?.count ?? null;

    if (options.length!==expectedCount) {
      throw new Error(
        'purchase count mismatch expected='+expectedCount+
        ' detected='+options.length+
        ' server='+(serverPurInit?.count ?? '-')
      );
    }

    // listPurchases() is allowed to open lazy Buy Feature UI. A page reload in
    // the same BrowserContext can keep provider/session state, so it is NOT a clean
    // purchase execution session. Production creates a fresh context per purchase.
    await Promise.allSettled([...responseTasks]);
    page.off('request',onRequest);
    page.off('response',onResponse);
    await context.close();

    requests.length=0;
    responses.length=0;
    serverPurInit=null;

    context=await browser.newContext({viewport:{width:1440,height:900}});
    page=await context.newPage();
    page.on('request',onRequest);
    page.on('response',onResponse);

    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);

    let executionRuntime=await findRuntime(page,30000);
    if(!executionRuntime || executionRuntime.provider.id!=='pragmatic') {
      throw new Error('Pragmatic runtime not found for clean purchase execution');
    }

    frame=executionRuntime.frame;
    let executionReady=await executionRuntime.provider.waitReady?.(frame,5000).catch(()=>null);

    if (!executionReady?.ok && executionReady?.preBaseSelection === true) {
      const selections=await executionRuntime.provider.listPreBaseSelections?.(frame) ?? [];
      const branchIndex=
        preBaseSelectionIndex == null
          ? 0
          : Number(preBaseSelectionIndex);
      const selection=selections[branchIndex];
      if (!selection) {
        throw new Error(
          'execution pre-base selection unavailable index='+branchIndex+
          ' count='+selections.length
        );
      }

      const press=await executionRuntime.provider.pressPreBaseSelection(frame,selection);
      result.preBaseSelection={
        ...(result.preBaseSelection || {}),
        execution:{selection,press}
      };
      if (!press?.ok) {
        throw new Error('execution pre-base selection press failed: '+(press?.reason||'unknown'));
      }

      await page.waitForTimeout(600);

      const refreshedExecutionRuntime=await findRuntime(page,10000).catch(()=>null);
      if (
        refreshedExecutionRuntime?.provider?.id === 'pragmatic'
      ) {
        executionRuntime=refreshedExecutionRuntime;
        frame=executionRuntime.frame;
      }

      executionReady=await executionRuntime.provider.waitReady?.(frame,10000).catch(()=>null);
    }

    if(!executionReady?.ok) {
      throw new Error('clean Pragmatic base state not ready: '+(executionReady?.reason||'unknown'));
    }

    const requestBase=requests.length;
    const responseBase=responses.length;

    result.purchasePress=await executionRuntime.provider.purchase(frame,purchaseIndex);
    await page.waitForTimeout(500);

    let newRequests=requests.slice(requestBase);
    let hasPurchaseSpin=newRequests.some(item=>{
      const p=parseForm(item.postData||'');
      return p.action==='doSpin' && (p.pur!=null || p.puri!=null);
    });

    if (result.purchasePress?.ok && result.purchasePress?.needsSpin && !hasPurchaseSpin) {
      const spin=await executionRuntime.provider.press(frame,'spin');
      result.steps.push({kind:'purchase-spin-fallback',press:spin});
    }

    await waitGameplayQuiet(page,responses,{maxMs:9000,quietMs:1500,minMs:600});
    await Promise.allSettled([...responseTasks]);

    newRequests=requests.slice(requestBase);
    const newResponses=responses.slice(responseBase);
    const exchanges=newResponses.map(parsedExchange)
      .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));

    const purchaseExchange=exchanges.find(x=>
      x.action==='doSpin' &&
      (x.pur!=null || x.rawRequest?.puri!=null)
    ) || exchanges[0] || null;

    result.entry=purchaseExchange;

    const actualPur=
      purchaseExchange?.pur ??
      purchaseExchange?.rawRequest?.puri ??
      null;

    if (
      actualPur!=null &&
      Number(actualPur)!==Number(purchaseIndex)
    ) {
      throw new Error('purchase selector mismatch expected='+purchaseIndex+' got='+actualPur);
    }

    let lastResponseIndex=responses.length;
    let lastExchange=exchanges.at(-1) || null;
    const seenControls=new Set();

    for (let iteration=0; iteration<48; iteration++) {
      await Promise.allSettled([...responseTasks]);

      const runtimeReady=await waitPragmaticRuntimeReady(
        executionRuntime.provider,
        frame,
        page,
        lastExchange,
        12_000
      );
      const snapshot=runtimeReady.snapshot ?? await snapshotState(executionRuntime.provider,frame);

      result.steps.push({
        kind:'runtime-ready',
        iteration,
        ready:runtimeReady
      });

      if (terminalCandidate(lastExchange,snapshot)) {
        // Give automatic feature activity one final chance before declaring terminal.
        const before=responses.length;
        const quiet=await waitGameplayQuiet(page,responses,{
          maxMs:2200,
          quietMs:1200,
          minMs:500
        });
        await Promise.allSettled([...responseTasks]);

        if (responses.length===before) {
          result.terminal={
            detected:true,
            iteration,
            snapshot,
            exchange:lastExchange,
            quiet
          };
          result.status='PASS';
          break;
        }
      }

      const lastNa=String(lastExchange?.na||'').toLowerCase();
      const lastFs=numberOrNull(lastExchange?.fs);
      const lastFsMax=numberOrNull(lastExchange?.fsmax);
      const rb=snapshot?.runtimeButtons || {};

      // Runtime interstitials have priority over forcing another spin.
      // They are only used when the runtime marks the corresponding control active.
      const runtimeInterstitial =
        rb.introCloseActive === true
          ? 'intro_close_pressed'
          : rb.bonusContinueActive === true
            ? 'bonus_rounds_on_continue_pressed'
            : null;

      if (runtimeInterstitial) {
        const beforeContinue=responses.length;
        const press=await executionRuntime.provider.press(frame,runtimeInterstitial).catch(error=>({
          ok:false,
          reason:String(error?.message||error)
        }));
        const wait=await waitGameplayQuiet(page,responses,{
          maxMs:4200,
          quietMs:1200,
          minMs:350
        });
        await Promise.allSettled([...responseTasks]);
        const fresh=responses.slice(beforeContinue)
          .map(parsedExchange)
          .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
        if (fresh.length) lastExchange=fresh.at(-1);

        result.steps.push({
          kind:'runtime-interstitial',
          iteration,
          action:runtimeInterstitial,
          press,
          responses:fresh,
          wait
        });

        if (fresh.length) {
          lastResponseIndex=responses.length;
          continue;
        }

        // If the interstitial merely unlocks the next spin, continue below.
      }

      // Provider-owned protocol continuation. This covers purchased free-spin
      // start confirmation, feature spins, collect paths and explicit bonus picks.
      if (typeof executionRuntime.provider.continueProtocol === 'function' && lastExchange) {
        const beforeProtocol=responses.length;
        const continuation=await executionRuntime.provider
          .continueProtocol(frame,lastExchange)
          .catch(error=>({ok:false,reason:String(error?.message||error)}));

        if (continuation?.needsSelection) {
          const choices=Array.isArray(continuation.choices) ? continuation.choices : [];

          if (choices.length) {
            const choice=choices[0];
            const press=await executionRuntime.provider
              .pressProtocolChoice(frame,choice)
              .catch(error=>({ok:false,reason:String(error?.message||error)}));

            const wait=await waitGameplayQuiet(page,responses,{
              maxMs:6200,
              quietMs:1500,
              minMs:450
            });
            await Promise.allSettled([...responseTasks]);

            const fresh=responses.slice(beforeProtocol)
              .map(parsedExchange)
              .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));

            if (fresh.length) lastExchange=fresh.at(-1);

            result.steps.push({
              kind:'protocol-pick',
              iteration,
              choice,
              availableChoices:choices,
              press,
              responses:fresh,
              wait
            });

            if (press?.ok) {
              lastResponseIndex=responses.length;
              continue;
            }
          }
        } else if (continuation?.ok) {
          const wait=await waitGameplayQuiet(page,responses,{
            maxMs:6200,
            quietMs:1500,
            minMs:450
          });
          await Promise.allSettled([...responseTasks]);

          const fresh=responses.slice(beforeProtocol)
            .map(parsedExchange)
            .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));

          if (fresh.length) lastExchange=fresh.at(-1);

          result.steps.push({
            kind:continuation.kind || 'protocol',
            iteration,
            press:continuation,
            responses:fresh,
            wait
          });

          // ConfirmFSStart can be a local-only transition. Loop again even when it
          // emitted no request; the next protocol pass can then trigger the spin.
          lastResponseIndex=responses.length;
          continue;
        }
      }

      // Observe automatic progression before pressing anything.
      const beforeAuto=responses.length;
      const auto=await waitGameplayQuiet(page,responses,{
        maxMs:2600,
        quietMs:1300,
        minMs:450
      });
      await Promise.allSettled([...responseTasks]);

      if (responses.length>beforeAuto) {
        const fresh=responses.slice(beforeAuto)
          .map(parsedExchange)
          .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));
        if (fresh.length) lastExchange=fresh.at(-1);
        result.steps.push({
          kind:'automatic',
          iteration,
          responses:fresh,
          wait:auto
        });
        lastResponseIndex=responses.length;
        continue;
      }

      let controls=await executionRuntime.provider.listControls(frame).catch(()=>[]);
      controls=controls
        .map(control=>({control,score:scoreContinuation(control,lastExchange)}))
        .filter(item=>item.score>0)
        .sort((a,b)=>b.score-a.score);

      const choice=controls.find(item=>{
        const key=JSON.stringify({
          kind:item.control?.kind,
          name:item.control?.name,
          event:item.control?.event,
          purchaseIndex:item.control?.purchaseIndex,
          optionIndex:item.control?.optionIndex,
          occurrence:item.control?.occurrence,
          protocolState:continuationProtocolKey(lastExchange)
        });
        if (seenControls.has(key)) return false;
        item.key=key;
        return true;
      });

      if (!choice) {
        result.status='BLOCKED';
        result.terminal={
          detected:false,
          iteration,
          reason:'no continuation control',
          snapshot,
          exchange:lastExchange,
          runtimeReady,
          controls:(await executionRuntime.provider.listControls(frame).catch(()=>[]))
            .slice(0,120)
            .map(control=>({
              kind:control?.kind ?? null,
              name:control?.name ?? null,
              event:control?.event ?? null,
              active:control?.active ?? null,
              purchaseIndex:control?.purchaseIndex ?? null,
              optionIndex:control?.optionIndex ?? null,
              type:control?.type ?? null
            }))
        };
        break;
      }

      seenControls.add(choice.key);

      const beforeActionResponses=responses.length;
      const press=await executionRuntime.provider.pressControl(frame,choice.control).catch(error=>({
        ok:false,
        reason:String(error?.message||error)
      }));

      const wait=await waitGameplayQuiet(page,responses,{
        maxMs:3600,
        quietMs:1300,
        minMs:500
      });
      await Promise.allSettled([...responseTasks]);

      const fresh=responses.slice(beforeActionResponses)
        .map(parsedExchange)
        .filter(x=>['doSpin','doBonus','doCollect'].includes(x.action));

      if (fresh.length) lastExchange=fresh.at(-1);

      result.steps.push({
        kind:'input',
        iteration,
        control:choice.control,
        score:choice.score,
        press,
        responses:fresh,
        wait
      });

      lastResponseIndex=responses.length;
    }

    if (result.status==='UNKNOWN') {
      result.status='BLOCKED';
      result.terminal={
        detected:false,
        reason:'iteration limit reached',
        exchange:lastExchange,
        snapshot:await snapshotState(executionRuntime.provider,frame)
      };
    }

    const postPurchaseRequests=requests.slice(requestBase)
      .map(item=>({
        endpoint:item.endpoint,
        method:item.method,
        payload:item.postData
      }));

    const postPurchaseResponses=responses.slice(responseBase)
      .map(item=>({
        endpoint:item.endpoint,
        status:item.status,
        requestPayload:item.requestPostData,
        responsePayload:item.body
      }));

    result.capture={
      requests:postPurchaseRequests,
      responses:postPurchaseResponses
    };

    console.log(
      gameName+
      ' branch='+(preBaseSelectionIndex ?? '-')+
      ' purchase='+purchaseIndex+
      ' status='+result.status+
      ' requests='+postPurchaseRequests.length+
      ' responses='+postPurchaseResponses.length+
      ' entry='+(result.entry?.action||'-')+
      '/pur:'+(result.entry?.pur ?? result.entry?.rawRequest?.puri ?? '-')+
      ' terminal='+(result.terminal?.detected===true)
    );
  } catch (error) {
    result.status='ERROR';
    result.error=String(error?.stack||error?.message||error);
    console.log(gameName+' branch='+(preBaseSelectionIndex ?? '-')+' purchase='+purchaseIndex+' ERROR '+String(error?.message||error));
  } finally {
    await Promise.allSettled([...responseTasks]);
    page.off('request',onRequest);
    page.off('response',onResponse);
    await context.close();
  }

  return result;
}

async function probePreBaseBranches(browser, slug) {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const responseTasks=new Set();
  let handler=null;

  try {
    handler=response=>{
      if (!/gameService/i.test(response.url())) return;
      const task=(async()=>{
        const summary=await summarizeResponse(response);
        const req=parseForm(summary.requestPostData||'');
        if (req.action!=='doInit') return;
        const body=parseForm(summary.body||'');
        const raw=body.purInit ?? null;
        let options=[];
        if (raw!=null) {
          let decoded=raw;
          try { decoded=decodeURIComponent(raw); } catch {}
          let parsed=null;
          try { parsed=JSON.parse(decoded); } catch {}
          if (Array.isArray(parsed)) options=parsed;
          else if (parsed && Array.isArray(parsed.options)) options=parsed.options;
        }
        try {
          await response.request().frame().evaluate(value=>{
            globalThis.__parserPragmaticPurInit={count:value.length,options:value};
          },options);
        } catch {}
      })().catch(()=>{}).finally(()=>responseTasks.delete(task));
      responseTasks.add(task);
    };
    page.on('response',handler);

    await page.goto(urlFor(slug),{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(2200);
    await bootstrapSupportedPage(page);
    const runtime=await findRuntime(page,12000);
    if (!runtime || runtime.provider.id!=='pragmatic') return [null];

    const selections=await runtime.provider.listPreBaseSelections?.(runtime.frame) ?? [];
    if (!selections.length) return [null];
    return selections.map((_,index)=>index);
  } catch {
    return [null];
  } finally {
    await Promise.allSettled([...responseTasks]);
    if (handler) page.off('response',handler);
    await context.close();
  }
}

const browser=await chromium.launch({headless:true});
const results=[];

for (const [gameName,slug,count] of GAMES) {
  const branches=await probePreBaseBranches(browser,slug);
  for (const branchIndex of branches) {
    for (let purchaseIndex=0; purchaseIndex<count; purchaseIndex++) {
      results.push(
        await runPurchase(
          browser,
          gameName,
          slug,
          count,
          purchaseIndex,
          branchIndex
        )
      );
    }
  }
}

await browser.close();

const summary={
  generatedAt:new Date().toISOString(),
  games:GAMES.length,
  purchases:results.length,
  pass:results.filter(x=>x.status==='PASS').length,
  blocked:results.filter(x=>x.status==='BLOCKED').length,
  errors:results.filter(x=>x.status==='ERROR').length,
  results
};

await writeJson('results/pragmatic-feature-audit.json',summary);
console.log(
  'FEATURE AUDIT DONE purchases='+summary.purchases+
  ' pass='+summary.pass+
  ' blocked='+summary.blocked+
  ' errors='+summary.errors
);

if (summary.blocked || summary.errors) process.exitCode=1;
