import { genericCanvas } from './generic-canvas.js';

const MODULES = {
  data: 2731,
  unitmng: 9337,
  ajaxQueue: 1129
};

async function ensureHook(frame) {
  return frame.evaluate(({ MODULES }) => {
    const req = globalThis.all_content;
    if (typeof req !== 'function') return { ok: false, reason: 'all_content unavailable' };

    let dataMod, unitMod, ajaxMod;
    try {
      dataMod = req(MODULES.data);
      unitMod = req(MODULES.unitmng);
      ajaxMod = req(MODULES.ajaxQueue);
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }

    const data = dataMod?.data;
    const unitmng = unitMod?.unitmng;
    const ajaxQueue = ajaxMod?.ajaxQueue;
    if (!data || !unitmng) return { ok: false, reason: 'validated Belatra modules unavailable' };

    const cloneSafe = value => {
      const seen = new WeakSet();
      try {
        return JSON.parse(JSON.stringify(value, (key, current) => {
          if (/^(sid|session|token|auth|key|launch_token)$/i.test(String(key))) return '[redacted]';
          if (typeof current === 'function') return undefined;
          if (current && typeof current === 'object') {
            if (seen.has(current)) return '[circular]';
            seen.add(current);
          }
          return current;
        }));
      } catch {
        return null;
      }
    };

    globalThis.__parserBelatraProtocol ||= [];

    if (ajaxQueue && typeof ajaxQueue.post === 'function' && !ajaxQueue.__parserWrappedPost) {
      const original = ajaxQueue.post;
      Object.defineProperty(ajaxQueue, '__parserWrappedPost', { value: true, configurable: true });
      Object.defineProperty(ajaxQueue, '__parserOriginalPost', { value: original, configurable: true });

      ajaxQueue.post = function(payload, ...rest) {
        try {
          const event = {
            seq: globalThis.__parserBelatraProtocol.length,
            at: Date.now(),
            payload: cloneSafe(payload)
          };
          globalThis.__parserBelatraProtocol.push(event);
          if (globalThis.__parserBelatraProtocol.length > 1000) {
            globalThis.__parserBelatraProtocol.splice(0, 250);
          }
        } catch {}
        return original.call(this, payload, ...rest);
      };
    }

    const game = unitmng.tGame;
    if (game && typeof game.show_BuyBonusBanner === 'function' && !game.__parserWrappedBuyBanner) {
      const originalShow = game.show_BuyBonusBanner;
      Object.defineProperty(game, '__parserWrappedBuyBanner', { value: true, configurable: true });
      game.show_BuyBonusBanner = function(...args) {
        const banner = originalShow.apply(this, args);
        globalThis.__parserBelatraBuyBanner = banner || null;
        return banner;
      };
    }

    return {
      ok: true,
      hasAjaxHook: Boolean(ajaxQueue?.__parserWrappedPost),
      hasBuyBannerHook: Boolean(game?.__parserWrappedBuyBanner)
    };
  }, { MODULES }).catch(error => ({ ok: false, reason: String(error?.message || error) }));
}

