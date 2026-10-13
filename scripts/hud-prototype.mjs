import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';
const outdir = 'artifacts/hud-prototype';
await fs.mkdir(outdir, { recursive: true });
await esbuild.build({ entryPoints: ['tests/fixtures/hud-prototype.js'], outfile: `${outdir}/fixture.js`, bundle: true, loader: { '.css': 'text' } });
await fs.cp('extension/icons', `${outdir}/icons`, { recursive: true });
await fs.writeFile(`${outdir}/index.html`, `<!doctype html><meta charset="utf-8"><title>VRWatch HUD regression fixture</title><style>body{margin:0;background:#192129;color:white}main{height:1800px;width:100%;padding:20px;box-sizing:border-box}</style><main id="page">Deterministic HUD test page<button id="page-focus">Page focus</button></main><script src="fixture.js"></script>`);
console.log(`Fixture built at ${outdir}; serve on loopback for browser regression checks.`);
