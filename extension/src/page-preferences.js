import { readPreferences } from './preferences.js';

export function mountPagePreferences() {
  async function apply() {
    const preferences = await readPreferences();
    document.documentElement.dataset.uiSize = preferences.uiSize;
    document.documentElement.dataset.bookmarkView = preferences.bookmarkView;
  }
  const refresh = () => { void apply().catch(console.error); };
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.preferences) refresh(); });
  window.addEventListener('storage', event => { if (event.key === 'vrwatch.preferences' || event.key === null) refresh(); });
  window.addEventListener('pageshow', refresh);
  window.addEventListener('vrwatch:preferences-changed', refresh);
  refresh();
}
