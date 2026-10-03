import { threeOaks } from './threeoaks.js';
import { pragmatic } from './pragmatic.js';

export const providers = [threeOaks, pragmatic];

export async function findRuntime(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const frame of frames) {
      for (const provider of providers) {
        if (await provider.detect(frame)) return { provider, frame };
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}
