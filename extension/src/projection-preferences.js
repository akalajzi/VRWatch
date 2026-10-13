import { normalizeProjection } from './projection-detection.js';

const KEY = 'videoProjections';
const LIMIT = 200;

export function cleanProjectionPreferences(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([key, entry]) => key.length <= 2048 && normalizeProjection(entry?.projection) && Number.isFinite(entry?.updated))
    .sort((a, b) => b[1].updated - a[1].updated).slice(0, LIMIT)
    .map(([key, entry]) => [key, { projection: normalizeProjection(entry.projection), updated: entry.updated }]));
}

export function createProjectionPreferences(storage = globalThis.chrome?.storage?.local) {
  let values = {};
  let pending = Promise.resolve();
  return {
    async load() {
      try { values = cleanProjectionPreferences((await storage?.get(KEY))?.[KEY]); }
      catch { values = {}; }
    },
    get(key) { return values[key]?.projection ?? null; },
    reset(key) {
      delete values[key];
      pending = pending.catch(() => {}).then(async () => {
        if (!storage) return;
        const current = cleanProjectionPreferences((await storage.get(KEY))?.[KEY]);
        delete current[key];
        await storage.set({ [KEY]: current });
        delete values[key];
      });
      return pending;
    },
    save(key, projection) {
      if (!normalizeProjection(projection) || key.length > 2048) return Promise.resolve();
      const entry = { projection: normalizeProjection(projection), updated: Date.now() };
      values = cleanProjectionPreferences({ ...values, [key]: entry });
      // Merge against the latest value so a correction in another tab survives.
      pending = pending.catch(() => {}).then(async () => {
        if (!storage) return;
        const current = cleanProjectionPreferences((await storage.get(KEY))?.[KEY]);
        const merged = Object.fromEntries([...Object.entries(current), ...Object.entries(values)]
          .sort((a, b) => a[1].updated - b[1].updated));
        values = cleanProjectionPreferences({ ...merged, [key]: entry });
        await storage.set({ [KEY]: values });
      });
      return pending;
    },
  };
}
