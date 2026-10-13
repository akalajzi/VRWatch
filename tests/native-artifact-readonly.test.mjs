import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('staged native entrypoints preserve immutable inventories across validation, both launcher modes and rejected host startup', () => {
  execFileSync('python3', ['-c', `
import json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,'frame')
import release as r
with tempfile.TemporaryDirectory() as d:
 root=Path(d);runtime=root/'runtime';app=root/'app';runtime.mkdir();app.mkdir()
 for name in ('chrome','vrwatch-chromium'):(runtime/name).write_text('fixture only, never executable')
 r.write_json(runtime/'vrwatch-runtime.json',{'schema':2,'runtimeVersion':'test-native','extensionId':r.EXTENSION_ID,'bridgeProtocol':1,'chromiumMajor':157,'files':r.inventory(runtime)})
 ext=app/'vrwatch-extension';ext.mkdir();manifest=json.loads(Path('extension/manifest.json').read_text());manifest['version']='0.1.3'
 r.write_json(ext/'manifest.json',manifest);(ext/'hud.js').write_text('fixture only')
 helpers=app/'helpers';helpers.mkdir()
 for name in ('candidate-launcher.py','release.py','runtime_provenance.py','native-host.py','native_input.py','browser_input.py','frame_panel.py'):
  shutil.copyfile(Path('frame')/name,helpers/name)
 r.write_json(app/'vrwatch-bundle.json',{'schema':1,'bundleVersion':'0.1.3','extensionId':r.EXTENSION_ID,'bridgeProtocol':1,'minimumChromiumMajor':157,'files':r.inventory(app)})
 ra=root/'runtime.tar.xz';ba=root/'bundle.tar.xz';r.archive(runtime,ra);r.archive(app,ba)
 candidate=root/'candidate';r.stage(ra,ba,candidate)
 state=root/'state';state.mkdir();(state/'steam-appid').write_text('123');(state/'app.json').write_text('{}')
 profile=root/'profile';before=r.inventory(candidate)
 # No environment-wide bytecode override: each shipped entrypoint owns this.
 env={k:v for k,v in os.environ.items() if k!='PYTHONDONTWRITEBYTECODE'}
 commands=[['python3',str(candidate/'helpers/release.py'),'validate',str(candidate)]]
 for flags in (['--bridge-only'],[]):
  commands.append(['python3',str(candidate/'helpers/candidate-launcher.py'),'--release',str(candidate),'--profile',str(profile),'--state',str(state),'--check',*flags])
 for command in commands:
  subprocess.run(command,env=env,check=True,capture_output=True)
  assert r.inventory(candidate)==before,'entrypoint mutated the immutable release'
 env['VRWATCH_STATE']=str(state)
 result=subprocess.run(['python3',str(candidate/'helpers/native-host.py'),'chrome-extension://'+r.EXTENSION_ID+'/'],env=env,capture_output=True,text=True)
 assert result.returncode==1 and 'parent is not the staged Chromium' in result.stderr
 assert r.inventory(candidate)==before,'native helper imports mutated the release'
 assert not list(candidate.rglob('__pycache__')) and not profile.exists()
 r.verify_tree(candidate,'vrwatch-release.json')
`]);
});
