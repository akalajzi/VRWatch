import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('bundled runtime verification rejects tampering, extra files, symlinks and wrong architecture', () => {
  execFileSync('python3', ['-c', `
import hashlib,importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('verify','frame/verify-runtime.py')
verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
with tempfile.TemporaryDirectory() as d:
 root=Path(d)
 header=bytearray(20);header[:6]=b'\\x7fELF\\x02\\x01';header[18:20]=b'\\xb7\\x00'
 (root/'chrome').write_bytes(header);(root/'chrome').chmod(0o755)
 (root/'vrwatch-chromium').write_text('synthetic wrapper');(root/'vrwatch-chromium').chmod(0o755)
 def manifest():
  files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.name!='vrwatch-runtime.json'}
  (root/'vrwatch-runtime.json').write_text(json.dumps({'schema':3,'architecture':'linux-arm64','files':files}))
 def reject():
  try:verify.verify(root)
  except ValueError:return
  raise AssertionError('Unexpected verification success')
 manifest();verify.verify(root)
 (root/'chrome').write_bytes(b'tampered');reject();(root/'chrome').write_bytes(header)
 (root/'extra').write_text('unexpected');reject();(root/'extra').unlink()
 (root/'link').symlink_to(root/'chrome');reject();(root/'link').unlink()
 header[18:20]=b'\\x3e\\x00';(root/'chrome').write_bytes(header);manifest();reject()
`]);
});

test('bundled installer selects the wrapper and avoids the browser downloader in an isolated home', () => {
  execFileSync('python3', ['-c', `
import json,os,subprocess,tempfile
from pathlib import Path
repo=Path.cwd()
with tempfile.TemporaryDirectory() as d:
 root=Path(d);home=root/'home';home.mkdir();tools=root/'tools';tools.mkdir()
 browser=root/'browser';browser.mkdir()
 def executable(path,text):path.write_text('#!/bin/sh\\n'+text+'\\n');path.chmod(0o755)
 executable(tools/'uname','echo aarch64')
 executable(tools/'python3','case "$1" in *fetch-browser.py) exit 90;; *) exit 0;; esac')
 executable(tools/'update-desktop-database','exit 0');executable(tools/'gtk-update-icon-cache','exit 0')
 executable(browser/'vrwatch-chromium','echo Chromium-fixture')
 (browser/'chrome').write_text('fixture only');(browser/'vrwatch-runtime.json').write_text('{}')
 # Copy minimal installer inputs; no installed profile or runtime is read.
 import shutil
 package=root/'package';shutil.copytree(repo/'frame',package/'frame',ignore=shutil.ignore_patterns('__pycache__'))
 (package/'branding').mkdir();(package/'branding/app.json').write_text('{}')
 (package/'dist/icons').mkdir(parents=True)
 for name in ['manifest.json','content.js']:(package/'dist'/name).write_text('{}')
 for size in [16,32,48,128,512]:(package/'dist/icons'/('icon'+str(size)+'.png')).write_bytes(b'fixture')
 env={**os.environ,'HOME':str(home),'PATH':str(tools)+':'+os.environ['PATH']}
 subprocess.run(['bash',str(package/'frame/install.sh'),'--bundled-runtime',str(browser)],env=env,check=True,capture_output=True)
 state=home/'.local/share/vrwatch'
 assert (state/'browser-path').read_text().strip()==str(state/'browser/vrwatch-chromium')
 assert (state/'browser/vrwatch-runtime.json').exists()
 assert not (home/'.config/vrwatch').exists()
 assert not list(state.glob('download.*'))
`]);
});
