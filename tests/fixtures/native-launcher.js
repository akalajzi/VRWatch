import { mountNativeLauncher } from '../../extension/src/native-launcher.js';
globalThis.chrome = { runtime: { getURL: name => new URL(name, location.href).href } };
let root;
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (options) { root = attach.call(this, options); return root; };
window.launcherTest = { calls: 0 };
mountNativeLauncher(async () => { window.launcherTest.calls++; });
Element.prototype.attachShadow = attach;
window.launcherTest.root = root;
