import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const app = JSON.parse(await fs.readFile('branding/app.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Manifest and package versions differ.');
if (app.version !== pkg.version || app.name !== manifest.name) throw new Error('App metadata and extension identity differ.');
for (const dir of ['extension/src', 'scripts']) {
  for (const name of await fs.readdir(dir)) {
    if (/\.(m?js)$/.test(name)) execFileSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
  }
}
for (const name of ['vrwatch', 'install.sh', 'runtime-browser']) execFileSync('bash', ['-n', `frame/${name}`], { stdio: 'inherit' });
execFileSync('python3', ['-c', "import ast,pathlib; [ast.parse(p.read_text(), filename=str(p)) for directory in ('frame', 'scripts') for p in pathlib.Path(directory).glob('*.py')]"], { stdio: 'inherit' });
console.log('Manifest versions, JavaScript, shell, and Python syntax verified.');
