const HOST_RX = /(^|\.)(bgaming\.com|belatragames\.com)$/i;

function isGenericOfficialHost(hostname) {
  return HOST_RX.test(String(hostname || ''));
}

export const genericCanvas = {
  id: 'generic-canvas',

  async bootstrapPage(page) {
    let host = '';
    try { host = new URL(page.url()).hostname; } catch {}
    if (!isGenericOfficialHost(host)) return { attempted: false };

    const context = page.context();
    const dismissPatterns = [
      /accept all|accept cookies|aceptar todo|aceptar cookies|allow all/i,
      /^ocultar$/i,
      /^close$/i,
      /^cerrar$/i
    ];

    for (const pattern of dismissPatterns) {
      const locators = [
        page.getByRole('button', { name: pattern }),
        page.getByRole('link', { name: pattern }),
        page.getByText(pattern, { exact: true })
      ];
      for (const locator of locators) {
        try {
          const count = Math.min(await locator.count(), 8);
          for (let i = 0; i < count; i++) {
            const el = locator.nth(i);
            if (await el.isVisible({ timeout: 150 }).catch(() => false)) {
              await el.click({ timeout: 1200, force: true }).catch(() => {});
              await page.waitForTimeout(250);
              break;
            }
          }
        } catch {}
      }
    }

    const launchPatterns = /play demo|jugar demo|play free|jugar gratis|play now|jugar ahora|^on-line$|^online$|^start$|^jugar$/i;
    const launchers = [
      page.getByRole('button', { name: launchPatterns }),
      page.getByRole('link', { name: launchPatterns }),
      page.getByText(launchPatterns, { exact: true }),
      page.locator('button,a,[role="button"]').filter({ hasText: launchPatterns })
    ];

    const pagesBefore = new Set(context.pages());

    for (const locator of launchers) {
      let count = 0;
      try { count = Math.min(await locator.count(), 20); } catch {}
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        let visible = false;
        try { visible = await el.isVisible({ timeout: 200 }); } catch {}
        if (!visible) continue;

        try {
          await el.scrollIntoViewIfNeeded({ timeout: 600 }).catch(() => {});
          await el.click({ timeout: 2200, force: true });
          await page.waitForTimeout(1800);

          const newPages = context.pages().filter(p => !pagesBefore.has(p));
          if (newPages.length) {
            const popup = newPages[newPages.length - 1];
            await popup.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
            const popupUrl = popup.url();
            if (popupUrl && popupUrl !== 'about:blank') {
              await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => {});
              await page.waitForTimeout(1800);
            }
            await popup.close().catch(() => {});
          }

          // Some launchers lazy-load iframe src from data-src/data-url.
          await page.evaluate(() => {
            for (const iframe of document.querySelectorAll('iframe')) {
              const current = iframe.getAttribute('src') || '';
              if (current && current !== 'about:blank') continue;
              const candidate =
                iframe.getAttribute('data-src') ||
                iframe.getAttribute('data-url') ||
                iframe.dataset?.src ||
                iframe.dataset?.url ||
                '';
              if (/^https?:\/\//i.test(candidate)) iframe.src = candidate;
            }
          }).catch(() => {});

          await page.waitForTimeout(1800);
          return { attempted: true, clicked: true, textIndex: i };
        } catch {}
      }
    }

    // Last-resort native click for custom wrappers that Playwright does not
    // expose as a semantic button/link.
    const native = await page.evaluate(() => {
      const wanted = /^(play demo|jugar demo|play free|jugar gratis|play now|jugar ahora|on-line|online|start|jugar)$/i;
      const nodes = [...document.querySelectorAll('button,a,[role="button"],div,span')];
      const target = nodes.find(el => wanted.test(String(el.textContent || '').trim()));
      if (!target) return false;
      try { target.click(); return true; } catch { return false; }
    }).catch(() => false);

    if (native) {
      await page.waitForTimeout(2500);
      return { attempted: true, clicked: true, native: true };
    }

    return { attempted: true, clicked: false };
  },

  async detect(frame, page) {
    let topLevelOfficial = false;
    try {
      const host = new URL(page.url()).hostname;
      topLevelOfficial = /(^|\.)(bgaming\.com|belatragames\.com)$/i.test(host);
    } catch {}

    if (!topLevelOfficial) return false;

    return frame.evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')].filter(canvas => {
        const r = canvas.getBoundingClientRect();
        const s = getComputedStyle(canvas);
        return r.width > 40 && r.height > 40 && s.display !== 'none' && s.visibility !== 'hidden';
      });

      return canvases.length > 0;
    }).catch(() => false);
  },

  async isDemo(frame) {
    return frame.evaluate(() => {
      const host = location.hostname;
      const href = location.href;
      const ancestors = (() => {
        try { return Array.from(location.ancestorOrigins || []); } catch { return []; }
      })().join(' ');

      return /demo|free-slot|bgaming|belatra/i.test(href + ' ' + host + ' ' + ancestors);
    }).catch(() => false);
  },

  async stateSnapshot(frame) {
    return frame.evaluate(() => {
      const visible = el => {
        try {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
        } catch {
          return false;
        }
      };

      const interactive = [...document.querySelectorAll('button,a,[role="button"],[tabindex],input[type="button"],input[type="submit"]')]
        .filter(visible)
        .slice(0, 80)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 100),
          aria: el.getAttribute('aria-label') || null,
          title: el.getAttribute('title') || null,
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
        }));

      const canvasSamples = [...document.querySelectorAll('canvas')]
        .filter(visible)
        .slice(0, 3)
        .map(canvas => {
          const r = canvas.getBoundingClientRect();
          const sample = [];
          try {
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (gl) {
              const w = gl.drawingBufferWidth || canvas.width || 1;
              const h = gl.drawingBufferHeight || canvas.height || 1;
              const pts = [
                [0.2,0.2],[0.5,0.2],[0.8,0.2],
                [0.2,0.5],[0.5,0.5],[0.8,0.5],
                [0.2,0.8],[0.5,0.8],[0.8,0.8]
              ];
              for (const [nx, ny] of pts) {
                const px = new Uint8Array(4);
                gl.readPixels(
                  Math.max(0, Math.min(w - 1, Math.floor(nx * w))),
                  Math.max(0, Math.min(h - 1, Math.floor((1 - ny) * h))),
                  1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px
                );
                sample.push(...px);
              }
            } else {
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                const pts = [
                  [0.2,0.2],[0.5,0.2],[0.8,0.2],
                  [0.2,0.5],[0.5,0.5],[0.8,0.5],
                  [0.2,0.8],[0.5,0.8],[0.8,0.8]
                ];
                for (const [nx, ny] of pts) {
                  const data = ctx.getImageData(
                    Math.max(0, Math.min(canvas.width - 1, Math.floor(nx * canvas.width))),
                    Math.max(0, Math.min(canvas.height - 1, Math.floor(ny * canvas.height))),
                    1, 1
                  ).data;
                  sample.push(...data);
                }
              }
            }
          } catch {}

          return {
            width: Math.round(r.width),
            height: Math.round(r.height),
            sample
          };
        });

      return {
        href: location.hostname + location.pathname,
        title: document.title,
        interactive,
        canvasSamples
      };
    }).catch(() => null);
  },

  async scan(frame) {
    const controls = await this.listControls(frame);
    return { ready: true, controls };
  },

  async listControls(frame) {
    return frame.evaluate(() => {
      const visible = el => {
        try {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
        } catch {
          return false;
        }
      };

      const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const selector = 'button,a,[role="button"],[tabindex],input[type="button"],input[type="submit"]';
      const counts = new Map();
      const controls = [];

      for (const el of [...document.querySelectorAll(selector)].filter(visible).slice(0, 120)) {
        const tag = el.tagName.toLowerCase();
        const text = normalize(el.innerText || el.value);
        const aria = normalize(el.getAttribute('aria-label'));
        const title = normalize(el.getAttribute('title'));
        const href = tag === 'a' ? normalize(el.getAttribute('href')) : '';
        const semantic = (aria || text || title || href || tag).toLowerCase();

        let name = semantic || tag;
        if (/play demo|jugar demo|play free|jugar gratis/.test(name)) name = 'play_demo';
        else if (/spin|girar|tirar/.test(name)) name = 'spin';
        else if (/continue|continuar/.test(name)) name = 'continue';
        else if (/confirm|confirmar|yes|si|sí/.test(name)) name = 'confirm';
        else if (/buy|comprar|purchase/.test(name)) name = 'buy';
        else name = name.slice(0, 80);

        const key = [tag,text,aria,title,href].join('|');
        const occurrence = counts.get(key) || 0;
        counts.set(key, occurrence + 1);

        controls.push({
          kind: 'DOM',
          name,
          tag,
          text,
          aria: aria || null,
          title: title || null,
          href: href || null,
          occurrence,
          active: !Boolean(el.disabled) && el.getAttribute('aria-disabled') !== 'true'
        });
      }

      const canvases = [...document.querySelectorAll('canvas')].filter(visible);
      if (canvases.length) {
        const taps = [
          ['canvas_center', 0.50, 0.50],
          ['canvas_top', 0.50, 0.18],
          ['canvas_bottom', 0.50, 0.82],
          ['canvas_left', 0.18, 0.50],
          ['canvas_right', 0.82, 0.50],
          ['canvas_tl', 0.20, 0.20],
          ['canvas_tr', 0.80, 0.20],
          ['canvas_bl', 0.20, 0.80],
          ['canvas_br', 0.80, 0.80]
        ];
        for (const [name, nx, ny] of taps) {
          controls.push({
            kind: 'CANVAS_TAP',
            name,
            canvasIndex: 0,
            nx,
            ny,
            active: true
          });
        }
      }

      controls.push(
        { kind: 'KEY', name: 'key_enter', key: 'Enter', active: true },
        { kind: 'KEY', name: 'key_space', key: ' ', active: true },
        { kind: 'KEY', name: 'key_escape', key: 'Escape', active: true }
      );

      return controls;
    }).catch(() => []);
  },

  async pressControl(frame, control) {
    return frame.evaluate(({ control }) => {
      const visible = el => {
        try {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        } catch {
          return false;
        }
      };
      const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);

      try {
        if (control?.kind === 'DOM') {
          const selector = 'button,a,[role="button"],[tabindex],input[type="button"],input[type="submit"]';
          const matches = [...document.querySelectorAll(selector)]
            .filter(visible)
            .filter(el => {
              const tag = el.tagName.toLowerCase();
              const text = normalize(el.innerText || el.value);
              const aria = normalize(el.getAttribute('aria-label'));
              const title = normalize(el.getAttribute('title'));
              const href = tag === 'a' ? normalize(el.getAttribute('href')) : '';
              return tag === control.tag &&
                text === String(control.text || '') &&
                aria === String(control.aria || '') &&
                title === String(control.title || '') &&
                href === String(control.href || '');
            });

          const target = matches[Number(control.occurrence || 0)] || matches[0];
          if (!target) return { ok: false, reason: 'DOM target unavailable', control: control.name };

          target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          target.click();
          return { ok: true, strategy: 'DOM pointer/click', control: control.name };
        }

        if (control?.kind === 'CANVAS_TAP') {
          const canvases = [...document.querySelectorAll('canvas')].filter(visible);
          const target = canvases[Number(control.canvasIndex || 0)] || canvases[0];
          if (!target) return { ok: false, reason: 'Canvas unavailable', control: control.name };

          const r = target.getBoundingClientRect();
          const clientX = r.left + r.width * Number(control.nx ?? 0.5);
          const clientY = r.top + r.height * Number(control.ny ?? 0.5);
          const common = { bubbles: true, cancelable: true, clientX, clientY };

          target.dispatchEvent(new PointerEvent('pointermove', { ...common, pointerType: 'mouse' }));
          target.dispatchEvent(new MouseEvent('mousemove', common));
          target.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerType: 'mouse', buttons: 1 }));
          target.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));
          target.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerType: 'mouse', buttons: 0 }));
          target.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
          target.dispatchEvent(new MouseEvent('click', common));

          return { ok: true, strategy: 'canvas pointer/click', control: control.name, clientX, clientY };
        }

        if (control?.kind === 'KEY') {
          const key = String(control.key || '');
          const target = document.activeElement || document.body || document.documentElement;
          const code = key === ' ' ? 'Space' : key;
          for (const type of ['keydown','keypress','keyup']) {
            target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
          }
          return { ok: true, strategy: 'KeyboardEvent', control: control.name, key };
        }

        return { ok: false, reason: 'Unsupported generic control kind', kind: control?.kind ?? null };
      } catch (error) {
        return { ok: false, reason: String(error?.message || error), control: control?.name ?? null };
      }
    }, { control });
  }
};
