import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('build receipts reject missing stamps, changed inputs and stale binary/resource outputs', () => {
  execFileSync('python3', ['-c', `
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'frame')
from runtime_provenance import write_receipt,verify_receipt
with tempfile.TemporaryDirectory() as d:
 p=Path(d)/'receipt.json'
 def reject(inputs,outputs):
  try: verify_receipt(p,inputs,outputs); raise AssertionError('accepted stale build')
  except RuntimeError: pass
 reject({'patch':'one'},{'chrome':'old'})
 write_receipt(p,{'patch':'one'},{'chrome':'new','resources.pak':'a'})
 verify_receipt(p,{'patch':'one'},{'chrome':'new','resources.pak':'a'})
 reject({'patch':'two'},{'chrome':'new','resources.pak':'a'})
 reject({'patch':'one'},{'chrome':'old','resources.pak':'a'})
 reject({'patch':'one'},{'chrome':'new','resources.pak':'b'})
`]);
});

test('release staging validates artifacts, compatibility and identity; selection and rollback retain both versions', () => {
  execFileSync('python3', ['-c', `
import sys,tempfile,json,tarfile,io,copy
from pathlib import Path
sys.path.insert(0,'frame')
import release as r
with tempfile.TemporaryDirectory() as d:
 root=Path(d);runtime=root/'runtime';app=root/'app';runtime.mkdir();app.mkdir()
 extension=json.loads(Path('extension/manifest.json').read_text())
 (runtime/'chrome').write_bytes(b'fixture only, never executable')
 rm={'schema':2,'runtimeVersion':'test-1','extensionId':r.EXTENSION_ID,'bridgeProtocol':0,'chromiumMajor':157,'files':r.inventory(runtime)}
 r.write_json(runtime/'vrwatch-runtime.json',rm)
 (app/'vrwatch-extension').mkdir();r.write_json(app/'vrwatch-extension/manifest.json',extension)
 bm={'schema':1,'bundleVersion':extension['version'],'extensionId':r.EXTENSION_ID,'bridgeProtocol':0,'minimumChromiumMajor':157,'files':r.inventory(app)}
 r.write_json(app/'vrwatch-bundle.json',bm)
 ra=root/'runtime.tar.xz';ba=root/'bundle.tar.xz';r.archive(runtime,ra);r.archive(app,ba)
 releases=root/'staged';one=releases/'one';two=releases/'two'
 r.stage(ra,ba,one);r.stage(ra,ba,two);r.verify_tree(one,'vrwatch-release.json')
 profile=root/'profile';profile.mkdir()
 r.select(releases,one,profile);r.select(releases,two,profile)
 assert (releases/'current').resolve()==two
 r.select(releases,(releases/'previous').resolve(),profile)
 assert (releases/'current').resolve()==one
 assert one.exists() and two.exists()
 (profile/'SingletonLock').symlink_to('host-99999')
 try: r.select(releases,two,profile);raise AssertionError('accepted locked profile')
 except ValueError: pass
 (one/'chrome').write_bytes(b'tampered')
 try: r.verify_tree(one,'vrwatch-release.json');raise AssertionError('accepted tampering')
 except ValueError: pass
 (profile/'SingletonLock').unlink()
 r.select(releases,(releases/'previous').resolve(),profile)
 assert (releases/'current').resolve()==two, 'rollback must work despite corrupt current files'
 for field,value in [('bridgeProtocol',2),('extensionId','wrong'),('chromiumMajor',100)]:
  altered=copy.deepcopy(rm);altered[field]=value;r.write_json(runtime/'vrwatch-runtime.json',altered)
  ar=root/(field+'.tar.xz');r.archive(runtime,ar)
  try:r.stage(ar,ba,releases/field);raise AssertionError('accepted incompatible runtime')
  except ValueError:pass
 attack=root/'attack.tar.xz'
 with tarfile.open(attack,'w:xz') as tar:
  info=tarfile.TarInfo('../outside');info.size=1;tar.addfile(info,io.BytesIO(b'x'))
 try:r.extract(attack,root/'extract');raise AssertionError('accepted traversal')
 except ValueError:pass
 assert not (root/'outside').exists()
 try:r.archive(app,ba);raise AssertionError('overwrote immutable artifact')
 except ValueError:pass
`]);
});

test('protocol-1 staging feeds the ordinary launcher and rejects moved, altered or locked candidates', () => {
  execFileSync('python3', ['-c', `
import sys,tempfile,json,importlib.util
from pathlib import Path
sys.path.insert(0,'frame')
import release as r
spec=importlib.util.spec_from_file_location('launcher','frame/candidate-launcher.py');l=importlib.util.module_from_spec(spec);spec.loader.exec_module(l)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);runtime=root/'runtime';app=root/'app';runtime.mkdir();app.mkdir()
 for name in ('chrome','vrwatch-chromium'):(runtime/name).write_text('fixture only, never executable')
 r.write_json(runtime/'vrwatch-runtime.json',{'schema':2,'runtimeVersion':'157.native.1','extensionId':r.EXTENSION_ID,'bridgeProtocol':1,'chromiumMajor':157,'files':r.inventory(runtime)})
 ext=app/'vrwatch-extension';ext.mkdir();manifest=json.loads(Path('extension/manifest.json').read_text());manifest['version']='0.1.2'
 r.write_json(ext/'manifest.json',manifest);(ext/'hud.js').write_text('fixture only')
 r.write_json(app/'vrwatch-bundle.json',{'schema':1,'bundleVersion':'0.1.2','extensionId':r.EXTENSION_ID,'bridgeProtocol':1,'minimumChromiumMajor':157,'files':r.inventory(app)})
 ra=root/'runtime.tar.xz';ba=root/'bundle.tar.xz';r.archive(runtime,ra);r.archive(app,ba)
 candidate=root/'candidate';r.stage(ra,ba,candidate)
 state=root/'state';state.mkdir();(state/'steam-appid').write_text('123');(state/'app.json').write_text('{}')
 profile=root/'profile';profile.mkdir();l.validate(candidate,profile,state)
 (profile/'SingletonLock').symlink_to('test-9999')
 try:l.validate(candidate,profile,state);raise AssertionError('accepted lock')
 except ValueError:pass
 (profile/'SingletonLock').unlink()
 moved=root/'moved';candidate.rename(moved)
 try:l.validate(moved,profile,state);raise AssertionError('accepted stale absolute native registration')
 except ValueError:pass
 moved.rename(candidate);(candidate/'vrwatch-extension/hud.js').write_text('changed')
 try:l.validate(candidate,profile,state);raise AssertionError('accepted changed bundle')
 except ValueError:pass
`]);
});