async function runtimeInfo(frame) {
  await ensureHook(frame);
  return frame.evaluate(({ MODULES }) => {
    const req = globalThis.all_content;
    if (typeof req !== 'function') return null;

    try {
      const data = req(MODULES.data)?.data;
      const unitmng = req(MODULES.unitmng)?.unitmng;
      const game = unitmng?.tGame;
      const gs = data?.gs;
      if (!data || !game || !gs) return null;

      const simple = value => {
        if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value ?? null;
        return null;
      };

      const shallow = object => {
        if (!object || typeof object !== 'object') return null;
        const out = {};
        for (const [key, value] of Object.entries(object)) {
          const v = simple(value);
          if (v !== null || value === null) out[key] = v;
          else if (Array.isArray(value)) out[key] = { length: value.length };
        }
        return out;
      };

      const banner = globalThis.__parserBelatraBuyBanner || null;
      const buyButtons = Array.isArray(banner?.buyButtons) ? banner.buyButtons : [];
      const selectedBuy = Number.isFinite(Number(game.justBuyBonusSelectType))
        ? Number(game.justBuyBonusSelectType)
        : null;

      const propertyNames = object => {
        const names = new Set();
        let current = object;
        for (let depth = 0; current && depth < 4; depth++) {
          for (const name of Object.getOwnPropertyNames(current)) names.add(name);
          current = Object.getPrototypeOf(current);
        }
        return [...names];
      };

      const semanticRuntimeActions = [];
      for (const [sourceName, object] of [['game', game], ['panelBot', game.panelBot]]) {
        if (!object || typeof object !== 'object') continue;
        for (const name of propertyNames(object)) {
          if (!/(buy|bonus|ante|chance|boost|super.?spin|enhanced.?spin|spin|start)/i.test(name)) continue;
          if (/^(constructor|show_BuyBonusBanner)$/i.test(name)) continue;

          let value;
          try { value = object[name]; } catch { continue; }

          const classify = text => {
            const lower = String(text || '').toLowerCase();
            if (/ante/.test(lower)) return 'ante';
            if (/chance/.test(lower)) return 'chance';
            if (/boost/.test(lower)) return 'booster';
            if (/super.?spin|enhanced.?spin/.test(lower)) return 'super_spin';
            if (/(buy.*bonus|bonus.*buy|purchase)/.test(lower)) return 'buy';
            if (/(spin|start)/.test(lower)) return 'spin';
            if (/bonus/.test(lower)) return 'bonus';
            return 'unknown';
          };

          if (typeof value === 'function') {
            const semantic = classify(name);
            if (semantic !== 'unknown') {
              semanticRuntimeActions.push({
                source: sourceName,
                name,
                method: null,
                semantic
              });
            }
            continue;
          }

          if (!value || typeof value !== 'object') continue;
          for (const method of ['doAction', 'onDown', 'onClick', 'click']) {
            if (typeof value[method] !== 'function') continue;
            const semantic = classify(name + ' ' + method);
            if (semantic === 'unknown') continue;
            semanticRuntimeActions.push({
              source: sourceName,
              name,
              method,
              semantic
            });
          }
        }
      }

      return {
        runtimeVersion: 'all_content-webpack',
        moduleIds: MODULES,
        configuration: {
          useBetDependOnLines: game.useBetDependOnLines === true,
          nlines: simple(gs.nlines),
          linesAssortment: Array.isArray(gs.linesAssortment) ? gs.linesAssortment.slice(0, 100) : [],
          betPerLine: simple(gs.betPerLine),
          betPerGame: simple(gs.betPerGame),
          betAssortment: Array.isArray(gs.betAssortment) ? gs.betAssortment.slice(0, 100) : []
        },
        capabilities: {
          showBuyBonusBanner: typeof game.show_BuyBonusBanner === 'function',
          semanticRuntimeActions: semanticRuntimeActions.slice(0, 80)
        },
        purchase: {
          selectedOption: selectedBuy,
          autoBuyOption: simple(game.justBuyBonusSelectType_AUTOBUY),
          bannerOpen: Boolean(banner?.popup || banner?.buyButtons || banner?.but_ok),
          optionCount: buyButtons.length,
          confirmAvailable: Boolean(banner?.but_ok),
          cancelAvailable: Boolean(banner?.but_no),
          betIncreaseAvailable: Boolean(banner?.but_plus),
          betDecreaseAvailable: Boolean(banner?.but_minus),
          buyBonus: shallow(gs.buyBonus)
        },
        feature: {
          freespin: simple(game.freespin),
          waitBanner: simple(game.waitBanner),
          reelstate: simple(gs.reelstate),
          flags: simple(gs.flags),
          userAction: simple(gs.userAction),
          freeInfo: shallow(gs.freeInfo),
          respinInfo: shallow(gs.respinInfo),
          subGameInfo: shallow(gs.subGameInfo),
          jpsubGameInfo: shallow(gs.jpsubGameInfo)
        }
      };
    } catch {
      return null;
    }
  }, { MODULES }).catch(() => null);
}

