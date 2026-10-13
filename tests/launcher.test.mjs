import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('detached browser stops when its launcher dies, including zombies and a browser ignoring TERM', () => {
  execFileSync('python3', ['-c', `
import importlib.util,json,os,pathlib,signal,subprocess,sys,tempfile,time
spec=importlib.util.spec_from_file_location('host','frame/browser-host.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory)
    fake=root/'browser.py'
    fake.write_text('''#!/usr/bin/env python3
import json,os,pathlib,signal,sys
root=pathlib.Path(os.environ['VRWATCH_STATE'])
(root/'browser-pid').write_text(str(os.getpid()))
signal.signal(signal.SIGTERM,signal.SIG_IGN if os.environ.get('IGNORE_TERM') else lambda *_: sys.exit(0))
url=next(a[6:] for a in sys.argv if a.startswith('--app='))
buffer=b''
while True:
    buffer+=os.read(3,65536)
    while b'\\\\0' in buffer:
        raw,buffer=buffer.split(b'\\\\0',1);r=json.loads(raw);method=r['method'];result={}
        if method=='Extensions.loadUnpacked':result={'id':'abcdefghijklmnopabcdefghijklmnop'}
        elif method=='Target.getTargets':result={'targetInfos':[{'type':'page','url':url,'targetId':'page'}]}
        elif method=='Target.attachToTarget':result={'sessionId':'session'}
        os.write(4,json.dumps({'id':r['id'],'result':result}).encode()+b'\\\\0')
        if method=='Page.navigate':(root/'ready').write_text('ready')
''')
    fake.chmod(0o755)
    (root/'extension-id').write_text('abcdefghijklmnopabcdefghijklmnop')
    for stubborn in [False,True]:
        owner=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        env=dict(os.environ,VRWATCH_STATE=str(root),VRWATCH_LAUNCHER_PID=str(owner.pid),
                 VRWATCH_LAUNCHER_START_TIME=module.process_start_time(owner.pid))
        env.pop('VRWATCH_TEST_RELAY',None)
        if stubborn:env['IGNORE_TERM']='1'
        host=subprocess.Popen([sys.executable,'frame/browser-host.py',str(fake),'--user-data-dir='+str(root/'profile')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            deadline=time.monotonic()+5
            while not (root/'ready').exists():
                assert host.poll() is None
                assert time.monotonic()<deadline,'host failed to start'
                time.sleep(.02)
            owner.kill() # Deliberately leave it unreaped: /proc still exists.
            started=time.monotonic()
            stdout,stderr=host.communicate(timeout=6)
            assert time.monotonic()-started<5
            assert b'launcher exited; stopping its browser' in stderr,stderr
            pid=int((root/'browser-pid').read_text())
            assert not pathlib.Path('/proc',str(pid)).exists(),'browser was not reaped'
            assert unrelated.poll() is None,'unrelated process was affected'
        finally:
            for process in [host,owner,unrelated]:
                if process.poll() is None:process.kill()
                process.wait()
            (root/'ready').unlink(missing_ok=True)
    assert module.process_start_time(os.getpid()) is not None
    assert module.process_start_time(999999999) is None
    from unittest.mock import patch
    import threading
    stopped=[]
    with patch.object(module,'process_start_time',return_value='new-process-start'):
        module.watch_launcher(123,'old-process-start',threading.Event(),lambda:stopped.append(True))
    assert stopped==[True],'a reused PID retained the old browser'
`], { timeout: 15000 });
});

