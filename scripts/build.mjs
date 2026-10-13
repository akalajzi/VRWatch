import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const serve = process.argv.includes('--serve');
const candidate = process.argv.includes('--candidate');
const outputArg = process.argv.indexOf('--outdir');
const outdir = outputArg < 0 ? 'dist' : process.argv[outputArg + 1];
if (!outdir) throw new Error('--outdir needs a path');
async function inventory(root, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await inventory(path.join(root, entry.name), name + '/'));
    else if (entry.isFile()) result[name] = createHash('sha256').update(await fs.readFile(path.join(root, entry.name))).digest('hex');
    else throw new Error('Build inputs must be regular files');
  }
  return result;
}
async function inputs() {
  const result = {};
  for (const directory of ['extension', 'licenses']) for (const [name, hash] of Object.entries(await inventory(directory))) result[directory + '/' + name] = hash;
  for (const name of ['package.json', 'package-lock.json', 'scripts/build.mjs', 'LICENSE', 'NOTICE.md']) result[name] = createHash('sha256').update(await fs.readFile(name)).digest('hex');
  return result;
}
const buildInputs = await inputs();
await fs.rm(path.join(outdir, 'vrwatch-bundle-build.json'), { force: true });
await fs.mkdir(outdir, { recursive: true });
await fs.copyFile('extension/manifest.json', path.join(outdir, 'manifest.json'));
if (candidate) {
  const manifest = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
  const versionArg = process.argv.indexOf('--candidate-version');
  manifest.version = versionArg < 0 ? '0.1.2' : process.argv[versionArg + 1];
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.version) || manifest.version === '0.1.1') throw new Error('Candidate requires a changed manifest version');
  manifest.permissions.push('nativeMessaging', 'webNavigation');
  await fs.writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
await fs.cp('extension/pages', outdir, { recursive: true });
await fs.cp('extension/icons', path.join(outdir, 'icons'), { recursive: true });
await fs.cp('licenses', path.join(outdir, 'licenses'), { recursive: true });
await fs.copyFile('LICENSE', path.join(outdir, 'licenses/VRWatch-MPL-2.0.txt'));
await fs.copyFile('NOTICE.md', path.join(outdir, 'licenses/NOTICE.md'));
const context = await esbuild.context({
  entryPoints: { home: 'extension/src/home.js', bookmarks: 'extension/src/bookmark-page.js', settings: 'extension/src/settings.js', library: 'extension/src/library.js', content: 'extension/src/content.js', popup: 'extension/src/popup.js', background: 'extension/src/background.js', ...(candidate ? { hud: 'extension/src/native-hud.js' } : {}) },
  define: { VRWATCH_NATIVE_CANDIDATE: String(candidate) },
  bundle: true, outdir, format: 'iife', target: 'chrome157',
  loader: { '.css': 'text' },
  minify: !serve, sourcemap: serve ? 'inline' : false,
  legalComments: 'eof', logLevel: 'info',
});
await context.rebuild();
if (serve) {
  await context.watch();
  const server = await context.serve({ servedir: outdir, host: '127.0.0.1', port: 4178 });
  console.log(`VRWatch preview: http://127.0.0.1:${server.port}/home.html`);
} else {
  await context.dispose();
  if (JSON.stringify(buildInputs) !== JSON.stringify(await inputs())) throw new Error('Inputs changed during extension build');
  await fs.writeFile(path.join(outdir, 'vrwatch-bundle-build.json'), JSON.stringify({ schema: 1,
    inputs: buildInputs, files: await inventory(outdir), node: process.version,
    esbuild: esbuild.version, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), bridgeProtocol: candidate ? 1 : 0 }, null, 2) + '\n');
}