function buyControl(index, selected) {
  return {
    kind: 'BELATRA_BUY_OPTION',
    name: `buy_option_${index}`,
    economicKind: 'purchase',
    purchaseSubtype: 'buy_feature',
    optionIndex: index,
    active: true,
    state: { selected: selected === index }
  };
}

export const belatra = {
  id: 'belatra',

  async detect(frame, page) {
    let allowed = false;
    try {
      const top = new URL(page.url()).hostname;
      const own = new URL(frame.url()).hostname;
      allowed =
        /(^|\.)(belatragames\.com|bltrm\.com)$/i.test(top) ||
        /(^|\.)(belatragames\.com|bltrm\.com)$/i.test(own);
    } catch {}
    if (!allowed) return false;

    const detected = await frame.evaluate(({ MODULES }) => {
      if (typeof globalThis.all_content !== 'function') return false;
      try {
        const data = globalThis.all_content(MODULES.data)?.data;
        const unitmng = globalThis.all_content(MODULES.unitmng)?.unitmng;
        return Boolean(data?.gs && unitmng?.tGame);
      } catch {
        return false;
      }
    }, { MODULES }).catch(() => false);

    if (detected) await ensureHook(frame);
    return detected;
  },

  async isDemo(frame) {
    return frame.evaluate(() => /(^|\.)(demo\.)?bltrm\.com$/i.test(location.hostname)).catch(() => false);
  },

  async stateSnapshot(frame) {
    return runtimeInfo(frame);
  },

  async protocolCursor(frame) {
    await ensureHook(frame);
    return frame.evaluate(() => globalThis.__parserBelatraProtocol?.length ?? 0).catch(() => 0);
  },

  async protocolEvents(frame, since = 0) {
    await ensureHook(frame);
    return frame.evaluate(start => {
      const events = globalThis.__parserBelatraProtocol || [];
      return events.slice(Math.max(0, Number(start) || 0));
    }, since).catch(() => []);
  },

  async scan(frame) {
    return { ready: true, controls: await this.listControls(frame) };
  },

  async listControls(frame) {
    await ensureHook(frame);
    const base = await genericCanvas.listControls(frame);
    const info = await runtimeInfo(frame);
    if (!info) return base;

    const extra = [];
    const cfg = info.configuration || {};

    if (cfg.useBetDependOnLines && Array.isArray(cfg.linesAssortment) && cfg.linesAssortment.length > 1) {
      for (const value of cfg.linesAssortment) {
        if (Number(value) === Number(cfg.nlines)) continue;
        extra.push({
          kind: 'BELATRA_CONFIG',
          name: `config_lines_${value}`,
          configKey: 'nlines',
          configValue: Number(value),
          active: true,
          state: {
            selected: false,
            text: String(value)
          }
        });
      }
    }

    const purchase = info.purchase || {};
    const capabilities = info.capabilities || {};

    if (
      capabilities.showBuyBonusBanner === true &&
      !purchase.bannerOpen
    ) {
      extra.push({
        kind: 'BELATRA_BUY_OPEN',
        name: 'buy_bonus_open',
        economicKind: 'purchase',
        purchaseSubtype: 'bonus',
        active: true
      });
    }

    for (const action of Array.isArray(capabilities.semanticRuntimeActions)
      ? capabilities.semanticRuntimeActions
      : []) {
      // Keep explicit Buy Bonus opener separate and avoid duplicate low-level start/spin
      // actions when we already know q=start from protocol correlation.
      if (/show_BuyBonusBanner/i.test(action?.name || '')) continue;
      extra.push({
        kind: 'BELATRA_RUNTIME_ACTION',
        name: `runtime_${action.semantic}_${action.source}_${action.name}`,
        runtimeSource: action.source,
        runtimeName: action.name,
        runtimeMethod: action.method ?? null,
        semantic: action.semantic,
        economicKind: ['buy','ante','chance','booster','super_spin'].includes(action.semantic) ? 'purchase' : null,
        purchaseSubtype:
          action.semantic === 'ante' ? 'ante_bet' :
          action.semantic === 'buy' ? 'buy_feature' :
          action.semantic === 'chance' ? 'chance' :
          action.semantic === 'booster' ? 'booster' :
          action.semantic === 'super_spin' ? 'super_spin' :
          null,
        active: true
      });
    }

    if (purchase.bannerOpen && Number(purchase.optionCount) > 0) {
      for (let index = 0; index < Number(purchase.optionCount); index++) {
        extra.push(buyControl(index, purchase.selectedOption));
      }
    }

    if (purchase.confirmAvailable) {
      extra.push({
        kind: 'BELATRA_BUY_CONFIRM',
        name: 'buy_confirm',
        active: true,
        state: { selected: purchase.selectedOption }
      });
    }
    if (purchase.betIncreaseAvailable) {
      extra.push({ kind: 'BELATRA_BUY_BET', name: 'buy_bet_inc', method: 'inc', active: true });
    }
    if (purchase.betDecreaseAvailable) {
      extra.push({ kind: 'BELATRA_BUY_BET', name: 'buy_bet_dec', method: 'dec', active: true });
    }

    // Prefer exact runtime controls over generic canvas fallbacks.
    return [...extra, ...base];
  },

  async listEconomicPurchases(frame) {
    const controls = await this.listControls(frame).catch(() => []);
    const out = [];
    const seen = new Set();

    for (const control of controls) {
      if (control?.economicKind !== 'purchase') continue;
      const subtype = String(control?.purchaseSubtype || 'other_paid_modifier');
      const key = [
        subtype,
        control?.kind ?? '',
        control?.name ?? '',
        control?.optionIndex ?? '',
        control?.runtimeSource ?? '',
        control?.runtimeName ?? '',
        control?.runtimeMethod ?? ''
      ].join('|');

      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        id: key,
        economicKind: 'purchase',
        subtype,
        execution:
          control?.kind === 'BELATRA_BUY_OPTION'
            ? 'buy_option'
            : 'runtime_control',
        available: control?.active !== false,
        cost: control?.state?.price ?? null,
        control,
        raw: control
      });
    }

    return out;
  },

  async pressControl(frame, control) {
    await ensureHook(frame);

    if (control?.kind === 'BELATRA_BUY_OPEN') {
      return frame.evaluate(({ MODULES }) => {
        try {
          const unitmng = globalThis.all_content(MODULES.unitmng)?.unitmng;
          const game = unitmng?.tGame;
          if (!game || typeof game.show_BuyBonusBanner !== 'function') {
            return { ok: false, reason: 'Buy Bonus opener unavailable' };
          }

          const banner = game.show_BuyBonusBanner();
          if (banner) globalThis.__parserBelatraBuyBanner = banner;

          return {
            ok: true,
            strategy: 'unitmng.tGame.show_BuyBonusBanner',
            bannerCaptured: Boolean(globalThis.__parserBelatraBuyBanner)
          };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }, { MODULES });
    }

    if (control?.kind === 'BELATRA_RUNTIME_ACTION') {
      return frame.evaluate(({ MODULES, control }) => {
        try {
          const unitmng = globalThis.all_content(MODULES.unitmng)?.unitmng;
          const game = unitmng?.tGame;
          const source =
            control.runtimeSource === 'panelBot'
              ? game?.panelBot
              : game;
          if (!source) return { ok: false, reason: 'Runtime action source unavailable' };

          const target = source[control.runtimeName];
          if (control.runtimeMethod) {
            if (!target || typeof target[control.runtimeMethod] !== 'function') {
              return { ok: false, reason: 'Runtime action method unavailable' };
            }
            target[control.runtimeMethod]();
          } else {
            if (typeof target !== 'function') {
              return { ok: false, reason: 'Runtime action function unavailable' };
            }
            target.call(source);
          }

          return {
            ok: true,
            strategy: 'Belatra runtime semantic action',
            semantic: control.semantic,
            runtimeSource: control.runtimeSource,
            runtimeName: control.runtimeName,
            runtimeMethod: control.runtimeMethod ?? null
          };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }, { MODULES, control });
    }

    if (control?.kind === 'BELATRA_CONFIG' && control?.configKey === 'nlines') {
      return frame.evaluate(async ({ MODULES, target }) => {
        try {
          const data = globalThis.all_content(MODULES.data)?.data;
          const unitmng = globalThis.all_content(MODULES.unitmng)?.unitmng;
          const game = unitmng?.tGame;
          const panel = game?.panelBot;
          const assortment = data?.gs?.linesAssortment;

          if (!game || !Array.isArray(assortment)) {
            return { ok: false, reason: 'Belatra line runtime unavailable' };
          }

          const targetNumber = Number(target);
          const targetIndex = assortment.findIndex(v => Number(v) === targetNumber);
          if (targetIndex < 0) {
            return { ok: false, reason: 'Requested line value unavailable', target: targetNumber };
          }

          const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

          const propertyNames = object => {
            const names = new Set();
            let current = object;
            for (let depth = 0; current && depth < 5; depth++) {
              for (const name of Object.getOwnPropertyNames(current)) names.add(name);
              current = Object.getPrototypeOf(current);
            }
            return [...names];
          };

          const sources = [
            ['panelBot', panel],
            ['game', game]
          ].filter(([, object]) => object && typeof object === 'object');

          const available = [];
          const candidates = [];

          for (const [sourceName, object] of sources) {
            for (const name of propertyNames(object)) {
              if (!/line/i.test(name)) continue;

              let value;
              try { value = object[name]; } catch { continue; }

              if (typeof value === 'function') {
                available.push(sourceName + '.' + name + '()');
                candidates.push({
                  sourceName,
                  name,
                  kind: 'function',
                  object,
                  invoke: argument => value.call(object, argument)
                });
                continue;
              }

              if (!value || typeof value !== 'object') continue;

              for (const method of ['doAction', 'onDown', 'onClick', 'click']) {
                if (typeof value[method] !== 'function') continue;
                available.push(sourceName + '.' + name + '.' + method + '()');
                candidates.push({
                  sourceName,
                  name,
                  kind: 'object-action',
                  method,
                  object: value,
                  invoke: () => value[method]()
                });
              }
            }
          }

          const directionScore = (candidate, direction) => {
            const text = (candidate.sourceName + ' ' + candidate.name + ' ' + (candidate.method || '')).toLowerCase();
            let score = /line/.test(text) ? 20 : 0;

            if (direction > 0) {
              if (/(inc|plus|next|up|more|add)/.test(text)) score += 80;
              if (/(dec|minus|prev|down|less|sub)/.test(text)) score -= 100;
            } else {
              if (/(dec|minus|prev|down|less|sub)/.test(text)) score += 80;
              if (/(inc|plus|next|up|more|add)/.test(text)) score -= 100;
            }

            if (/(set.*line|line.*set)/.test(text)) score += 30;
            if (/change.*line|line.*change/.test(text)) score += 20;
            return score;
          };

          const attempts = [];

          for (let guard = 0; guard < assortment.length + 3; guard++) {
            const currentValue = Number(data.gs.nlines);

            if (currentValue === targetNumber) {
              return {
                ok: true,
                strategy: 'dynamic Belatra line runtime',
                configKey: 'nlines',
                configValue: targetNumber,
                betPerLine: data.gs.betPerLine,
                betPerGame: data.gs.betPerGame,
                attempts,
                availableLineControls: available.slice(0, 80)
              };
            }

            const currentIndex = assortment.findIndex(v => Number(v) === currentValue);
            if (currentIndex < 0) {
              return {
                ok: false,
                reason: 'Current line value not in assortment',
                currentValue,
                target: targetNumber,
                assortment: assortment.map(Number),
                availableLineControls: available.slice(0, 80)
              };
            }

            const direction = targetIndex > currentIndex ? 1 : -1;
            const ranked = [...candidates]
              .map(candidate => ({ candidate, score: directionScore(candidate, direction) }))
              .filter(item => item.score > 0)
              .sort((a, b) => b.score - a.score);

            let changed = false;

            for (const { candidate, score } of ranked) {
              const before = Number(data.gs.nlines);
              const text = candidate.name.toLowerCase();
              const setterLike = /(set.*line|line.*set|change.*line|line.*change)/.test(text);

              try {
                candidate.invoke(setterLike ? targetNumber : undefined);
                await delay(70);
              } catch (error) {
                attempts.push({
                  control: candidate.sourceName + '.' + candidate.name + (candidate.method ? '.' + candidate.method : ''),
                  score,
                  before,
                  error: String(error?.message || error).slice(0, 200)
                });
                continue;
              }

              const after = Number(data.gs.nlines);
              attempts.push({
                control: candidate.sourceName + '.' + candidate.name + (candidate.method ? '.' + candidate.method : ''),
                score,
                before,
                after
              });

              if (after !== before) {
                changed = true;
                break;
              }
            }

            if (!changed) {
              return {
                ok: false,
                reason: 'No discovered line control changed nlines',
                currentValue,
                target: targetNumber,
                assortment: assortment.map(Number),
                availableLineControls: available.slice(0, 80),
                attempts
              };
            }
          }

          return {
            ok: false,
            reason: 'Line configuration guard exhausted',
            target: targetNumber,
            currentValue: Number(data.gs.nlines),
            attempts,
            availableLineControls: available.slice(0, 80)
          };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }, { MODULES, target: control.configValue });
    }

    if (control?.kind === 'BELATRA_BUY_OPTION') {
      return frame.evaluate(index => {
        const banner = globalThis.__parserBelatraBuyBanner;
        if (!banner) return { ok: false, reason: 'Buy banner unavailable' };
        const button =
          (typeof banner.getBuyButton === 'function' ? banner.getBuyButton(index) : null) ||
          banner.buyButtons?.[index];
        if (!button) return { ok: false, reason: 'Buy option unavailable' };

        try {
          if (typeof button.doAction === 'function') button.doAction();
          else if (typeof button.onDown === 'function') button.onDown();
          else return { ok: false, reason: 'Buy option has no invocable action' };

          return {
            ok: true,
            strategy: 'Belatra buy banner option',
            optionIndex: Number(index)
          };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }, Number(control.optionIndex));
    }

    if (control?.kind === 'BELATRA_BUY_CONFIRM') {
      return frame.evaluate(() => {
        const banner = globalThis.__parserBelatraBuyBanner;
        if (!banner) return { ok: false, reason: 'Buy banner unavailable' };
        try {
          if (typeof banner.but_ok?.doAction === 'function') banner.but_ok.doAction();
          else if (typeof banner.exitt === 'function') banner.exitt(true);
          else return { ok: false, reason: 'Buy confirm action unavailable' };
          return { ok: true, strategy: 'Belatra buy banner confirm' };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      });
    }

    if (control?.kind === 'BELATRA_BUY_BET') {
      return frame.evaluate(method => {
        const banner = globalThis.__parserBelatraBuyBanner;
        if (!banner) return { ok: false, reason: 'Buy banner unavailable' };
        const button = method === 'inc' ? banner.but_plus : banner.but_minus;
        try {
          if (typeof button?.doAction === 'function') button.doAction();
          else {
            const fallback = method === 'inc' ? banner.betCostInc : banner.betCostDec;
            if (typeof fallback !== 'function') return { ok: false, reason: 'Buy bet control unavailable' };
            fallback.call(banner);
          }
          return { ok: true, strategy: 'Belatra buy-banner bet control', method };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }, control.method);
    }

    return genericCanvas.pressControl(frame, control);
  }
};
