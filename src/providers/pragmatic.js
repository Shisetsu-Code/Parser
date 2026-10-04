import { normalizeAction } from '../lib/common.js';

const EVENT_MAP = {
  spin: 'Evt_DataToCode_Pressed_Spin',
  confirm_fs_start: 'Evt_DataToCode_ConfirmFSStart',
  bonus_rounds_on_continue_pressed: 'Evt_DataToCode_BonusRoundsOnContinuePressed',
  intro_close_pressed: 'Evt_DataToCode_IntroClosePressed',
  free_spins_window_win_collect_pressed: 'Evt_DataToCode_FreeSpinsWindowWinCollectPressed',
  free_spins_window_lose_collect_pressed: 'Evt_DataToCode_FreeSpinsWindowLoseCollectPressed',
  bonus_result_collect: 'Evt_DataToCode_BonusResultWindow_PressedCollect',
  bonus_pick_item: 'Evt_DataToCode_Pressed_BonusPickItem',
  bet_inc: 'Evt_DataToCode_SmartIncreaseBet',
  bet_increase: 'Evt_DataToCode_SmartIncreaseBet',
  bet_dec: 'Evt_DataToCode_SmartDecreaseBet',
  bet_decrease: 'Evt_DataToCode_SmartDecreaseBet'
};

