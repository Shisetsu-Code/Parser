import { normalizeAction } from '../lib/common.js';

const EVENT_MAP = {
  spin: 'Evt_DataToCode_Pressed_Spin',
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

  async scan(frame) {
    return frame.evaluate(() => {
      if (!window.globalRuntime || !window.XT || !window.Vars) return { ready: false, controls: [] };
      const roots = globalRuntime.sceneRoots || [];
      const controls = [];

      if (window.XTButton) {
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
            controls.push({
              kind: 'XTButton',
              root: ri,
              name,
              event,
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

  async listPurchases(frame) {
    return frame.evaluate(() => {
      if (!window.globalRuntime) return [];
      const roots = globalRuntime.sceneRoots || [];
      const out = new Map();

      if (window.FeaturePurchaseOption) {
        for (const root of roots) {
          let options = [];
          try { options = root.GetComponentsInChildren(FeaturePurchaseOption, true) || []; } catch {}
          for (const option of options) {
            try {
              if (option.type === 1) continue;
              const index = Number(option.purchaseIndex);
              if (!Number.isFinite(index)) continue;
              const data = option.purchaseData;
              const available = data?.purchaseOptionIsAvailable?.[index] ?? true;
              const cost = data?.purchaseCosts?.[index] ?? null;
              const active = option.gameObject?.activeInHierarchy ?? null;
              const prev = out.get(index);
              if (!prev || active === true) out.set(index, { index, ordinal: index + 1, available, active, cost, kind: 'FeaturePurchaseOption' });
            } catch {}
          }
        }
      }

      if (!out.size && window.FeaturePurchaseV2) {
        for (const root of roots) {
          let managers = [];
          try { managers = root.GetComponentsInChildren(FeaturePurchaseV2, true) || []; } catch {}
          for (const manager of managers) {
            const options = manager.purchaseOptions || [];
            for (let index = 0; index < options.length; index++) {
              const option = options[index];
              const available = manager.featurePurchaseData?.purchaseOptionIsAvailable?.[index] ?? !option?.forceDisabled;
              const cost = manager.featurePurchaseData?.purchaseCosts?.[index] ?? null;
              const active = option?.gameObject?.activeInHierarchy ?? null;
              out.set(index, { index, ordinal: index + 1, available, active, cost, kind: 'FeaturePurchaseV2' });
            }
          }
        }
      }

      if (!out.size && window.FeaturePurchaseManager) {
        for (const root of roots) {
          let managers = [];
          try { managers = root.GetComponentsInChildren(FeaturePurchaseManager, true) || []; } catch {}
          for (const manager of managers) {
            const costs = manager.purchaseCosts || [];
            for (let index = 0; index < costs.length; index++) {
              out.set(index, {
                index,
                ordinal: index + 1,
                available: manager.purchaseOptionIsAvailable?.[index] ?? true,
                active: manager.gameObject?.activeInHierarchy ?? null,
                cost: costs[index] ?? null,
                kind: 'FeaturePurchaseManager'
              });
            }
          }
        }
      }

      return [...out.values()].sort((a, b) => a.index - b.index);
    });
  },

  async purchase(frame, index) {
    return frame.evaluate(async ({ index }) => {
      if (!window.globalRuntime || !window.XT || !window.Vars) return { ok: false, reason: 'Pragmatic runtime unavailable', index };
      const roots = globalRuntime.sceneRoots || [];
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
          const selected = (() => {
            try { return XT.GetObject(Vars.FeaturePurchase)?.purchaseIndex ?? -2; } catch { return -2; }
          })();
          return {
            ok: true,
            index,
            selectedIndex: selected,
            strategy: confirm ? 'FeaturePurchaseOption.OnClick() + confirm.OnClick()' : 'FeaturePurchaseOption.OnClick()',
            needsSpin: selected >= 0
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
                return { ok: true, index, strategy: 'FeaturePurchaseV2.purchaseOptions[' + index + '].' + method + '()', needsSpin: true };
              }
            }
            if (typeof manager.PurchaseFeature === 'function') {
              manager.PurchaseFeature(index);
              return { ok: true, index, strategy: 'FeaturePurchaseV2.PurchaseFeature(index)', needsSpin: true };
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
              return { ok: true, index, strategy: 'FeaturePurchaseManager.PurchaseFeature(index)', needsSpin: true };
            }
          }
        }
      }

      return { ok: false, index, reason: 'No Pragmatic purchase option handler found' };
    }, { index });
  }
};