test('each launch loads the extension before opening its UI, including a fresh restart', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vrwatch launcher '));
  try {
    const browser = path.join(temp, 'fake browser');
    const log = path.join(temp, 'arguments.json');
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    await fs.copyFile('frame/browser-host.py', path.join(temp, 'browser-host.py'));
    await fs.writeFile(path.join(temp, 'extension-id'), id + '\n');
    await fs.writeFile(browser, `#!/usr/bin/env python3
import os,sys,json,time,signal
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
log=os.environ['VRWATCH_TEST_LOG']
record={'args':sys.argv[1:],'calls':[]}
app_url=next(arg.removeprefix('--app=') for arg in sys.argv[1:] if arg.startswith('--app='))
target_queries=0
def save():
    with open(log,'w') as f:json.dump(record,f)
save()
buffer=b''
while True:
    chunk=os.read(3,65536)
    if not chunk:break
    buffer+=chunk
    while b'\\0' in buffer:
        raw,buffer=buffer.split(b'\\0',1)
        r=json.loads(raw);method=r['method'];record['calls'].append(r);save()
        result={}
        error=None
        if method=='Extensions.loadUnpacked':
            if os.environ.get('VRWATCH_TEST_FAILURE'):error={'message':'extension load failed'}
            else:result={'id':'${id}'}
        elif method=='Target.getTargets':
            target_queries+=1
            # A restored browser tab can appear before the dedicated app page.
            unrelated={'type':'page','url':'chrome://newtab/','targetId':'unrelated'}
            result={'targetInfos':[unrelated] if target_queries==1 else [unrelated,{'type':'page','url':app_url,'targetId':'page'}]}
            if target_queries>2 and os.environ.get('VRWATCH_TEST_CLOSE'):result={'targetInfos':[]}
        elif method=='Target.attachToTarget':result={'sessionId':'session'}
        reply={'id':r['id']}
        reply['error' if error else 'result']=error or result
        os.write(4,json.dumps(reply).encode()+b'\\0')
        if method=='Runtime.enable' and os.environ.get('VRWATCH_TEST_STICKS'):
            for context in [{'id':77,'name':'VRWatch','origin':'https://example.org'}, {'id':99,'name':'','origin':'https://example.org'}]:
                os.write(4,json.dumps({'method':'Runtime.executionContextCreated','sessionId':r.get('sessionId'),'params':{'context':context}}).encode()+b'\\0')
        if method=='Page.navigate':
            if os.environ.get('VRWATCH_TEST_CLOSE'):continue
            if os.environ.get('VRWATCH_TEST_NATIVE'):
                if os.environ.get('VRWATCH_TEST_MULTIPAGE'):
                    os.write(4,json.dumps({'method':'Target.attachedToTarget','params':{'sessionId':'auto-initial','targetInfo':{'type':'page','targetId':'page'},'waitingForDebugger':False}}).encode()+b'\\0')
                    os.write(4,json.dumps({'method':'Target.attachedToTarget','params':{'sessionId':'second-page','targetInfo':{'type':'page','targetId':'page-2'},'waitingForDebugger':False}}).encode()+b'\\0')
                    # Chrome reports false here, but a window.open() popup and
                    # its opener still cannot run until explicitly released.
                    sequence=[]
                else:sequence=[('session','xr-started'),('other-session','xr-ended'),('session','unrecognized'),('session','xr-ended')]
                for sess,payload in sequence:
                    os.write(4,json.dumps({'method':'Runtime.bindingCalled','sessionId':sess,'params':{'name':'__vrwatchNative','payload':payload}}).encode()+b'\\0')
            else:time.sleep(.1);sys.exit(0)
        if method=='Runtime.runIfWaitingForDebugger' and r.get('sessionId')=='second-page':
            for sess,payload in [('second-page','xr-started'),('other-session','xr-ended'),('second-page','xr-ended')]:
                os.write(4,json.dumps({'method':'Runtime.bindingCalled','sessionId':sess,'params':{'name':'__vrwatchNative','payload':payload}}).encode()+b'\\0')
        if method=='Page.bringToFront' and not os.environ.get('VRWATCH_TEST_STICKS'):time.sleep(.1);sys.exit(0)
        if method=='Runtime.evaluate' and os.environ.get('VRWATCH_TEST_STICKS'):time.sleep(.1);sys.exit(0)
`, { mode: 0o755 });
    const env = { ...process.env, VRWATCH_BROWSER: browser, VRWATCH_STATE: temp,
      VRWATCH_PROFILE: path.join(temp, 'profile with spaces'), VRWATCH_TEST_LOG: log, SteamAppId: '', VRWATCH_STEAM_PANEL: '1' };
    for (const key of ['VRWATCH_SECCOMP', 'VRWATCH_BASIC_PASSWORD_STORE', 'VRWATCH_START_URL', 'VRWATCH_TEST_RELAY', 'VRWATCH_GPU_RASTERIZATION', 'LD_PRELOAD']) delete env[key];
    for (let launch = 0; launch < 2; launch++) {
      execFileSync('bash', ['frame/vrwatch'], { env, timeout: 10000 });
      const { args, calls } = JSON.parse(await fs.readFile(log, 'utf8'));
      assert.ok(args.includes(`--user-data-dir=${path.join(temp, 'profile with spaces')}`));
      assert.ok(args.includes('--enable-features=OpenXR'));
      assert.ok(args.includes('--class=VRWatch'));
      assert.ok(args.includes('--disable-features=NtpFooter'));
      assert.ok(args.includes('--disable-gpu-rasterization'));
      assert.ok(!args.includes('--disable-gpu'));
      assert.ok(args.includes('--disable-seccomp-filter-sandbox'));
      assert.ok(args.includes('--test-type=vrwatch'));
      assert.ok(args.includes('--remote-debugging-pipe'));
      const appUrl = args.find(arg => arg.startsWith('--app=')).slice('--app='.length);
      assert.equal(new URL(appUrl).protocol, 'file:');
      assert.equal(fileURLToPath(appUrl), path.join(temp, 'browser-start.html'));
      assert.match(await fs.readFile(fileURLToPath(appUrl), 'utf8'), /<title>VRWatch<\/title>/);
      assert.ok(!args.some(arg => arg.startsWith('--remote-debugging-port')));
      assert.ok(!args.includes('--password-store=basic'));
      assert.equal(calls[0].method, 'Extensions.loadUnpacked');
      assert.equal(calls[0].params.path, path.join(temp, 'extension'));
      assert.equal(calls.filter(call => call.method === 'Target.getTargets').length, 2);
      assert.equal(calls.find(call => call.method === 'Target.attachToTarget').params.targetId, 'page');
      assert.equal(calls.at(-1).method, 'Page.navigate');
      assert.equal(calls.at(-1).params.url, `chrome-extension://${id}/home.html?startup=1`);
      const preferences = JSON.parse(await fs.readFile(path.join(temp, 'profile with spaces', 'Default', 'Preferences'), 'utf8'));
      assert.equal(preferences.profile.default_content_setting_values.vr, 1);
    }
    execFileSync('bash', ['frame/vrwatch'], { env: { ...env, VRWATCH_SECCOMP: '1' }, timeout: 10000 });
    const sandboxed = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.ok(!sandboxed.args.includes('--disable-seccomp-filter-sandbox'));
    assert.ok(!sandboxed.args.some(arg => arg.startsWith('--test-type')));
    execFileSync('bash', ['frame/vrwatch'], { env: { ...env, VRWATCH_GPU_RASTERIZATION: '1' }, timeout: 10000 });
    const gpuRaster = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.ok(!gpuRaster.args.includes('--disable-gpu-rasterization'));
    execFileSync('bash', ['frame/vrwatch'], { env: { ...env, VRWATCH_TEST_CLOSE: '1' }, timeout: 8000 });
    const closed = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.equal(closed.calls.filter(call => call.method === 'Target.getTargets').length, 3);
    assert.equal(closed.calls.at(-1).method, 'Target.getTargets');
    assert.throws(() => execFileSync('bash', ['frame/vrwatch'], {
      env: { ...env, VRWATCH_TEST_FAILURE: '1' }, timeout: 10000, stdio: 'pipe'
    }), /VRWatch startup failed: Extensions.loadUnpacked: extension load failed/);
    const failed = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.ok(!failed.calls.some(call => call.method === 'Page.navigate'));
    await fs.writeFile(path.join(temp, 'steam-appid'), '2377856887');
    await fs.writeFile(path.join(temp, 'frame_panel.py'), `import json,os
from pathlib import Path
log=Path(os.environ['VRWATCH_STATE'])/'panel-calls.json'
def record(value):
    calls=json.loads(log.read_text()) if log.exists() else []
    log.write_text(json.dumps(calls+[value]))
def tag_browser_window(pid,appid):record({'action':'tag','pid':pid,'appid':appid})
def show_browser_panel(state,appid):record({'action':'restore','appid':appid})
def hide_dashboard(state):record({'action':'hide'})
`);
    await fs.writeFile(path.join(temp, 'browser_input.py'), `import json,sys,os,time
from pathlib import Path
Path(sys.argv[1],'input-pid').write_text(str(os.getpid()))
while True:
    print(json.dumps([{'index':0,'mapping':'standard','connected':True,'axes':[0,1]}]),flush=True)
    time.sleep(.02)
`);
    execFileSync('bash', ['frame/vrwatch'], { env: { ...env, DISPLAY: ':1', VRWATCH_TEST_NATIVE: '1', VRWATCH_TEST_STICKS: '1' }, timeout: 10000 });
    const native = JSON.parse(await fs.readFile(log, 'utf8'));
    const inputCalls = native.calls.filter(call => call.method === 'Runtime.evaluate');
    assert.ok(inputCalls.length > 0, 'native thumbsticks reach the browser');
    assert.ok(inputCalls.every(call => call.params.contextId === 77 && call.sessionId === 'session'));
    assert.match(inputCalls[0].params.expression, /vrwatch:thumbstick/);
    assert.match(inputCalls[0].params.expression, /document.hasFocus/);
    assert.match(inputCalls[0].params.expression, /xrActive/);
    const inputPid = Number(await fs.readFile(path.join(temp, 'input-pid'), 'utf8'));
    assert.throws(() => process.kill(inputPid, 0), { code: 'ESRCH' });
    await fs.rm(path.join(temp, 'browser_input.py'));
    assert.deepEqual(native.calls.find(call => call.method === 'Runtime.addBinding').params,
      { name: '__vrwatchNative', executionContextName: 'VRWatch' });
    assert.equal(native.calls.filter(call => call.method === 'Page.bringToFront').length, 1);
    const panel = JSON.parse(await fs.readFile(path.join(temp, 'panel-calls.json'), 'utf8'));
    assert.deepEqual(panel.map(call => call.action), ['tag', 'hide', 'restore']);
    assert.ok(panel.filter(call => call.action !== 'hide').every(call => call.appid === 2377856887));
    await fs.rm(path.join(temp, 'panel-calls.json'));
    execFileSync('bash', ['frame/vrwatch'], { env: { ...env, DISPLAY: ':1', VRWATCH_TEST_NATIVE: '1', VRWATCH_TEST_MULTIPAGE: '1' }, timeout: 10000 });
    const multipage = JSON.parse(await fs.readFile(log, 'utf8'));
    assert.equal(multipage.calls.find(call => call.method === 'Target.setAutoAttach').params.autoAttach, true);
    assert.ok(multipage.calls.some(call => call.method === 'Runtime.addBinding' && call.sessionId === 'second-page'));
    assert.ok(!multipage.calls.some(call => call.method === 'Runtime.addBinding' && call.sessionId === 'auto-initial'));
    assert.deepEqual(multipage.calls.filter(call => call.method === 'Runtime.runIfWaitingForDebugger').map(call => call.sessionId),
      ['auto-initial', 'second-page']);
    const popupCalls = multipage.calls.filter(call => call.sessionId === 'second-page');
    assert.deepEqual(popupCalls.slice(0, 3).map(call => call.method),
      ['Runtime.addBinding', 'Runtime.enable', 'Runtime.runIfWaitingForDebugger']);
    assert.equal(multipage.calls.find(call => call.method === 'Page.bringToFront').sessionId, 'second-page');
    const multipagePanel = JSON.parse(await fs.readFile(path.join(temp, 'panel-calls.json'), 'utf8'));
    assert.deepEqual(multipagePanel.map(call => call.action), ['tag', 'tag', 'tag', 'hide', 'restore']);
    // App identity runs beside the browser, without inheriting Steam's scene ID,
    // and the host cleans it up when the browser exits.
    await fs.writeFile(path.join(temp, 'app.json'), '{}');
    await fs.writeFile(path.join(temp, 'app-identity.py'), `import json,os,sys,time
from pathlib import Path
Path(sys.argv[2],'identity-call.json').write_text(json.dumps({'args':sys.argv[1:],'steam':os.environ.get('SteamAppId'),'desktop':os.environ.get('CHROME_DESKTOP'),'pid':os.getpid()}))
time.sleep(30)
`);
    execFileSync('bash', ['frame/vrwatch'], { env: { ...env, SteamAppId: '2377856887', VRWATCH_STEAM_PANEL: '1' }, timeout: 10000 });
    const identity = JSON.parse(await fs.readFile(path.join(temp, 'identity-call.json'), 'utf8'));
    assert.deepEqual(identity.args.slice(0, 2), ['watch', temp]);
    assert.equal(identity.steam, null);
    assert.equal(identity.desktop, 'vrwatch.desktop');
    assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('VR defaults preserve other preferences, site blocks, and profiles in use', () => {
  execFileSync('python3', ['-c', `
import importlib.util,json,os,socket,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('host','frame/browser-host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
with tempfile.TemporaryDirectory(prefix='vrwatch permissions ') as temp:
    root=Path(temp)
    prefs=root/'Default'/'Preferences'
    prefs.parent.mkdir()
    original={'profile':{'default_content_setting_values':{'camera':2,'microphone':3},
                        'content_settings':{'exceptions':{'vr':{'https://blocked.example,*':{'setting':2}}}}},
              'homepage':'https://example.org','password_manager_enabled':True}
    prefs.write_text(json.dumps(original));prefs.chmod(0o600)
    args=['browser','--user-data-dir='+temp]
    host.prepare_profile(args)
    updated=json.loads(prefs.read_text())
    assert updated['profile']['default_content_setting_values'].pop('vr')==1
    assert updated==original
    assert prefs.stat().st_mode & 0o777==0o600
    timestamp=prefs.stat().st_mtime_ns
    host.prepare_profile(args)
    assert prefs.stat().st_mtime_ns==timestamp

    # A second profile gets its own default; the first profile is untouched.
    host.prepare_profile(['browser','--user-data-dir',temp,'--profile-directory=Profile 2'])
    assert json.loads((root/'Profile 2'/'Preferences').read_text())['profile']['default_content_setting_values']['vr']==1
    assert prefs.stat().st_mtime_ns==timestamp

    lock=root/'SingletonLock'
    lock.symlink_to(socket.gethostname()+'-'+str(os.getpid()))
    try:host.prepare_profile(args)
    except RuntimeError as error:assert 'already running' in str(error)
    else:raise AssertionError('active profile must not be edited')
    assert prefs.stat().st_mtime_ns==timestamp
    lock.unlink();lock.symlink_to(socket.gethostname()+'-2147483647')
    host.prepare_profile(args) # Stale locks must not prevent crash recovery.
    lock.unlink()

    prefs.write_text('{invalid JSON')
    try:host.prepare_profile(args)
    except json.JSONDecodeError:pass
    else:raise AssertionError('invalid preferences must not be replaced')
    assert prefs.read_text()=='{invalid JSON'
    assert not (prefs.parent/'Preferences.vrwatch-new').exists()
`], { timeout: 10000 });
});
