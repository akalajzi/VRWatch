import { mountPagePreferences } from './page-preferences.js';
import { mountBrowserHUD } from './browser-hud.js';
import { mountBrowserScroll } from './browser-scroll.js';
import { mountNativeContent } from './native-content.js';
export function mountManagePage(refresh) {
  mountPagePreferences();
  mountNativeContent(); mountBrowserHUD({ home: true }); mountBrowserScroll();
  globalThis.chrome?.storage?.onChanged?.addListener((_changes, area) => { if (area === 'local') void refresh(); });
  window.addEventListener('storage', event => { if (event.key?.startsWith('vrwatch.')) void refresh(); });
  window.addEventListener('pageshow', () => { void refresh(); });
}
export function showMessage(text, error = false) {
  const element = document.querySelector('#message'); element.textContent = text; element.classList.toggle('error', error);
}
