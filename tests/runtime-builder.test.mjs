import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('runtime preparation and packaging recognize overlapping ordered patches without changing the real index', () => {
  execFileSync('python3', ['-c', `
import importlib.util,subprocess,sys,tempfile
from pathlib import Path
sys.path.insert(0,'frame')
spec=importlib.util.spec_from_file_location('builder','frame/build-runtime.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);src=root/'src';src.mkdir()
 def git(*args,check=True):
  return subprocess.run(['git',*args],cwd=src,check=check,capture_output=True)
 git('init');(src/'file').write_text('before\\n')
 git('add','file');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base')
 patches=[]
 for i,(before,after) in enumerate([('before','bridge'),('bridge','hud')]):
  patch=root/f'{i}.patch'
  patch.write_text(f'diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-{before}\\n+{after}\\n')
  patches.append(patch)
 index=(src/'.git/index').read_bytes()
 assert b.applied_patch_count(src,patches)==0
 git('apply',str(patches[0]));assert b.applied_patch_count(src,patches)==1
 git('apply',str(patches[1]));assert b.applied_patch_count(src,patches)==2
 assert git('apply','--reverse','--check',str(patches[0]),check=False).returncode!=0
 assert (src/'.git/index').read_bytes()==index
 (src/'file').write_text('unexpected edit\\n')
 try:b.applied_patch_count(src,patches);raise AssertionError('accepted unrelated source edit')
 except RuntimeError:pass
 assert (src/'file').read_text()=='unexpected edit\\n'
`]);
});

test('ordered patch verification includes new and deleted source files', () => {
  execFileSync('python3', ['-c', `
import importlib.util,subprocess,sys,tempfile
from pathlib import Path
sys.path.insert(0,'frame')
spec=importlib.util.spec_from_file_location('builder','frame/build-runtime.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);src=root/'src';src.mkdir()
 def git(*args):return subprocess.run(['git',*args],cwd=src,check=True,capture_output=True)
 git('init');(src/'old').write_text('old\\n');git('add','old')
 git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base')
 (src/'old').unlink();(src/'new').write_text('new\\n');git('add','-A')
 patch=root/'change.patch';patch.write_bytes(git('diff','--cached').stdout)
 git('reset','--hard','HEAD')
 assert b.applied_patch_count(src,[patch])==0
 (src/'new').write_text('unexpected\\n')
 try:b.applied_patch_count(src,[patch]);raise AssertionError('accepted unexpected future source file')
 except RuntimeError:pass
 (src/'new').unlink();git('apply',str(patch));assert b.applied_patch_count(src,[patch])==1
`]);
});
