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

  async scan(frame) {
    return frame.evaluate(() => {
      const view = window.GR?.UI?.view;
      if (!view) return { ready: false, controls: [] };

      const safeCall = (obj, key) => {
        try {
          const v = obj?.[key];
          if (typeof v === 'function' && v.length === 0) return v.call(obj);
          if (typeof v !== 'function' && ['string', 'number', 'boolean'].includes(typeof v)) return v;
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
        controls.push({
          name,
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
  }
};
