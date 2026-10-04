import { threeOaks } from './threeoaks.js';
import { pragmatic } from './pragmatic.js';
import { belatra } from './belatra.js';
import { genericCanvas } from './generic-canvas.js';

export const providers = [threeOaks, pragmatic, belatra, genericCanvas];

export async function bootstrapSupportedPage(page) {
  for (const provider of providers) {
    if (typeof provider.bootstrapPage !== 'function') continue;
    try { await provider.bootstrapPage(page); } catch {}
  }
}

export async function findRuntime(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const frame of frames) {
      for (const provider of providers) {
        if (await provider.detect(frame, page)) return { provider, frame };
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}
