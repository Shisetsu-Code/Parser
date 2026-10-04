import { normalizeAction } from '../lib/common.js';

const ALIASES = {
  spin: ['spin'],
  buy_feature: ['buy_feature', 'shop_button'],
  shop: ['shop_button'],
  bets: ['bets', 'bets_menu'],
  autoplay: ['autogame', 'autogame_menu', 'new_autogame_menu'],
  rules: ['rules', 'rules_menu'],
  ante_bet: ['ante_bet'],
  booster: ['booster']
};

export const threeOaks = {
  id: '3oaks',

  async detect(frame) {
    return frame.evaluate(() => Boolean(window.GR?.UI?.view)).catch(() => false);
  },

  async isDemo(frame) {
    return frame.evaluate(() => {
      const href = location.href;
      return /(^|\.)3oaks\.com$/i.test(location.hostname)
        || /3oaks/i.test(href)
        || /demo/i.test(href);
    }).catch(() => false);
  },

  async stateSnapshot(frame) {
    return frame.evaluate(() => {
      const read = fn => { try { return fn(); } catch { return null; } };
      const view = window.GR?.UI?.view;
      const popup = read(() => window.app?.buyFeature?._components?.buyFeaturePopup);
      const flowGet = key => read(() => window.GR?.Flow?.get?.(key));

      const primitive = value =>
        value == null || ['string', 'number', 'boolean'].includes(typeof value) ? value : null;

      return {
        spinDisabled: read(() => typeof view?.spin?.disabled === 'function' ? view.spin.disabled() : view?.spin?.disabled),
        spinState: primitive(read(() => typeof view?.spin?.state === 'function' ? view.spin.state() : view?.spin?.state)),
        buyFeatureDisabled: read(() => typeof view?.buy_feature?.disabled === 'function' ? view.buy_feature.disabled() : view?.buy_feature?.disabled),
        buyFeatureSelected: read(() => typeof view?.buy_feature?.selected === 'function' ? view.buy_feature.selected() : view?.buy_feature?.selected),
        buyPopupVisible: primitive(read(() => popup?.visible ?? popup?.active ?? popup?.opened ?? popup?.isOpen)),
        selectedMode: primitive(
          read(() => window.app?.buyFeature?._selectedMode) ??
          read(() => window.app?.buyFeature?.selectedMode) ??
          read(() => window.app?.board?.buyFeature?._selectedMode) ??
          read(() => window.app?.board?.buyFeature?.selectedMode)
        ),
        flowBuyBonus: primitive(flowGet('context.buy_bonus')),
        flowGameStatus: primitive(flowGet('context.game_status')),
        flowFeature: primitive(flowGet('context.feature'))
      };
    }).catch(() => null);
  },

  async scan(frame) {
    return frame.evaluate(() => {
      const view = window.GR?.UI?.view;
      if (!view) return { ready: false, controls: [] };

      const safeCall = (obj, key) => {
        try {
          const v = obj?.[key];
          if (typeof v === 'function' && v.length === 0) {
            const out = v.call(obj);
            return out == null || ['string', 'number', 'boolean'].includes(typeof out) ? out : undefined;
          }
          if (typeof v !== 'function' && (v == null || ['string', 'number', 'boolean'].includes(typeof v))) return v;
        } catch {}
        return undefined;
      };

      const controls = [];
      for (const [name, obj] of Object.entries(view)) {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) continue;
        const keys = [];
        try { keys.push(...Object.keys(obj).slice(0, 80)); } catch {}
        const capabilities = {
          directClick: typeof obj.click === 'function',
          clickEmitter: typeof obj.click?.emit === 'function' || typeof obj.click?.dispatch === 'function' || typeof obj.click?.trigger === 'function',
          pointer: typeof obj.pointerdown === 'function' || typeof obj.pointerup === 'function',
          bounds: typeof obj.getBounds === 'function'
        };
        if (!Object.values(capabilities).some(Boolean) && !/(spin|buy|shop|bet|auto|rule|boost|ante)/i.test(name)) continue;
        const economicKind = /buy_feature|ante_bet|booster/i.test(name) ? 'purchase' : null;
        const purchaseSubtype =
          /ante_bet/i.test(name) ? 'ante' :
          /booster/i.test(name) ? 'booster' :
          /buy_feature/i.test(name) ? 'bonus' :
          null;

        controls.push({
          name,
          economicKind,
          purchaseSubtype,
          capabilities,
          state: {
            visible: safeCall(obj, 'visible'),
            disabled: safeCall(obj, 'disabled'),
            selected: safeCall(obj, 'selected'),
            state: safeCall(obj, 'state'),
            text: safeCall(obj, 'text'),
            price: safeCall(obj, 'price')
          },
          keys
        });
      }

      return {
        ready: true,
        gameRunnerVersion: window.GR?.version ?? null,
        controls
      };
    });
  },

  async press(frame, action) {
    const normalized = normalizeAction(action);
    const buyMatch = normalized.match(/^(?:buy|purchase)_(\\d+)$/);
    if (buyMatch) return this.purchase(frame, Number(buyMatch[1]));
    const aliases = ALIASES[normalized] || [normalized];

    return frame.evaluate(({ normalized, aliases }) => {
      const GR = window.GR;
      const view = GR?.UI?.view;
      if (!view) return { ok: false, reason: 'GR.UI.view unavailable' };

      const candidateName = aliases.find(name => view[name]);
      if (!candidateName) {
        const fuzzy = Object.keys(view).find(name => aliases.some(a => name.toLowerCase().includes(a)));
        if (!fuzzy) return { ok: false, reason: `control not found: ${normalized}` };
        aliases = [fuzzy];
      }

      const name = aliases.find(n => view[n]) || aliases[0];
      const control = view[name];
      if (!control) return { ok: false, reason: `control not found: ${normalized}` };

      try {
        if (typeof control.click === 'function') {
          control.click();
          return { ok: true, control: name, strategy: 'view.click()' };
        }
        for (const method of ['emit', 'dispatch', 'trigger', 'fire']) {
          if (typeof control.click?.[method] === 'function') {
            control.click[method]();
            return { ok: true, control: name, strategy: `view.click.${method}()` };
          }
        }
        if (typeof control.pointerdown === 'function' || typeof control.pointerup === 'function') {
          if (typeof control.pointerdown === 'function') control.pointerdown();
          if (typeof control.pointerup === 'function') control.pointerup();
          return { ok: true, control: name, strategy: 'pointerdown/pointerup' };
        }
        if (normalized === 'spin' && typeof GR?.UI?.Events?.spin === 'function') {
          GR.UI.Events.spin();
          return { ok: true, control: name, strategy: 'GR.UI.Events.spin() fallback' };
        }
        const ev = GR?.UI?.Events?.[name];
        if (typeof ev === 'function') {
          ev();
          return { ok: true, control: name, strategy: `GR.UI.Events.${name}() fallback` };
        }
        return { ok: false, control: name, reason: 'control found but no invokable press path' };
      } catch (error) {
        return { ok: false, control: name, reason: String(error?.message || error) };
      }
    }, { normalized, aliases });
  },

  async listPurchases(frame) {
    return frame.evaluate(() => {
      const GR = window.GR;
      const read = getter => {
        try { return getter(); } catch { return null; }
      };
      const raw = read(() => GR?.Flow?.get?.('context.available_buy_bonus'))
        ?? read(() => GR?.UI?.model?.get?.('context.available_buy_bonus'))
        ?? read(() => GR?.UI?.model?.get?.('available_buy_bonus'));

      const simplify = value => {
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
        if (typeof value !== 'object') return null;
        const out = {};
        for (const key of ['name', 'title', 'text', 'type', 'price', 'cost', 'multiplier', 'available', 'enabled']) {
          const v = value[key];
          if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) out[key] = v;
        }
        return out;
      };

      let values = [];
      if (Array.isArray(raw)) values = raw;
      else if (raw && typeof raw === 'object') {
        const keys = Object.keys(raw).sort((a, b) => Number(a) - Number(b));
        values = keys.map(key => raw[key]);
      }

      return values.map((value, i) => ({
        index: i + 1,
        ordinal: i + 1,
        available: value?.available ?? value?.enabled ?? true,
        meta: simplify(value)
      }));
    });
  },

  async purchase(frame, index) {
    return frame.evaluate(async ({ index }) => {
      const GR = window.GR;
      const view = GR?.UI?.view;
      if (!view) return { ok: false, reason: 'GR.UI.view unavailable', index };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      try {
        if (view.buy_feature) {
          const disabled = typeof view.buy_feature.disabled === 'function' ? view.buy_feature.disabled() : false;
          if (!disabled && typeof view.buy_feature.click === 'function') {
            view.buy_feature.click();
            await wait(650);
          }
        }

        const api = window.app?.board?.buyFeature;
        if (typeof api?.actBuyFeature === 'function') {
          api.actBuyFeature(index);
          return {
            ok: true,
            index,
            strategy: 'GR.UI.view.buy_feature.click() + app.board.buyFeature.actBuyFeature(index)',
            needsSpin: false
          };
        }

        return { ok: false, index, reason: '3Oaks purchase handler app.board.buyFeature.actBuyFeature unavailable' };
      } catch (error) {
        return { ok: false, index, reason: String(error?.message || error) };
      }
    }, { index });
  },

  async listControls(frame) {
    const scan = await this.scan(frame);
    const extras = await frame.evaluate(() => {
      const components = window.app?.buyFeature?._components || {};
      const out = [];
      for (const [name, target] of Object.entries(components)) {
        if (!target || (typeof target !== 'object' && typeof target !== 'function')) continue;
        const methods = ['emitClick', 'click', 'pointerdown', 'pointerup']
          .filter(method => typeof target?.[method] === 'function');
        if (!methods.length) continue;
        out.push({
          kind: 'app.buyFeature.component',
          name,
          active: (() => {
            try { return target.visible ?? target.active ?? null; } catch { return null; }
          })(),
          methods
        });
      }
      return out;
    }).catch(() => []);

    return [
      ...(scan?.controls || []).map(control => ({ ...control, kind: control.kind || 'GR.UI.view' })),
      ...extras
    ];
  },

  async pressControl(frame, control) {
    const name = control?.name;
    return frame.evaluate(({ control, name }) => {
      try {
        if (control?.kind === 'app.buyFeature.component') {
          const target = window.app?.buyFeature?._components?.[name];
          if (!target) return { ok: false, reason: '3Oaks buyFeature component unavailable', control: name ?? null };
          if (typeof target.emitClick === 'function') {
            target.emitClick();
            return { ok: true, control: name, strategy: 'app.buyFeature._components[name].emitClick()' };
          }
          if (typeof target.click === 'function') {
            target.click();
            return { ok: true, control: name, strategy: 'app.buyFeature._components[name].click()' };
          }
          if (typeof target.pointerdown === 'function' || typeof target.pointerup === 'function') {
            if (typeof target.pointerdown === 'function') target.pointerdown();
            if (typeof target.pointerup === 'function') target.pointerup();
            return { ok: true, control: name, strategy: 'buyFeature pointerdown/pointerup' };
          }
          return { ok: false, control: name, reason: 'No invokable buyFeature component path' };
        }

        const view = window.GR?.UI?.view;
        if (!view || !name || !view[name]) {
          return { ok: false, reason: '3Oaks control unavailable', control: name ?? null };
        }

        const target = view[name];
        if (typeof target.click === 'function') {
          target.click();
          return { ok: true, control: name, strategy: 'view.click()' };
        }
        for (const method of ['emit', 'dispatch', 'trigger', 'fire']) {
          if (typeof target.click?.[method] === 'function') {
            target.click[method]();
            return { ok: true, control: name, strategy: 'view.click.' + method + '()' };
          }
        }
        if (typeof target.pointerdown === 'function' || typeof target.pointerup === 'function') {
          if (typeof target.pointerdown === 'function') target.pointerdown();
          if (typeof target.pointerup === 'function') target.pointerup();
          return { ok: true, control: name, strategy: 'pointerdown/pointerup' };
        }
        const event = window.GR?.UI?.Events?.[name];
        if (typeof event === 'function') {
          event();
          return { ok: true, control: name, strategy: 'GR.UI.Events.' + name + '()' };
        }
        return { ok: false, control: name, reason: 'No invokable path' };
      } catch (error) {
        return { ok: false, control: name, reason: String(error?.message || error) };
      }
    }, { control, name });
  }
};
