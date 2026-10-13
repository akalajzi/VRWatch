import { mountBrowserHUD } from './browser-hud.js';

// One shared bar; no page padding or site header overrides.
export function mountNavigation() {
  mountBrowserHUD();
}
