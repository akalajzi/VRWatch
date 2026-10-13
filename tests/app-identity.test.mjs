import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('SteamVR metadata uses its own key and only identifies the owned XR service', () => {
  const result = execFileSync('python3', ['-c', `
import ctypes as C,importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('identity','frame/app-identity.py')
identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
with tempfile.TemporaryDirectory(prefix='vrwatch identity ') as folder:
    state=Path(folder)
    metadata=json.loads(Path('branding/app.json').read_text())
    (state/'app.json').write_text(json.dumps(metadata))
    (state/'steam-appid').write_text('2377856887')
    manifest,key=identity.write_manifest(state)
    app=json.loads(manifest.read_text())['applications'][0]
    assert key=='vrwatch.app'
    assert app['strings']['en_us']['name']=='VRWatch'
    assert app['image_path']==str(state/'app-icon.png')
    assert app['url']=='steam://launch/2377856887/VR'
    (state/'steam-appid').write_text('0')
    try:identity.write_manifest(state)
    except ValueError:pass
    else:raise AssertionError('invalid id accepted')
    (state/'steam-appid').unlink()
    identity.write_manifest(state)
    assert json.loads(manifest.read_text())['applications'][0]['launch_type']=='binary'
    proc=state/'proc';proc.mkdir()
    def process(pid,parent,xr=False):
        directory=proc/str(pid);directory.mkdir(exist_ok=True)
        (directory/'stat').write_text(f'{pid} (browser (name)) S {parent} 0 0')
        args=b'chrome\\0--utility-sub-type=device.mojom.XRDeviceService\\0' if xr else b'chrome\\0'
        (directory/'cmdline').write_bytes(args)
    process(100,1);process(110,100);process(111,110,True)
    process(200,1);process(211,200,True) # Another Chrome XR installation.
    process(300,1) # An exiting process with a missing cmdline.
    (proc/'300/cmdline').unlink()
    assert identity.xr_processes(100,proc)==[111]
    # A restarted XR service must be rediscovered; no cached PID.
    import shutil
    shutil.rmtree(proc/'111');process(112,110,True)
    (proc/'112/cmdline').write_bytes(b'chrome --type=utility --utility-sub-type=device.mojom.XRDeviceService --lang=en-US\\0')
    assert identity.xr_processes(100,proc)==[112]
    calls=[]
    api=identity.Applications.__new__(identity.Applications)
    def get_key(pid,buffer,size):buffer.value=b'steam.app.2377856887';return 0
    api.get_key=get_key
    api.identify=lambda pid,key:calls.append((pid,key)) or 0
    assert api.identify_if_connected(112,'vrwatch.app')
    assert calls==[(112,b'vrwatch.app')]
    api.get_key=lambda pid,buffer,size:buffer.__setattr__('value',b'vrwatch.app') or 0
    assert not api.identify_if_connected(112,'vrwatch.app')
    api.get_key=lambda *args:104
    assert not api.identify_if_connected(112,'vrwatch.app')
    assert len(calls)==1
print('identity verified')
`], { encoding: 'utf8' });
  assert.match(result, /identity verified/);
});
