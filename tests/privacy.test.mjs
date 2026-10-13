import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('privacy check reads the Git index and rejects private files, metadata and secrets without exposing values', () => {
  execFileSync('python3', ['-c', `
import hashlib,json,subprocess,tempfile
from pathlib import Path
root=Path.cwd();guard=root/'scripts/privacy-check.py'
scanner=subprocess.check_output(['git','config','--get','privacy.scanner'],text=True).strip()
secret='gh'+'p_'+hashlib.sha256(b'synthetic privacy regression').hexdigest()[:36]
with tempfile.TemporaryDirectory() as d:
 repo=Path(d)
 def git(*args):return subprocess.run(['git','-C',str(repo),*args],check=True,capture_output=True)
 git('init','-b','main');git('config','privacy.scanner',scanner)
 def stage(name,data):
  path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data);git('add','-f','--',name)
 def check(expected):
  result=subprocess.run(['python3',str(guard),'--repo',str(repo),'--staged'],capture_output=True,text=True)
  assert (result.returncode==0)==expected,result.stdout+result.stderr
  assert secret not in result.stdout+result.stderr
  git('read-tree','--empty')
 stage('example.js',b'export const value = 1;');check(True)
 stage('example.js',('const token = "'+secret+'";').encode())
 (repo/'example.js').write_text('clean working copy must not hide staged secret');check(False)
 stage('example.js',b'export const value = 1;')
 (repo/'example.js').write_text(secret);check(True)
 stage('private/report.txt',b'private evidence');check(False)
 stage('example.txt',('/'+'home'+'/'+ 'someone'+'/file').encode());check(False)
 stage('example.txt','.'.join(map(str,[192,168,5,12])).encode());check(False)
 stage('example.txt',b'203.0.113.12');check(True)
 stage('docs/example.md',('20'+'26-'+'01-02').encode());check(False)
 image='docs/images/vrwatch-home.png';data=(root/image).read_bytes()
 stage(image,data);check(True)
 stage(image,data+b'unreviewed metadata');check(False)
 stage('example.js',('const token = "'+secret+'"; // gitleaks:allow').encode());check(False)
 git('config','--unset','privacy.scanner');stage('example.txt',b'clean source');check(False)
`], { stdio: 'pipe' });
});

test('Git hooks reject secret messages and pushes containing deleted historical secrets or tag messages', () => {
  execFileSync('python3', ['-c', `
import hashlib,shlex,subprocess,tempfile
from pathlib import Path
root=Path.cwd();guard=root/'scripts/privacy-check.py'
scanner=subprocess.check_output(['git','config','--get','privacy.scanner'],text=True).strip()
secret='gh'+'p_'+hashlib.sha256(b'synthetic outgoing history regression').hexdigest()[:36]
with tempfile.TemporaryDirectory() as d:
 base=Path(d);repo=base/'source';repo.mkdir();remote=base/'remote.git'
 def git(*args,ok=True):
  result=subprocess.run(['git','-C',str(repo),*args],capture_output=True,text=True)
  assert secret not in result.stdout+result.stderr
  if ok:assert result.returncode==0,result.stdout+result.stderr
  else:assert result.returncode!=0,result.stdout+result.stderr
  return result
 git('init','-b','main');git('config','user.name','Test contributor');git('config','user.email','test@example.invalid');git('config','privacy.scanner',scanner)
 hooks=base/'hooks';hooks.mkdir()
 for name,mode in [('pre-commit','--staged'),('commit-msg','--message-file "$1"'),('pre-push','--push')]:
  file=hooks/name;file.write_text('#!/bin/sh\\nexec python3 '+shlex.quote(str(guard))+' --repo '+shlex.quote(str(repo))+' '+mode+'\\n');file.chmod(0o755)
 git('config','core.hooksPath',str(hooks))
 (repo/'README.md').write_text('Clean fixture');git('add','.');git('commit','-m','Initial commit')
 subprocess.run(['git','init','--bare',str(remote)],check=True,capture_output=True)
 git('remote','add','fixture',str(remote));git('push','fixture','main')
 git('commit','--allow-empty','-m',secret,ok=False)
 git('tag','-a','test-tag','-m',secret);git('push','fixture','test-tag',ok=False);git('tag','-d','test-tag')
 (repo/'example.js').write_text('const token = "'+secret+'";');git('add','.');git('commit','-m','Fixture secret',ok=False)
 # Deliberately create contaminated history only in this isolated regression fixture.
 git('-c','core.hooksPath=/dev/null','commit','-m','Fixture secret')
 git('rm','example.js');git('commit','-m','Remove fixture secret')
 git('push','fixture','main',ok=False)
 assert git('rev-parse','HEAD').stdout!=git('rev-parse','refs/remotes/fixture/main').stdout
`], { stdio: 'pipe' });
});