export const pragmatic = {
  id: 'pragmatic',

  async detect(frame) {
    return frame.evaluate(() => Boolean(window.globalRuntime && window.XT && window.Vars)).catch(() => false);
  },

  async isDemo(frame) {
    return frame.evaluate(() => /demogamesfree\.pragmaticplay\.net$/i.test(location.hostname) || /demo/i.test(location.href)).catch(() => false);
  },

  async waitReady(frame, timeoutMs = 10_000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 10_000);
    let last = null;
    const actions = [];
    const attempted = new Set();

    while (Date.now() < deadline) {
      last = await frame.evaluate(() => {
        const read = fn => { try { return fn(); } catch { return null; } };
        const roots = globalThis.globalRuntime?.sceneRoots || [];
        const safeControls = [];
        const pickerControls = [];

        if (globalThis.XTButton) {
          for (let ri = 0; ri < roots.length; ri++) {
            let buttons = [];
            try { buttons = roots[ri].GetComponentsInChildren(XTButton, true) || []; } catch {}
            for (let bi = 0; bi < buttons.length; bi++) {
              const button = buttons[bi];
              try {
                if (button.gameObject?.activeInHierarchy === false) continue;
                const name = String(button.gameObject?.name || '');
                const event = String(button.eventToCode?.name || '');
                const text = (name + ' ' + event).toLowerCase();

                const normalSpin =
                  /evt_datatocode_pressed_spin/i.test(event) ||
                  (/(?:^|_)spin(?:_|$)/i.test(name) && /pressed_spin/i.test(event));

                const picker =
                  /itempicked|bonuspick|fsbgpick|pickitem|select(?:ed)?option/i.test(text);

                if (picker) {
                  pickerControls.push({
                    root:ri,
                    index:bi,
                    name,
                    event
                  });
                  continue;
                }

                if (normalSpin) continue;

                const safe =
                  /intro.*close|close.*intro|introclosepressed/i.test(text) ||
                  /(?:^|_)(continue|ok|start)(?:_|$)/i.test(name) ||
                  /continuepressed|pressed_continue|confirmintro|intro.*start/i.test(event);

                if (!safe) continue;

                safeControls.push({
                  root:ri,
                  index:bi,
                  name,
                  event,
                  canPress:typeof button.OnPress === 'function',
                  canClick:typeof button.OnClick === 'function'
                });
              } catch {}
            }
          }
        }

        return {
          purInitReady: globalThis.__parserPragmaticPurInit != null,
          canSpin: read(() => window.Vars?.CanSpin ? XT.GetBool(Vars.CanSpin) : null),
          featurePurchaseOpen: read(() =>
            window.Vars?.FeaturePurchaseWindowIsOpen
              ? XT.GetBool(Vars.FeaturePurchaseWindowIsOpen)
              : null
          ),
          gameHasIntro: read(() =>
            window.Vars?.GameHasIntro ? XT.GetBool(Vars.GameHasIntro) : null
          ),
          shouldDisplayIntro: read(() =>
            window.Vars?.ShouldDisplayIntro ? XT.GetBool(Vars.ShouldDisplayIntro) : null
          ),
          disableIntroScreen: read(() =>
            window.Vars?.DisableIntroScreen ? XT.GetBool(Vars.DisableIntroScreen) : null
          ),
          hasIntroCloseEvent: Boolean(window.Vars?.Evt_DataToCode_IntroClosePressed),
          safeControls,
          pickerControls,
          preBaseSelection: pickerControls.length > 0
        };
      }).catch(() => null);

      if (
        last?.purInitReady === true &&
        last?.canSpin === true
      ) {
        return { ok: true, ...last, actions };
      }

      if (last?.canSpin === false) {
        const safeControls = Array.isArray(last?.safeControls) ? last.safeControls : [];

        let acted = false;
        for (const chosen of safeControls) {
          const baseKey = [
            chosen.root,
            chosen.name,
            chosen.event
          ].join('|');

          const strategies = [];
          if (chosen.canClick) strategies.push('click');
          if (chosen.canPress) strategies.push('press');

          for (const strategy of strategies) {
            const key = 'control|' + baseKey + '|' + strategy;
            if (attempted.has(key)) continue;
            attempted.add(key);

            const pressed = await frame.evaluate(({ chosen, strategy }) => {
              try {
                const roots = globalThis.globalRuntime?.sceneRoots || [];
                if (!globalThis.XTButton) return { ok:false, reason:'XTButton unavailable' };

                const root = roots[Number(chosen.root)];
                if (!root) return { ok:false, reason:'root unavailable' };

                const buttons = root.GetComponentsInChildren(XTButton, true) || [];
                const candidates = buttons.filter(button => {
                  try {
                    if (button.gameObject?.activeInHierarchy === false) return false;
                    return (
                      String(button.gameObject?.name || '') === String(chosen.name || '') &&
                      String(button.eventToCode?.name || '') === String(chosen.event || '')
                    );
                  } catch {
                    return false;
                  }
                });

                const button = candidates[0];
                if (!button) return { ok:false, reason:'safe control disappeared' };

                if (strategy === 'click' && typeof button.OnClick === 'function') {
                  button.OnClick();
                  return {
                    ok:true,
                    strategy:'OnClick()',
                    name:chosen.name,
                    event:chosen.event
                  };
                }

                if (strategy === 'press' && typeof button.OnPress === 'function') {
                  button.OnPress(true);
                  button.OnPress(false);
                  return {
                    ok:true,
                    strategy:'OnPress(true/false)',
                    name:chosen.name,
                    event:chosen.event
                  };
                }

                return { ok:false, reason:'requested safe-control strategy unavailable' };
              } catch (error) {
                return { ok:false, reason:String(error?.message || error) };
              }
            }, { chosen, strategy }).catch(error => ({
              ok:false,
              reason:String(error?.message || error)
            }));

            actions.push({
              at: Date.now(),
              kind: 'safe-control',
              control: chosen,
              strategy,
              press: pressed
            });

            await frame.page().waitForTimeout(550);
            acted = true;
            break;
          }

          if (acted) break;
        }

        if (acted) continue;

        const canUseIntroEvent =
          last?.preBaseSelection !== true &&
          last?.hasIntroCloseEvent === true &&
          (
            last?.shouldDisplayIntro === true ||
            last?.gameHasIntro === true
          );

        if (canUseIntroEvent && !attempted.has('event|Evt_DataToCode_IntroClosePressed')) {
          attempted.add('event|Evt_DataToCode_IntroClosePressed');

          const triggered = await frame.evaluate(() => {
            try {
              if (!globalThis.XT || !globalThis.Vars?.Evt_DataToCode_IntroClosePressed) {
                return { ok:false, reason:'IntroClose event unavailable' };
              }
              if (typeof XT.TriggerEvent !== 'function') {
                return { ok:false, reason:'XT.TriggerEvent unavailable' };
              }

              XT.TriggerEvent(Vars.Evt_DataToCode_IntroClosePressed);
              return {
                ok:true,
                strategy:'XT.TriggerEvent(Vars.Evt_DataToCode_IntroClosePressed)'
              };
            } catch (error) {
              return { ok:false, reason:String(error?.message || error) };
            }
          }).catch(error => ({
            ok:false,
            reason:String(error?.message || error)
          }));

          actions.push({
            at: Date.now(),
            kind: 'safe-event',
            event: 'Evt_DataToCode_IntroClosePressed',
            press: triggered
          });

          await frame.page().waitForTimeout(650);
          continue;
        }

        if (last?.preBaseSelection === true) {
          return {
            ok: false,
            ...last,
            actions,
            reason: 'Pragmatic pre-base selection requires explicit branch handling'
          };
        }
      }

      await frame.page().waitForTimeout(180);
    }

    return {
      ok: false,
      ...(last || {}),
      actions,
      reason: 'Pragmatic base state not ready'
    };
  },

  async listPreBaseSelections(frame) {
    return frame.evaluate(() => {
      const roots = globalThis.globalRuntime?.sceneRoots || [];
      if (!globalThis.XTButton) return [];

      const out = [];
      const seen = new Map();

      for (let ri = 0; ri < roots.length; ri++) {
        let buttons = [];
        try { buttons = roots[ri].GetComponentsInChildren(XTButton, true) || []; } catch {}

        for (const button of buttons) {
          try {
            if (button.gameObject?.activeInHierarchy === false) continue;

            const name = String(button.gameObject?.name || '');
            const event = String(button.eventToCode?.name || '');
            const text = (name + ' ' + event).toLowerCase();

            if (!/itempickedfsbgpick|fsbgpick|bonuspick|pickitem|itempicked|select(?:ed)?option/i.test(text)) {
              continue;
            }

            const key = name + '|' + event;
            const occurrence = seen.get(key) || 0;
            seen.set(key, occurrence + 1);

            const optionMatch = name.match(/(?:option|button|item)[_\s-]?(\d+)/i);

            out.push({
              kind: 'PRAGMATIC_PREBASE_PICK',
              root: ri,
              name,
              event,
              occurrence,
              optionIndex: optionMatch ? Number(optionMatch[1]) - 1 : null,
              active: true,
              canClick: typeof button.OnClick === 'function',
              canPress: typeof button.OnPress === 'function'
            });
          } catch {}
        }
      }

      return out;
    }).catch(() => []);
  },

  async pressPreBaseSelection(frame, selection) {
    const inspect = async () => frame.evaluate(() => {
      const roots = globalThis.globalRuntime?.sceneRoots || [];
      const pickers = [];
      if (globalThis.XTButton) {
        for (let ri = 0; ri < roots.length; ri++) {
          let buttons = [];
          try { buttons = roots[ri].GetComponentsInChildren(XTButton, true) || []; } catch {}
          for (const button of buttons) {
            try {
              if (button.gameObject?.activeInHierarchy === false) continue;
              const name = String(button.gameObject?.name || '');
              const event = String(button.eventToCode?.name || '');
              const text = (name + ' ' + event).toLowerCase();
              if (!/itempickedfsbgpick|fsbgpick|bonuspick|pickitem|itempicked|select(?:ed)?option/i.test(text)) continue;
              pickers.push({ name, event });
            } catch {}
          }
        }
      }
      return {
        pickerCount: pickers.length,
        pickers,
        canSpin: (() => {
          try { return globalThis.Vars?.CanSpin ? XT.GetBool(Vars.CanSpin) : null; }
          catch { return null; }
        })()
      };
    }).catch(() => ({ pickerCount: null, pickers: [], canSpin: null }));

    const invoke = async strategy => frame.evaluate(({ selection, strategy }) => {
      try {
        const roots = globalThis.globalRuntime?.sceneRoots || [];
        if (!globalThis.XTButton) return { ok:false, reason:'XTButton unavailable' };
        const root = roots[Number(selection?.root)];
        if (!root) return { ok:false, reason:'selection root unavailable' };

        let buttons = [];
        try { buttons = root.GetComponentsInChildren(XTButton, true) || []; } catch {}

        const matches = buttons.filter(button => {
          try {
            if (button.gameObject?.activeInHierarchy === false) return false;
            return (
              String(button.gameObject?.name || '') === String(selection?.name || '') &&
              String(button.eventToCode?.name || '') === String(selection?.event || '')
            );
          } catch {
            return false;
          }
        });

        const target =
          matches[Number(selection?.occurrence || 0)] ||
          matches[0];

        if (!target) return { ok:false, reason:'pre-base selection disappeared' };

        if (strategy === 'press') {
          if (typeof target.OnPress !== 'function') return { ok:false, reason:'OnPress unavailable' };
          target.OnPress(true);
          target.OnPress(false);
          return { ok:true, strategy:'XTButton.OnPress(true/false)' };
        }

        if (strategy === 'click') {
          if (typeof target.OnClick !== 'function') return { ok:false, reason:'OnClick unavailable' };
          target.OnClick();
          return { ok:true, strategy:'XTButton.OnClick()' };
        }

        if (strategy === 'event') {
          const event = globalThis.Vars?.Evt_DataToCode_ItemPickedFSBGPick;
          if (!event || typeof globalThis.XT?.TriggerEvent !== 'function') {
            return { ok:false, reason:'Evt_DataToCode_ItemPickedFSBGPick unavailable' };
          }

          const optionIndex = Number(selection?.optionIndex);
          const possibleIndexVars = [
            'BonusPickItemIndex',
            'BonusPickItemIndexLocal',
            'FSBGPickedOption',
            'FSBGPickIndex',
            'SelectedFSBGOption'
          ];

          const assigned = [];
          for (const key of possibleIndexVars) {
            const ref = globalThis.Vars?.[key];
            if (!ref || !Number.isFinite(optionIndex)) continue;
            try {
              if (typeof XT.SetInt === 'function') {
                XT.SetInt(ref, optionIndex);
                assigned.push(key + ':int');
                continue;
              }
            } catch {}
            try {
              if (typeof XT.SetObject === 'function') {
                XT.SetObject(ref, optionIndex);
                assigned.push(key + ':object');
              }
            } catch {}
          }

          XT.TriggerEvent(event);
          return {
            ok:true,
            strategy:'XT.TriggerEvent(Vars.Evt_DataToCode_ItemPickedFSBGPick)',
            optionIndex:Number.isFinite(optionIndex) ? optionIndex : null,
            assigned
          };
        }

        return { ok:false, reason:'unknown strategy' };
      } catch (error) {
        return { ok:false, reason:String(error?.message || error) };
      }
    }, { selection, strategy }).catch(error => ({
      ok:false,
      reason:String(error?.message || error)
    }));

    const before = await inspect();
    const attempts = [];

    for (const strategy of ['press', 'click', 'event']) {
      const action = await invoke(strategy);
      await frame.page().waitForTimeout(450);
      const after = await inspect();

      attempts.push({ strategy, action, after });

      const changed =
        after?.pickerCount === 0 ||
        after?.canSpin === true ||
        (
          Number.isFinite(Number(before?.pickerCount)) &&
          Number.isFinite(Number(after?.pickerCount)) &&
          Number(after.pickerCount) < Number(before.pickerCount)
        );

      if (action?.ok && changed) {
        // Some FSBG pickers expose a separate close-confirmation transition.
        const finalize = await frame.evaluate(() => {
          try {
            const event = globalThis.Vars?.Evt_DataToCode_FSBG_CloseConfirmation;
            if (!event || typeof globalThis.XT?.TriggerEvent !== 'function') {
              return { ok:false, skipped:true, reason:'FSBG close confirmation unavailable' };
            }
            XT.TriggerEvent(event);
            return {
              ok:true,
              strategy:'XT.TriggerEvent(Vars.Evt_DataToCode_FSBG_CloseConfirmation)'
            };
          } catch (error) {
            return { ok:false, reason:String(error?.message || error) };
          }
        }).catch(error => ({ ok:false, reason:String(error?.message || error) }));

        await frame.page().waitForTimeout(450);

        return {
          ok:true,
          selection,
          strategy:action.strategy,
          attempts,
          finalize,
          before,
          after:await inspect()
        };
      }
    }

    return {
      ok:false,
      selection,
      reason:'pre-base selection did not change picker state',
      attempts,
      before,
      after:await inspect()
    };
  },

  async stateSnapshot(frame) {
    return frame.evaluate(() => {
      if (!window.XT || !window.Vars) return null;
      const read = fn => { try { return fn(); } catch { return null; } };
      const fp = read(() => XT.GetObject(Vars.FeaturePurchase));
      const selected = read(() => window.FeaturePurchaseVars ? XT.GetObject(FeaturePurchaseVars.FeaturePurchase_SelectedOption) : null);

      const runtimeButtons = {
        spinActive: null,
        stopActive: null,
        bonusContinueActive: false,
        introCloseActive: false,
        freeSpinsContinueActive: false,
        activePickerCount: 0
      };

      try {
        if (window.globalRuntime && window.XTButton) {
          const roots = globalRuntime.sceneRoots || [];
          const buttons = [];
          for (const root of roots) {
            try { buttons.push(...(root.GetComponentsInChildren(XTButton, true) || [])); } catch {}
          }

          let spinSeen = false;
          let stopSeen = false;

          for (const button of buttons) {
            let active = false;
            let name = '';
            let event = '';
            try { active = button.gameObject?.activeInHierarchy === true; } catch {}
            try { name = String(button.gameObject?.name || ''); } catch {}
            try { event = String(button.eventToCode?.name || ''); } catch {}
            const text = (name + ' ' + event).toLowerCase();

            if (/evt_datatocode_pressed_spin/i.test(event)) {
              spinSeen = true;
              if (active) runtimeButtons.spinActive = true;
              else if (runtimeButtons.spinActive !== true) runtimeButtons.spinActive = false;
            }

            if (/evt_datatocode_pressed_stop/i.test(event)) {
              stopSeen = true;
              if (active) runtimeButtons.stopActive = true;
              else if (runtimeButtons.stopActive !== true) runtimeButtons.stopActive = false;
            }

            if (/bonusroundsoncontinuepressed/i.test(text)) {
              if (active) runtimeButtons.bonusContinueActive = true;
            }

            if (/introclosepressed/i.test(text)) {
              if (active) runtimeButtons.introCloseActive = true;
            }

            if (/freespinswindowwincollectpressed/i.test(text)) {
              if (active) runtimeButtons.freeSpinsContinueActive = true;
            }

            if (/itempicked|bonuspick|fsbgpick|pickitem|select(?:ed)?option/i.test(text)) {
              if (active) runtimeButtons.activePickerCount++;
            }
          }

          if (!spinSeen) runtimeButtons.spinActive = null;
          if (!stopSeen) runtimeButtons.stopActive = null;
        }
      } catch {}

      return {
        featurePurchaseIndex: fp?.purchaseIndex ?? null,
        selectedPurchaseIndex: selected?.purchaseIndex ?? null,
        featurePurchaseWindowIsOpen: read(() => Vars.FeaturePurchaseWindowIsOpen ? XT.GetBool(Vars.FeaturePurchaseWindowIsOpen) : null),
        canSpin: read(() => Vars.CanSpin ? XT.GetBool(Vars.CanSpin) : null),
        autoplaySpinsLeft: read(() => Vars.AutoplaySpinsLeft ? XT.GetInt(Vars.AutoplaySpinsLeft) : null),
        runtimeButtons
      };
    }).catch(() => null);
  },

  async scan(frame) {
    return frame.evaluate(() => {
      if (!window.globalRuntime || !window.XT || !window.Vars) return { ready: false, controls: [] };
      const roots = globalRuntime.sceneRoots || [];
      const controls = [];

      if (window.XTButton) {
        const seen = new Map();
        for (let ri = 0; ri < roots.length; ri++) {
          let buttons = [];
          try { buttons = roots[ri].GetComponentsInChildren(XTButton, true) || []; } catch {}
          for (const b of buttons) {
            let event = null;
            let name = null;
            let active = null;
            try { event = b.eventToCode?.name ?? null; } catch {}
            try { name = b.gameObject?.name ?? null; } catch {}
            try { active = b.gameObject?.activeInHierarchy ?? null; } catch {}
            const key = String(name || '') + '|' + String(event || '');
            const occurrence = seen.get(key) || 0;
            seen.set(key, occurrence + 1);
            const economicText = (String(name || '') + ' ' + String(event || '')).toLowerCase();
            const economicKind =
              /(buy|purchase|ante|booster|chance|feature.?bet|extra.?bet)/i.test(economicText)
                ? 'purchase'
                : null;
            const purchaseSubtype =
              /ante/i.test(economicText) ? 'ante' :
              /booster/i.test(economicText) ? 'booster' :
              /chance|feature.?bet|extra.?bet/i.test(economicText) ? 'chance' :
              /(buy|purchase)/i.test(economicText) ? 'bonus' :
              null;

            controls.push({
              kind: 'XTButton',
              root: ri,
              name,
              event,
              economicKind,
              purchaseSubtype,
              occurrence,
              active,
              canPress: typeof b.OnPress === 'function',
              canClick: typeof b.OnClick === 'function'
            });
          }
        }
      }

      const componentSummary = [];
      const classes = [
        'BuyFeature_InterfaceLink',
        'BuyFeature_BetButtons',
        'FeaturePurchaseOption',
        'FeaturePurchaseDisplayer',
        'FeaturePurchaseV2',
        'InterfaceController'
      ];
      for (const className of classes) {
        const Ctor = window[className];
        if (!Ctor) continue;
        for (let ri = 0; ri < roots.length; ri++) {
          let items = [];
          try { items = roots[ri].GetComponentsInChildren(Ctor, true) || []; } catch {}
          for (const item of items) {
            const methods = [];
            let p = item;
            const seen = new Set();
            for (let depth = 0; p && depth < 4; depth++, p = Object.getPrototypeOf(p)) {
              for (const k of Object.getOwnPropertyNames(p)) {
                if (seen.has(k)) continue;
                seen.add(k);
                try { if (typeof item[k] === 'function') methods.push(k); } catch {}
              }
            }
            componentSummary.push({
              className,
              root: ri,
              name: (() => { try { return item.gameObject?.name ?? null; } catch { return null; } })(),
              purchaseIndex: (() => { try { return item.purchaseIndex ?? null; } catch { return null; } })(),
              purchaseType: (() => { try { return item.purchaseType ?? null; } catch { return null; } })(),
              methods: methods.filter(m => /(press|click|open|close|select|purchase|start)/i.test(m)).slice(0, 80)
            });
          }
        }
      }

      return {
        ready: true,
        roots: roots.length,
        controls,
        components: componentSummary,
        vars: {
          canSpin: (() => { try { return Vars.CanSpin ? XT.GetBool(Vars.CanSpin) : null; } catch { return null; } })(),
          featurePurchaseOpen: (() => { try { return Vars.FeaturePurchaseWindowIsOpen ? XT.GetBool(Vars.FeaturePurchaseWindowIsOpen) : null; } catch { return null; } })()
        }
      };
    });
  },

  async press(frame, action) {
    const normalized = normalizeAction(action);
    const buyMatch = normalized.match(/^(?:buy|purchase)_(\\d+)$/);
    if (buyMatch) return this.purchase(frame, Number(buyMatch[1]) - 1);
    return frame.evaluate(({ normalized, eventMap }) => {
      if (!window.globalRuntime || !window.XT || !window.Vars) return { ok: false, reason: 'Pragmatic runtime unavailable' };
      const roots = globalRuntime.sceneRoots || [];
      const wantedEventName = eventMap[normalized] || null;
      const wantedEvent = wantedEventName && Vars[wantedEventName] ? Vars[wantedEventName] : wantedEventName;

      const allButtons = [];
      if (window.XTButton) {
        for (let ri = 0; ri < roots.length; ri++) {
          try {
            const items = roots[ri].GetComponentsInChildren(XTButton, true) || [];
            for (const b of items) allButtons.push(b);
          } catch {}
        }
      }

      const fuzzy = normalized.replaceAll('_', '');
      let button = null;
      if (wantedEvent) {
        button = allButtons.find(b => {
          try { return b.eventToCode?.name === wantedEvent || b.eventToCode?.name === wantedEventName; } catch { return false; }
        });
      }
      if (!button) {
        button = allButtons.find(b => {
          try {
            const name = String(b.gameObject?.name || '').toLowerCase().replaceAll('_', '');
            const ev = String(b.eventToCode?.name || '').toLowerCase().replaceAll('_', '');
            return name.includes(fuzzy) || ev.includes(fuzzy);
          } catch { return false; }
        });
      }

      if (button) {
        try {
          const name = button.gameObject?.name ?? null;
          const event = button.eventToCode?.name ?? null;
          const preferClick = normalized === 'spin' || /spin/i.test(String(name || '') + ' ' + String(event || ''));

          if (preferClick && typeof button.OnClick === 'function') {
            button.OnClick();
            return { ok: true, control: name, event, strategy: 'XTButton.OnClick()' };
          }
          if (typeof button.OnPress === 'function') {
            button.OnPress(true);
            button.OnPress(false);
            return { ok: true, control: name, event, strategy: 'XTButton.OnPress(true/false)' };
          }
          if (typeof button.OnClick === 'function') {
            button.OnClick();
            return { ok: true, control: name, event, strategy: 'XTButton.OnClick()' };
          }
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }

      if (wantedEvent && typeof XT.TriggerEvent === 'function') {
        try {
          XT.TriggerEvent(wantedEvent);
          return { ok: true, control: null, event: wantedEventName, strategy: 'XT.TriggerEvent fallback' };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }

      return {
        ok: false,
        reason: `button/event not found: ${normalized}`,
        available: allButtons.map(b => {
          try { return { name: b.gameObject?.name ?? null, event: b.eventToCode?.name ?? null }; } catch { return {}; }
        }).slice(0, 100)
      };
    }, { normalized, eventMap: EVENT_MAP });
  },

  async protocolState(frame) {
    return frame.evaluate(() => {
      if (!globalThis.XT || !globalThis.Vars) return null;
      const readBool = key => {
        try {
          const ref = Vars[key];
          return ref ? XT.GetBool(ref) : null;
        } catch {
          return null;
        }
      };

      const roots = globalThis.globalRuntime?.sceneRoots || [];
      const pickerControls = [];
      const confirmFSControls = [];
      const bonusControls = [];
      const stopControls = [];

      if (globalThis.XTButton) {
        for (let ri = 0; ri < roots.length; ri++) {
          let buttons = [];
          try { buttons = roots[ri].GetComponentsInChildren(XTButton, true) || []; } catch {}
          for (let bi = 0; bi < buttons.length; bi++) {
            const button = buttons[bi];
            try {
              const name = String(button.gameObject?.name || '');
              const event = String(button.eventToCode?.name || '');
              const active = button.gameObject?.activeInHierarchy !== false;
              const text = (name + ' ' + event).toLowerCase();

              const descriptor = {
                root: ri,
                index: bi,
                name,
                event,
                active,
                canClick: typeof button.OnClick === 'function',
                canPress: typeof button.OnPress === 'function'
              };

              if (/confirmfsstart|evt_datatocode_confirmfsstart/i.test(text)) {
                confirmFSControls.push(descriptor);
              }

              if (/evt_datatocode_pressed_stop|stopspin_button|pressed_stop/i.test(text)) {
                stopControls.push(descriptor);
              }

              if (/itempicked|bonuspick|fsbgpick|pickitem|select(?:ed)?option|option_\d/i.test(text)) {
                pickerControls.push(descriptor);
              }

              if (/bonus|respin|continue|collect|confirm/i.test(text)) {
                bonusControls.push(descriptor);
              }
            } catch {}
          }
        }
      }

      const objectSummary = key => {
        try {
          const ref = Vars[key];
          if (!ref) return null;
          const value = XT.GetObject(ref);
          if (value == null) return null;
          if (['string','number','boolean'].includes(typeof value)) return value;
          const methods = [];
          const keys = [];
          let current = value;
          const seen = new Set();
          for (let depth = 0; current && depth < 4; depth++) {
            for (const name of Object.getOwnPropertyNames(current)) {
              if (seen.has(name)) continue;
              seen.add(name);
              keys.push(name);
              try {
                if (typeof value[name] === 'function') methods.push(name);
              } catch {}
            }
            current = Object.getPrototypeOf(current);
          }
          const fields = {};
          for (const field of [
            'GameID','GameType','GameOver','Level','Life','WheelOfFortune',
            'justReceived','currentBonusRespin','maxBonusRespins',
            'numberOfLevels','isBonusGambled','MultiplierStep',
            'purchaseIndex'
          ]) {
            try {
              const fieldValue = value?.[field];
              if (
                fieldValue == null ||
                ['string','number','boolean'].includes(typeof fieldValue)
              ) fields[field] = fieldValue ?? null;
            } catch {}
          }

          return {
            constructor: value?.constructor?.name ?? null,
            fields,
            keys: keys.slice(0,80),
            methods: methods.filter(name => /bonus|spin|respin|pick|collect|start|continue|send|request|init/i.test(name)).slice(0,80)
          };
        } catch {
          return null;
        }
      };

      const transportObjects = [];
      for (const key of Object.keys(globalThis.Vars || {})) {
        if (!/connection|transport|server|request|bonus/i.test(key)) continue;
        try {
          const ref = Vars[key];
          if (!ref) continue;
          const value = XT.GetObject(ref);
          if (!value || typeof value !== 'object') continue;

          const methods = [];
          let current = value;
          const seen = new Set();
          for (let depth = 0; current && depth < 4; depth++) {
            for (const name of Object.getOwnPropertyNames(current)) {
              if (seen.has(name)) continue;
              seen.add(name);
              try {
                if (
                  typeof value[name] === 'function' &&
                  /bonus|spin|pick|collect|send|request|init/i.test(name)
                ) methods.push(name);
              } catch {}
            }
            current = Object.getPrototypeOf(current);
          }

          if (methods.length) {
            transportObjects.push({
              varKey: key,
              constructor: value?.constructor?.name ?? null,
              methods: [...new Set(methods)].slice(0,80)
            });
          }
        } catch {}
      }

      return {
        canSpin: readBool('CanSpin'),
        fsStartNeedsConfirmation: readBool('FSStartNeedsConfirmation'),
        logicIsFreeSpin: readBool('Logic_IsFreeSpin'),
        receivedFreeSpinsResponse: readBool('ReceivedFreeSpinsResponse'),
        mustResumeFreeSpinOptions: readBool('MustResumeFreeSpinOptions'),
        spinBlockingFeatureIsRunning: readBool('SpinBlockingFeatureIsRunning'),
        manualRespin: readBool('ManualRespin'),
        respinInProgress: readBool('RespinInProgress'),
        mustOpenBonus: readBool('MustOpenBonus'),
        instantlyCollectBonus: readBool('InstantlyCollectBonus'),
        mustOpenAnotherBonus: readBool('MustOpenAnotherBonus'),
        pickerControls,
        confirmFSControls,
        confirmFSActive: confirmFSControls.some(item => item.active === true),
        stopControls,
        stopActive: stopControls.some(item => item.active === true),
        bonusControls,
        transportObjects: transportObjects.slice(0,40),
        bonusObjects: {
          BonusData: objectSummary('BonusData'),
          RespinData: objectSummary('RespinData'),
          BonusRoundsData: objectSummary('BonusRoundsData'),
          FreeSpinsChainData: objectSummary('FreeSpinsChainData'),
          InitBonusCode: objectSummary('InitBonusCode')
        }
      };
    }).catch(() => null);
  },

  async continueProtocol(frame, exchange) {
    const state = await this.protocolState(frame);
    const na = String(exchange?.na || '').toLowerCase();

    if (na === 'b' || (exchange?.bgid != null && String(exchange?.end ?? '') !== '1')) {
      const choices = (state?.pickerControls || []).filter(item => item.active !== false);
      if (choices.length) {
        return {
          ok: false,
          needsSelection: true,
          kind: 'bonus-pick',
          choices,
          state
        };
      }

      const bonusFields = state?.bonusObjects?.BonusData?.fields || {};
      const currentBonusRespin = Number(bonusFields.currentBonusRespin);
      const maxBonusRespins = Number(bonusFields.maxBonusRespins);
      const respinProven =
        Number.isFinite(maxBonusRespins) &&
        maxBonusRespins > 0 &&
        (
          !Number.isFinite(currentBonusRespin) ||
          currentBonusRespin < maxBonusRespins
        );

      if (respinProven) {
        const respin = await frame.evaluate(() => {
          try {
            const event = globalThis.BGVars?.Evt_ToServer_SendBonusRespin;
            if (!event || typeof globalThis.XT?.TriggerEvent !== 'function') {
              return {
                ok: false,
                kind: 'bonus-respin',
                reason: 'BGVars.Evt_ToServer_SendBonusRespin unavailable'
              };
            }

            XT.TriggerEvent(event);
            return {
              ok: true,
              kind: 'bonus-respin',
              strategy: 'XT.TriggerEvent(BGVars.Evt_ToServer_SendBonusRespin)'
            };
          } catch (error) {
            return {
              ok: false,
              kind: 'bonus-respin',
              reason: String(error?.message || error)
            };
          }
        });

        return {
          ...respin,
          state,
          currentBonusRespin:
            Number.isFinite(currentBonusRespin) ? currentBonusRespin : null,
          maxBonusRespins
        };
      }

      return {
        ok: false,
        needsBonusInit: true,
        kind: 'bonus-init',
        choices: [],
        state
      };
    }

    if (na === 'c') {
      return frame.evaluate(() => {
        try {
          const candidates = [
            'Evt_DataToCode_FreeSpinsWindowWinCollectPressed',
            'Evt_DataToCode_FreeSpinsWindowLoseCollectPressed',
            'Evt_DataToCode_BonusResultWindow_PressedCollect',
            'Evt_DataToCode_CollectPressed'
          ];

          for (const key of candidates) {
            const event = globalThis.Vars?.[key];
            if (!event) continue;
            if (typeof globalThis.XT?.TriggerEvent !== 'function') continue;
            XT.TriggerEvent(event);
            return {
              ok: true,
              kind: 'collect',
              strategy: 'XT.TriggerEvent(Vars.' + key + ')',
              event: key
            };
          }

          return { ok: false, kind: 'collect', reason: 'No collect event available' };
        } catch (error) {
          return { ok: false, kind: 'collect', reason: String(error?.message || error) };
        }
      });
    }

    if (na === 's') {
      const fs = Number(exchange?.fs);
      const fsmax = Number(exchange?.fsmax);
      const featureSpin =
        (Number.isFinite(fsmax) && fsmax > 0 && Number.isFinite(fs) && fs < fsmax) ||
        String(exchange?.rs || '').toLowerCase() === 'mc' ||
        (exchange?.trail != null && /pending|feature/i.test(String(exchange.trail)));

      if (!featureSpin) {
        return {
          ok: false,
          kind: 'spin',
          reason: 'Protocol does not prove an active feature spin',
          state
        };
      }

      // Cascade/multi-cascade responses can leave the runtime in an animation
      // phase with StopSpin active and CanSpin=false. Ending that animation is the
      // explicit runtime transition that allows the next cascade/server request.
      if (
        String(exchange?.rs || '').toLowerCase() === 'mc' &&
        state?.stopActive === true
      ) {
        const stop = await frame.evaluate(() => {
          try {
            const event = globalThis.Vars?.Evt_DataToCode_Pressed_Stop;
            if (!event || typeof globalThis.XT?.TriggerEvent !== 'function') {
              return { ok:false, reason:'Evt_DataToCode_Pressed_Stop unavailable' };
            }

            XT.TriggerEvent(event);
            return {
              ok:true,
              kind:'cascade-stop',
              strategy:'XT.TriggerEvent(Vars.Evt_DataToCode_Pressed_Stop)'
            };
          } catch (error) {
            return {
              ok:false,
              kind:'cascade-stop',
              reason:String(error?.message || error)
            };
          }
        });

        return { ...stop, state };
      }

      // If the runtime is already spin-capable, the server response itself has
      // completed any start-confirmation phase. Use the internal server-request
      // event directly; do not infer a pending confirmation from the global
      // FSStartNeedsConfirmation configuration flag.
      if (state?.canSpin === true) {
        const spin = await frame.evaluate(() => {
          try {
            const event =
              globalThis.Vars?.Evt_ToServer_RequestSpin ||
              globalThis.Vars?.Evt_DataToCode_Pressed_Spin;
            if (!event || typeof globalThis.XT?.TriggerEvent !== 'function') {
              return { ok: false, reason: 'Pragmatic spin event unavailable' };
            }
            XT.TriggerEvent(event);
            return {
              ok: true,
              kind: 'protocol-spin',
              strategy:
                event === Vars.Evt_ToServer_RequestSpin
                  ? 'XT.TriggerEvent(Vars.Evt_ToServer_RequestSpin)'
                  : 'XT.TriggerEvent(Vars.Evt_DataToCode_Pressed_Spin)'
            };
          } catch (error) {
            return { ok: false, reason: String(error?.message || error) };
          }
        });
        return { ...spin, state };
      }

      // Only confirm FS start when an actual active runtime control advertises
      // that transition. The boolean config by itself is not sufficient.
      if (state?.confirmFSActive === true) {
        const confirm = await frame.evaluate(() => {
          try {
            const event = globalThis.Vars?.Evt_DataToCode_ConfirmFSStart;
            if (!event || typeof globalThis.XT?.TriggerEvent !== 'function') {
              return { ok: false, reason: 'Evt_DataToCode_ConfirmFSStart unavailable' };
            }
            XT.TriggerEvent(event);
            return {
              ok: true,
              kind: 'confirm-fs-start',
              strategy: 'XT.TriggerEvent(Vars.Evt_DataToCode_ConfirmFSStart)'
            };
          } catch (error) {
            return { ok: false, reason: String(error?.message || error) };
          }
        });
        return { ...confirm, state };
      }

      return {
        ok: false,
        kind: 'feature-wait',
        waiting: true,
        reason: 'Feature active but runtime is not yet spin/confirm actionable',
        state
      };
    }

    return {
      ok: false,
      kind: 'unknown',
      reason: 'No protocol continuation for na=' + na,
      state
    };
  },

  async pressProtocolChoice(frame, choice) {
    return frame.evaluate(({ choice }) => {
      try {
        if (!globalThis.XTButton) {
          return { ok: false, reason: 'XTButton unavailable' };
        }

        const roots = globalThis.globalRuntime?.sceneRoots || [];
        const root = roots[Number(choice?.root)];
        if (!root) return { ok: false, reason: 'picker root unavailable' };

        const buttons = root.GetComponentsInChildren(XTButton, true) || [];
        const candidates = buttons.filter(button => {
          try {
            return (
              button.gameObject?.activeInHierarchy !== false &&
              String(button.gameObject?.name || '') === String(choice?.name || '') &&
              String(button.eventToCode?.name || '') === String(choice?.event || '')
            );
          } catch {
            return false;
          }
        });

        const target = candidates[0];
        if (!target) return { ok: false, reason: 'picker control unavailable' };

        if (typeof target.OnClick === 'function') {
          target.OnClick();
          return {
            ok: true,
            strategy: 'picker XTButton.OnClick()',
            name: choice?.name ?? null,
            event: choice?.event ?? null
          };
        }

        if (typeof target.OnPress === 'function') {
          target.OnPress(true);
          target.OnPress(false);
          return {
            ok: true,
            strategy: 'picker XTButton.OnPress(true/false)',
            name: choice?.name ?? null,
            event: choice?.event ?? null
          };
        }

        return { ok: false, reason: 'picker has no click/press path' };
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) };
      }
    }, { choice });
  },

  async listPurchases(frame) {
    await this.waitReady(frame, 10_000).catch(() => null);
    const collect = async () => frame.evaluate(() => {
      if (!window.globalRuntime) return { options: [], pending: false, hasPurchaseRuntime: false, server: globalThis.__parserPragmaticPurInit ?? null };
      const roots = globalRuntime.sceneRoots || [];
      const out = new Map();
      let pending = false;
      let hasPurchaseRuntime = false;

      if (window.FeaturePurchaseOption) {
        for (const root of roots) {
          let options = [];
          try { options = root.GetComponentsInChildren(FeaturePurchaseOption, true) || []; } catch {}
          if (options.length) hasPurchaseRuntime = true;
          for (const option of options) {
            try {
              if (option.type === 1) continue;
              const index = Number(option.purchaseIndex);
              if (!Number.isFinite(index) || index < 0) continue;
              const data = option.purchaseData;
              const reportedAvailable = data?.purchaseOptionIsAvailable?.[index] ?? null;
              const forceDisabled = option?.forceDisabled ?? null;
              const available = forceDisabled === true ? false : true;
              const cost = data?.purchaseCosts?.[index] ?? null;
              const active = option.gameObject?.activeInHierarchy ?? null;
              const prev = out.get(index);
              if (!prev || active === true) {
                out.set(index, {
                  index,
                  ordinal: index + 1,
                  available,
                  reportedAvailable,
                  forceDisabled,
                  active,
                  cost,
                  kind: 'FeaturePurchaseOption'
                });
              }
            } catch {}
          }
        }
      }

      if (window.FeaturePurchaseV2) {
        for (const root of roots) {
          let managers = [];
          try { managers = root.GetComponentsInChildren(FeaturePurchaseV2, true) || []; } catch {}
          if (managers.length) hasPurchaseRuntime = true;
          for (const manager of managers) {
            const options = manager.purchaseOptions || [];
            if (!options.length) pending = true;

            for (let index = 0; index < options.length; index++) {
              const option = options[index];
              if (!option) continue;
              const reportedAvailable =
                manager.featurePurchaseData?.purchaseOptionIsAvailable?.[index] ?? null;
              const forceDisabled = option?.forceDisabled ?? null;
              const available = forceDisabled === true ? false : true;
              const cost = manager.featurePurchaseData?.purchaseCosts?.[index] ?? null;
              const active = option?.gameObject?.activeInHierarchy ?? null;

              const prev = out.get(index);
              if (!prev || prev.kind !== 'FeaturePurchaseOption') {
                out.set(index, {
                  index,
                  ordinal: index + 1,
                  available,
                  reportedAvailable,
                  forceDisabled,
                  active,
                  cost,
                  kind: 'FeaturePurchaseV2'
                });
              }
            }
          }
        }
      }

      if (!out.size && window.FeaturePurchaseManager) {
        for (const root of roots) {
          let managers = [];
          try { managers = root.GetComponentsInChildren(FeaturePurchaseManager, true) || []; } catch {}
          if (managers.length) hasPurchaseRuntime = true;
          for (const manager of managers) {
            const costs = manager.purchaseCosts || [];
            if (!costs.length) pending = true;
            for (let index = 0; index < costs.length; index++) {
              out.set(index, {
                index,
                ordinal: index + 1,
                available: true,
                reportedAvailable: manager.purchaseOptionIsAvailable?.[index] ?? null,
                forceDisabled: null,
                active: manager.gameObject?.activeInHierarchy ?? null,
                cost: costs[index] ?? null,
                kind: 'FeaturePurchaseManager'
              });
            }
          }
        }
      }

      return {
        options: [...out.values()].sort((a, b) => a.index - b.index),
        pending,
        hasPurchaseRuntime,
        server: globalThis.__parserPragmaticPurInit ?? null
      };
    });

    const openPurchaseMenu = async () => frame.evaluate(() => {
      const roots = window.globalRuntime?.sceneRoots || [];
      if (!window.XTButton) return false;

      const invoke = button => {
        try {
          if (button.gameObject?.activeInHierarchy === false) return false;
          if (typeof button.OnPress === 'function') {
            button.OnPress(true);
            button.OnPress(false);
            return true;
          }
          if (typeof button.OnClick === 'function') {
            button.OnClick();
            return true;
          }
        } catch {}
        return false;
      };

      const buttons = [];
      for (const root of roots) {
        try { buttons.push(...(root.GetComponentsInChildren(XTButton, true) || [])); } catch {}
      }

      const candidates = buttons.filter(button => {
        try {
          if (button.gameObject?.activeInHierarchy === false) return false;
          const name = String(button.gameObject?.name || '');
          const event = String(button.eventToCode?.name || '');
          const text = (name + ' ' + event).toLowerCase();
          return /(buy|purchase|feature)/.test(text) &&
            !/(confirm|yes|no|close|cancel|rebuy)/.test(text);
        } catch {
          return false;
        }
      });

      for (const button of candidates) {
        if (invoke(button)) return true;
      }
      return false;
    }).catch(() => false);

    let last = { options: [], pending: false, hasPurchaseRuntime: false, server: null };
    let opened = false;

    // Some games instantiate FeaturePurchaseV2 only after the buy-feature interface
    // is opened. Others populate purchaseOptions asynchronously. Server doInit.purInit
    // is authoritative for the number of purchases enabled in this exact DEMO session.
    for (let attempt = 0; attempt < 12; attempt++) {
      last = await collect();

      const serverCount = Number(last.server?.count);
      if (Number.isFinite(serverCount)) {
        if (serverCount <= 0) return [];

        if (last.options.length >= serverCount) {
          return last.options.slice(0, serverCount).map((option, index) => ({
            ...option,
            index,
            ordinal: index + 1,
            serverDeclared: true
          }));
        }
      } else if (last.options.length) {
        return last.options;
      }

      if (!opened && attempt >= 1) {
        opened = await openPurchaseMenu();
        if (opened) {
          await frame.page().waitForTimeout(350);
          continue;
        }
      }

      await frame.page().waitForTimeout(last.pending || last.hasPurchaseRuntime ? 200 : 150);
    }

    const serverCount = Number(last.server?.count);
    if (Number.isFinite(serverCount) && serverCount > 0) {
      const serverOptions = Array.isArray(last.server?.options) ? last.server.options : [];
      const resolved = new Map(last.options.map(option => [Number(option.index), option]));

      for (let index = 0; index < serverCount; index++) {
        if (resolved.has(index)) continue;
        const serverOption = serverOptions[index] || null;
        resolved.set(index, {
          index,
          ordinal: index + 1,
          available: true,
          reportedAvailable: null,
          forceDisabled: null,
          active: null,
          cost:
            serverOption?.bet ??
            serverOption?.cost ??
            serverOption?.price ??
            null,
          kind: 'ServerPurInit',
          serverDeclared: true
        });
      }

      return [...resolved.values()]
        .sort((a, b) => a.index - b.index)
        .slice(0, serverCount);
    }

    return last.options;
  },

  async purchase(frame, index) {
    const ready = await this.waitReady(frame, 10_000).catch(error => ({
      ok:false,
      reason:String(error?.message || error)
    }));

    if (!ready?.ok) {
      return {
        ok:false,
        index,
        reason:'Pragmatic base state not ready before purchase',
        ready
      };
    }

    return frame.evaluate(async ({ index }) => {
      if (!window.globalRuntime || !window.XT || !window.Vars) return { ok: false, reason: 'Pragmatic runtime unavailable', index };
      const roots = globalRuntime.sceneRoots || [];
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      const getPendingPurchaseIndex = () => {
        try {
          return Number(XT.GetObject(Vars.FeaturePurchase)?.purchaseIndex ?? -2);
        } catch {
          return -2;
        }
      };

      const ensurePendingPurchaseIndex = () => {
        let pending = getPendingPurchaseIndex();
        if (pending === Number(index)) return pending;

        try {
          const data = XT.GetObject(Vars.FeaturePurchase);
          if (data && typeof data === 'object') {
            data.purchaseIndex = Number(index);
            pending = getPendingPurchaseIndex();
          }
        } catch {}

        return pending;
      };

      const invokeButton = button => {
        if (!button) return false;
        if (typeof button.OnPress === 'function') {
          button.OnPress(true);
          button.OnPress(false);
          return true;
        }
        if (typeof button.OnClick === 'function') {
          button.OnClick();
          return true;
        }
        return false;
      };

      const confirmPurchaseIfNeeded = async () => {
        let isOpen = null;
        try {
          isOpen = Vars.FeaturePurchaseWindowIsOpen
            ? XT.GetBool(Vars.FeaturePurchaseWindowIsOpen)
            : null;
        } catch {}

        const confirmations = [];

        if (window.FeaturePurchaseOption) {
          for (const root of roots) {
            let options = [];
            try { options = root.GetComponentsInChildren(FeaturePurchaseOption, true) || []; } catch {}
            for (const option of options) {
              try {
                if (Number(option.type) !== 1) continue;
                if (option.gameObject?.activeInHierarchy === false) continue;
                confirmations.push({
                  kind: 'FeaturePurchaseOption',
                  name: option.gameObject?.name ?? null,
                  target: option
                });
              } catch {}
            }
          }
        }

        if (window.XTButton) {
          const buttons = [];
          for (const root of roots) {
            try { buttons.push(...(root.GetComponentsInChildren(XTButton, true) || [])); } catch {}
          }

          for (const button of buttons) {
            try {
              if (button.gameObject?.activeInHierarchy === false) continue;
              const name = String(button.gameObject?.name || '');
              const event = String(button.eventToCode?.name || '');
              const text = (name + ' ' + event).toLowerCase();

              if (!/(confirm|yes|accept|start.?buy|buy.?confirm|purchase.?confirm)/i.test(text)) continue;
              if (/(cancel|close|no)/i.test(text)) continue;

              confirmations.push({
                kind: 'XTButton',
                name: button.gameObject?.name ?? null,
                event: button.eventToCode?.name ?? null,
                target: button
              });
            } catch {}
          }
        }

        for (const item of confirmations) {
          if (!invokeButton(item.target)) continue;
          await wait(250);
          return {
            clicked: true,
            windowWasOpen: isOpen,
            kind: item.kind,
            name: item.name ?? null,
            event: item.event ?? null
          };
        }

        return {
          clicked: false,
          windowWasOpen: isOpen,
          candidates: confirmations.map(item => ({
            kind: item.kind,
            name: item.name ?? null,
            event: item.event ?? null
          }))
        };
      };

      if (window.XTButton) {
        const buttons = [];
        for (const root of roots) {
          try { buttons.push(...(root.GetComponentsInChildren(XTButton, true) || [])); } catch {}
        }
        const opener = buttons.find(button => {
          try {
            if (button.gameObject?.activeInHierarchy === false) return false;
            const name = String(button.gameObject?.name || '');
            const event = String(button.eventToCode?.name || '');
            const text = (name + ' ' + event).toLowerCase();
            return /(buy|feature|purchase)/.test(text) && !/(close|cancel|no|yes|confirm)/.test(text);
          } catch { return false; }
        });
        if (opener) {
          invokeButton(opener);
          await wait(450);
        }
      }

      if (window.FeaturePurchaseOption) {
        const options = [];
        for (const root of roots) {
          try { options.push(...(root.GetComponentsInChildren(FeaturePurchaseOption, true) || [])); } catch {}
        }
        const target = options.find(option => {
          try { return option.type !== 1 && Number(option.purchaseIndex) === Number(index) && option.gameObject?.activeInHierarchy !== false; }
          catch { return false; }
        }) || options.find(option => {
          try { return option.type !== 1 && Number(option.purchaseIndex) === Number(index); }
          catch { return false; }
        });

        if (target && typeof target.OnClick === 'function') {
          target.OnClick();
          await wait(300);
          const confirm = options.find(option => {
            try { return option.type === 1 && option.gameObject?.activeInHierarchy !== false; }
            catch { return false; }
          });
          if (confirm && confirm !== target && typeof confirm.OnClick === 'function') {
            confirm.OnClick();
            await wait(300);
          }
          const selected = ensurePendingPurchaseIndex();
          const confirmState = selected === Number(index)
            ? await confirmPurchaseIfNeeded()
            : null;
          return {
            ok: selected === Number(index),
            index,
            selectedIndex: selected,
            confirm: confirmState,
            strategy: confirm
              ? 'FeaturePurchaseOption.OnClick() + confirm.OnClick() + canonical purchaseIndex verify'
              : 'FeaturePurchaseOption.OnClick() + canonical purchaseIndex verify',
            needsSpin: selected === Number(index),
            reason: selected === Number(index) ? null : 'Canonical FeaturePurchase purchaseIndex was not selected'
          };
        }
      }

      if (window.FeaturePurchaseV2) {
        for (const root of roots) {
          let managers = [];
          try { managers = root.GetComponentsInChildren(FeaturePurchaseV2, true) || []; } catch {}
          for (const manager of managers) {
            const option = manager.purchaseOptions?.[index];
            if (!option) continue;
            for (const method of ['OnClick', 'Click', 'OnPress', 'PurchaseFeature']) {
              if (typeof option[method] === 'function') {
                if (method === 'OnPress') { option[method](true); option[method](false); }
                else option[method]();
                await wait(250);
                const pending = ensurePendingPurchaseIndex();
                const confirmState = pending === Number(index)
                  ? await confirmPurchaseIfNeeded()
                  : null;
                return {
                  ok: pending === Number(index),
                  index,
                  selectedIndex: pending,
                  confirm: confirmState,
                  strategy:
                    'FeaturePurchaseV2.purchaseOptions[' + index + '].' + method +
                    '() + canonical purchaseIndex verify',
                  needsSpin: pending === Number(index),
                  reason: pending === Number(index) ? null : 'Canonical FeaturePurchase purchaseIndex was not selected'
                };
              }
            }
            if (typeof manager.PurchaseFeature === 'function') {
              manager.PurchaseFeature(index);
              await wait(200);
              const pending = ensurePendingPurchaseIndex();
              const confirmState = pending === Number(index)
                ? await confirmPurchaseIfNeeded()
                : null;
              return {
                ok: pending === Number(index),
                index,
                selectedIndex: pending,
                confirm: confirmState,
                strategy: 'FeaturePurchaseV2.PurchaseFeature(index) + canonical purchaseIndex verify',
                needsSpin: pending === Number(index),
                reason: pending === Number(index) ? null : 'Canonical FeaturePurchase purchaseIndex was not selected'
              };
            }
          }
        }
      }

      if (window.FeaturePurchaseManager) {
        for (const root of roots) {
          let managers = [];
          try { managers = root.GetComponentsInChildren(FeaturePurchaseManager, true) || []; } catch {}
          for (const manager of managers) {
            if (typeof manager.PurchaseFeature === 'function' && index < (manager.purchaseCosts?.length ?? 0)) {
              manager.PurchaseFeature(index);
              await wait(200);
              const pending = ensurePendingPurchaseIndex();
              const confirmState = pending === Number(index)
                ? await confirmPurchaseIfNeeded()
                : null;
              return {
                ok: pending === Number(index),
                index,
                selectedIndex: pending,
                confirm: confirmState,
                strategy: 'FeaturePurchaseManager.PurchaseFeature(index) + canonical purchaseIndex verify',
                needsSpin: pending === Number(index),
                reason: pending === Number(index) ? null : 'Canonical FeaturePurchase purchaseIndex was not selected'
              };
            }
          }
        }
      }

      // Server purInit can declare a purchase before a concrete UI handler
      // materializes. The canonical FeaturePurchase object is the state consumed
      // by the spin serializer. Use it as a final runtime-level fallback.
      try {
        const declared = Number(globalThis.__parserPragmaticPurInit?.count);
        if (Number.isFinite(declared) && index >= 0 && index < declared) {
          const pending = ensurePendingPurchaseIndex();
          if (pending === Number(index)) {
            const confirmState = await confirmPurchaseIfNeeded();
            return {
              ok: true,
              index,
              selectedIndex: pending,
              confirm: confirmState,
              strategy: 'canonical FeaturePurchase.purchaseIndex fallback',
              needsSpin: true
            };
          }
        }
      } catch {}

      return { ok: false, index, reason: 'No Pragmatic purchase option handler found' };
    }, { index });
  },

  async listControls(frame) {
    const scan = await this.scan(frame);
    const extras = await frame.evaluate(() => {
      if (!window.globalRuntime) return [];
      const roots = globalRuntime.sceneRoots || [];
      const out = [];
      const counts = new Map();

      const add = control => {
        const key = [
          control.kind,
          control.name ?? '',
          control.purchaseIndex ?? '',
          control.optionIndex ?? '',
          control.type ?? ''
        ].join('|');
        const occurrence = counts.get(key) || 0;
        counts.set(key, occurrence + 1);
        out.push({ ...control, occurrence });
      };

      if (window.FeaturePurchaseOption) {
        for (let ri = 0; ri < roots.length; ri++) {
          let items = [];
          try { items = roots[ri].GetComponentsInChildren(FeaturePurchaseOption, true) || []; } catch {}
          for (const item of items) {
            let name = null, active = null, purchaseIndex = null, type = null;
            try { name = item.gameObject?.name ?? null; } catch {}
            try { active = item.gameObject?.activeInHierarchy ?? null; } catch {}
            try { purchaseIndex = item.purchaseIndex ?? null; } catch {}
            try { type = item.type ?? null; } catch {}
            const canClick = typeof item.OnClick === 'function';
            const canPress = typeof item.OnPress === 'function';
            if (canClick || canPress) {
              add({
                kind: 'FeaturePurchaseOption',
                root: ri,
                name,
                economicKind: 'purchase',
                purchaseSubtype: 'bonus',
                active,
                purchaseIndex,
                type,
                canClick,
                canPress
              });
            }

            if (typeof item.PurchaseFeature === 'function' && item.PurchaseFeature.length === 0) {
              add({
                kind: 'FeaturePurchaseMethod',
                root: ri,
                name,
                economicKind: 'purchase',
                purchaseSubtype: 'bonus',
                active,
                purchaseIndex,
                type,
                method: 'PurchaseFeature'
              });
            }
          }
        }
      }

      if (window.FeaturePurchaseV2) {
        for (let ri = 0; ri < roots.length; ri++) {
          let managers = [];
          try { managers = roots[ri].GetComponentsInChildren(FeaturePurchaseV2, true) || []; } catch {}
          for (const manager of managers) {
            const options = manager.purchaseOptions || [];
            for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
              const option = options[optionIndex];
              if (!option) continue;
              let name = null, active = null;
              try { name = option.gameObject?.name ?? null; } catch {}
              try { active = option.gameObject?.activeInHierarchy ?? null; } catch {}
              const methods = ['OnClick', 'Click', 'OnPress'].filter(m => typeof option[m] === 'function');
              if (methods.length) {
                add({
                  kind: 'FeaturePurchaseV2Option',
                  root: ri,
                  name,
                  economicKind: 'purchase',
                  purchaseSubtype: 'bonus',
                  active,
                  optionIndex,
                  methods
                });
              }
            }
          }
        }
      }

      return out;
    }).catch(() => []);

    return [...(scan?.controls || []), ...extras];
  },

  async pressControl(frame, control) {
    return frame.evaluate(({ control }) => {
      if (!window.globalRuntime) {
        return { ok: false, reason: 'Pragmatic runtime unavailable' };
      }

      const roots = globalRuntime.sceneRoots || [];

      const invoke = target => {
        if (!target) return { ok: false, reason: 'target unavailable' };
        let spinLike = false;
        try {
          spinLike = /spin/i.test(
            String(target.gameObject?.name || '') + ' ' +
            String(target.eventToCode?.name || '')
          );
        } catch {}

        if (spinLike && typeof target.OnClick === 'function') {
          target.OnClick();
          return { ok: true, strategy: 'OnClick()' };
        }
        if (typeof target.OnPress === 'function') {
          target.OnPress(true);
          target.OnPress(false);
          return { ok: true, strategy: 'OnPress(true/false)' };
        }
        if (typeof target.OnClick === 'function') {
          target.OnClick();
          return { ok: true, strategy: 'OnClick()' };
        }
        if (typeof target.Click === 'function') {
          target.Click();
          return { ok: true, strategy: 'Click()' };
        }
        return { ok: false, reason: 'No invokable click/press path' };
      };

      try {
        if (control?.kind === 'XTButton') {
          if (!window.XTButton) return { ok: false, reason: 'XTButton unavailable' };
          const matches = [];
          for (const root of roots) {
            let buttons = [];
            try { buttons = root.GetComponentsInChildren(XTButton, true) || []; } catch {}
            for (const button of buttons) {
              let name = null, event = null;
              try { name = button.gameObject?.name ?? null; } catch {}
              try { event = button.eventToCode?.name ?? null; } catch {}
              if (String(name || '') === String(control?.name || '') &&
                  String(event || '') === String(control?.event || '')) {
                matches.push(button);
              }
            }
          }
          const preferred = control?.active === true
            ? matches.filter(item => {
                try { return item.gameObject?.activeInHierarchy !== false; } catch { return false; }
              })
            : matches;
          const target = preferred[Number(control?.occurrence || 0)] || preferred[0] || matches[Number(control?.occurrence || 0)] || matches[0];
          const r = invoke(target);
          return { ...r, control: control?.name ?? null, event: control?.event ?? null };
        }

        if (control?.kind === 'FeaturePurchaseOption' && window.FeaturePurchaseOption) {
          const matches = [];
          for (const root of roots) {
            let items = [];
            try { items = root.GetComponentsInChildren(FeaturePurchaseOption, true) || []; } catch {}
            for (const item of items) {
              let name = null, purchaseIndex = null, type = null;
              try { name = item.gameObject?.name ?? null; } catch {}
              try { purchaseIndex = item.purchaseIndex ?? null; } catch {}
              try { type = item.type ?? null; } catch {}
              if (String(name || '') === String(control?.name || '') &&
                  String(purchaseIndex ?? '') === String(control?.purchaseIndex ?? '') &&
                  String(type ?? '') === String(control?.type ?? '')) {
                matches.push(item);
              }
            }
          }
          const preferred = control?.active === true
            ? matches.filter(item => {
                try { return item.gameObject?.activeInHierarchy !== false; } catch { return false; }
              })
            : matches;
          const target = preferred[Number(control?.occurrence || 0)] || preferred[0] || matches[Number(control?.occurrence || 0)] || matches[0];
          const r = invoke(target);
          return {
            ...r,
            control: control?.name ?? null,
            purchaseIndex: control?.purchaseIndex ?? null,
            type: control?.type ?? null
          };
        }

        if (control?.kind === 'FeaturePurchaseMethod' && window.FeaturePurchaseOption) {
          const matches = [];
          for (const root of roots) {
            let items = [];
            try { items = root.GetComponentsInChildren(FeaturePurchaseOption, true) || []; } catch {}
            for (const item of items) {
              let name = null, purchaseIndex = null, type = null;
              try { name = item.gameObject?.name ?? null; } catch {}
              try { purchaseIndex = item.purchaseIndex ?? null; } catch {}
              try { type = item.type ?? null; } catch {}
              if (String(name || '') === String(control?.name || '') &&
                  String(purchaseIndex ?? '') === String(control?.purchaseIndex ?? '') &&
                  String(type ?? '') === String(control?.type ?? '')) {
                matches.push(item);
              }
            }
          }
          const preferred = control?.active === true
            ? matches.filter(item => {
                try { return item.gameObject?.activeInHierarchy !== false; } catch { return false; }
              })
            : matches;
          const target = preferred[Number(control?.occurrence || 0)] || preferred[0] || matches[Number(control?.occurrence || 0)] || matches[0];
          if (!target || typeof target.PurchaseFeature !== 'function') {
            return { ok: false, reason: 'PurchaseFeature method unavailable', control: control?.name ?? null };
          }

          target.PurchaseFeature();

          let pending = (() => {
            try { return XT.GetObject(Vars.FeaturePurchase)?.purchaseIndex ?? -2; } catch { return -2; }
          })();

          // Some layouts bind a display/selected component whose PurchaseFeature()
          // does not own the canonical data object. Fall back to the provider's
          // manager using the same discovered purchase index.
          if (pending < 0 && Number(control?.purchaseIndex) >= 0 && window.FeaturePurchaseManager) {
            for (const root of roots) {
              let managers = [];
              try { managers = root.GetComponentsInChildren(FeaturePurchaseManager, true) || []; } catch {}
              for (const manager of managers) {
                if (typeof manager.PurchaseFeature === 'function') {
                  manager.PurchaseFeature(Number(control.purchaseIndex));
                  pending = (() => {
                    try { return XT.GetObject(Vars.FeaturePurchase)?.purchaseIndex ?? -2; } catch { return -2; }
                  })();
                  if (pending >= 0) break;
                }
              }
              if (pending >= 0) break;
            }
          }

          return {
            ok: true,
            strategy: 'FeaturePurchaseOption.PurchaseFeature()',
            control: control?.name ?? null,
            purchaseIndex: control?.purchaseIndex ?? null,
            pendingPurchaseIndex: pending,
            type: control?.type ?? null
          };
        }

        if (control?.kind === 'FeaturePurchaseV2Option' && window.FeaturePurchaseV2) {
          const managers = [];
          for (const root of roots) {
            try { managers.push(...(root.GetComponentsInChildren(FeaturePurchaseV2, true) || [])); } catch {}
          }
          const candidates = managers
            .map(manager => manager.purchaseOptions?.[Number(control?.optionIndex)])
            .filter(Boolean);
          const preferred = control?.active === true
            ? candidates.filter(item => {
                try { return item.gameObject?.activeInHierarchy !== false; } catch { return false; }
              })
            : candidates;
          const target = preferred[Number(control?.occurrence || 0)] || preferred[0] || candidates[Number(control?.occurrence || 0)] || candidates[0];
          const r = invoke(target);
          return { ...r, control: control?.name ?? null, optionIndex: control?.optionIndex ?? null };
        }

        return { ok: false, reason: 'Unsupported Pragmatic control kind', kind: control?.kind ?? null };
      } catch (error) {
        return {
          ok: false,
          control: control?.name ?? null,
          event: control?.event ?? null,
          reason: String(error?.message || error)
        };
      }
    }, { control });
  }
};
