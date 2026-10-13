import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSession, validPads } from '../extension/src/native-bridge.js';
import { execFileSync } from 'node:child_process';

const tick = () => new Promise(setImmediate);
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}
function fixture() {
  let owned = { windowId: 10, activeTabId: 1, documentId: 'doc-1', focused: true, hudView: 'closed', restoreSequence: 0 };
  const calls = [], ports = [], timers = [];
  const sender = { id: 'extension', frameId: 0, documentId: 'doc-1', tab: { id: 1, windowId: 10 } };
  const api = {
    runtime: { id: 'extension', getURL: name => 'chrome-extension://extension/' + name,
      sendMessage: async message => calls.push(['hud-pads', message]),
      connectNative() {
        const p = { postMessage: message => calls.push(['host', message]), onMessage: event(), onDisconnect: event(), disconnect() { p.onDisconnect.emit(); } };
        ports.push(p); return p;
      } },
    tabs: { get: async () => sender.tab, sendMessage: async (...args) => calls.push(['page', ...args]) },
    webNavigation: { getFrame: async () => ({ documentId: 'doc-1' }) },
    vrwatchPrivate: { onChanged: event(), request: async request => {
      if (!owned) throw new Error('window closed');
      if (request.operation === 'xr') {
        calls.push(['xr', request]);
        if (request.active) owned.xr = { tabId: request.tabId, documentId: request.documentId, session: request.session };
        else { delete owned.xr; owned.restoreSequence++; }
      }
      if (request.operation === 'hud') { calls.push(['hud', request.view]); owned.hudView = request.view; }
      if (request.operation === 'authorizeHud' && request.documentId !== 'hud-doc') throw new Error('Unowned HUD document');
      return structuredClone(owned);
    } },
  };
  const make = () => createNativeSession(api, { schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: timer => { if (timer) timer.cancelled = true; } });
  const bridge = make();
  const hello = () => ports.at(-1).onMessage.emit({ protocol: 1, type: 'hello' });
  const sample = () => ports.at(-1).onMessage.emit({ protocol: 1, type: 'pads', pads: [{ index: 0, connected: true, axes: [0, 0.5] }] });
  return { api, bridge, make, calls, ports, timers, sender, hello, sample, get owned() { return owned; }, close() { owned = null; api.vrwatchPrivate.onChanged.emit(); } };
}

test('integrated bridge validates document/window, routes bounded input, and native HUD works on restricted tabs', async () => {
  const f = fixture(); f.bridge.start(); await tick(); f.hello(); await tick(); f.sample(); await tick();
  assert.deepEqual(f.calls.find(call => call[0] === 'page').at(-1), { documentId: 'doc-1' });
  for (const sender of [{ ...f.sender, id: 'other' }, { ...f.sender, frameId: 2 }, { ...f.sender, documentId: 'stale' }])
    await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-focus' }, sender));
  f.ports[0].onMessage.emit({ protocol: 1, type: 'hud', view: 'tabs' }); await tick();
  assert.equal(f.owned.hudView, 'tabs');
  f.sample(); await tick(); assert.ok(f.calls.some(call => call[0] === 'hud-pads'));
  f.bridge.stop();
});

test('XR ownership survives worker and host reconnects without a synthetic exit', async () => {
  const f = fixture(); f.bridge.start(); await tick(); f.hello(); await tick();
  await f.bridge.request({ type: 'vrwatch:bridge-xr', session: 'session-a', active: true }, f.sender);
  f.bridge.stop();
  const replacement = f.make(); replacement.start(); await tick(); f.hello(); await tick();
  assert.equal(f.calls.at(-1)[1].xr, true);
  f.ports.at(-1).disconnect(); assert.equal(f.timers.at(-1).delay, 250);
  f.timers.at(-1).fn(); f.hello(); await tick();
  assert.equal(f.calls.at(-1)[1].xr, true);
  const count = f.calls.filter(call => call[0] === 'page').length;
  f.sample(); await tick(); assert.equal(f.calls.filter(call => call[0] === 'page').length, count);
  await replacement.request({ type: 'vrwatch:bridge-xr', session: 'session-a', active: false }, f.sender);
  assert.equal(f.calls.at(-1)[1].restoreSequence, 1);
  replacement.stop();
});

test('window close disconnects helper and cancels reconnect so native messaging cannot retain the browser', async () => {
  const f = fixture(); f.bridge.start(); await tick(); f.hello(); await tick();
  f.close(); await tick();
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 0);
  f.bridge.stop();
});

test('HUD ownership is browser-authenticated, never a page-supplied window ID', async () => {
  const f = fixture();
  const hud = { id: 'extension', documentId: 'hud-doc', url: 'chrome-extension://extension/hud.html' };
  assert.equal((await f.bridge.authorizeHud(hud)).windowId, 10);
  await assert.rejects(f.bridge.authorizeHud({ ...hud, documentId: 'forged', windowId: 10 }));
  await assert.rejects(f.bridge.authorizeHud({ ...hud, tab: f.sender.tab }));
  await assert.rejects(f.bridge.authorizeHud({ ...hud, url: 'chrome-extension://extension/home.html' }));
});

test('clickable menu entry opens the owned native HUD and rejects stale, background or XR pages', async () => {
  const f = fixture();
  await f.bridge.request({ type: 'vrwatch:bridge-menu' }, f.sender);
  assert.ok(f.calls.some(call => call[0] === 'hud' && call[1] === 'navigation'));
  for (const change of [{ focused: false }, { activeTabId: 2 }, { xr: { session: 'xr' } }]) {
    Object.assign(f.owned, { focused: true, activeTabId: 1, xr: null }, change);
    await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-menu' }, f.sender), /Inactive menu origin/);
  }
  await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-menu' }, { ...f.sender, documentId: 'old-page' }), /Stale bridge document/);
});

test('Home omitted by webNavigation uses exact native document identity, never a URL-only bypass', async () => {
  const f = fixture();
  f.api.webNavigation.getFrame = async () => null;
  const home = { ...f.sender, url: f.api.runtime.getURL('home.html') };
  await f.bridge.request({ type: 'vrwatch:bridge-menu' }, home);
  assert.ok(f.calls.some(call => call[0] === 'hud' && call[1] === 'navigation'));
  for (const sender of [{ ...home, documentId: 'stale' }, { ...home, frameId: 2 },
    { ...home, url: 'https://example.com/' }, { ...home, tab: { id: 2, windowId: 10 } }]) {
    await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-menu' }, sender), /Stale bridge document|Unowned bridge sender/);
  }
  f.api.webNavigation.getFrame = async () => ({ documentId: home.documentId, errorOccurred: true });
  await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-menu' }, home), /Stale bridge document/);
});

test('pending input is discarded when XR starts while native state lookup is outstanding', async () => {
  const f = fixture(); f.bridge.start(); await tick(); f.hello(); await tick();
  const original = f.api.vrwatchPrivate.request;
  let release;
  f.api.vrwatchPrivate.request = request => {
    if (request.operation === 'state' && !release) return new Promise(resolve => { release = () => resolve(structuredClone(f.owned)); });
    return original(request);
  };
  f.sample(); await tick();
  await f.bridge.request({ type: 'vrwatch:bridge-xr', active: true, session: 'a' }, f.sender);
  release(); await tick();
  assert.ok(!f.calls.some(call => call[0] === 'page'));
  f.bridge.stop();
});

test('native samples reject oversized, malformed and nonfinite data', () => {
  for (const pads of [[{}, {}, {}], [{ index: 0, connected: true, axes: [NaN] }], [{ index: 0, connected: true, axes: [2] }], [{ index: 8, connected: true, axes: [0] }]]) assert.equal(validPads(pads), false);
});

test('iframe XR origin is validated by its own browser-supplied document, while input/menu stays top-level', async () => {
  const f = fixture();
  f.api.webNavigation.getFrame = async ({ frameId }) => ({ documentId: frameId === 3 ? 'iframe-doc' : 'doc-1' });
  const child = { ...f.sender, frameId: 3, documentId: 'iframe-doc' };
  await f.bridge.request({ type: 'vrwatch:bridge-xr', active: true, session: 'iframe-session' }, child);
  assert.equal(f.calls.find(call => call[0] === 'xr')[1].frameId, 3);
  await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-menu' }, child));
  await assert.rejects(f.bridge.request({ type: 'vrwatch:bridge-xr', active: false, session: 'iframe-session' }, { ...child, documentId: 'stale' }));
});

test('helper retry backoff is bounded and stale ports cannot inject a HUD command', async () => {
  const f = fixture(); f.bridge.start(); await tick();
  const stale = f.ports[0];
  for (let index = 0; index < 9; index++) {
    f.ports.at(-1).disconnect();
    f.timers.at(-1).fn();
  }
  assert.equal(f.timers.at(-1).delay, 10000);
  stale.onMessage.emit({ protocol: 1, type: 'hud', view: 'tabs' });
  await tick(); assert.equal(f.owned.hudView, 'closed');
  f.bridge.stop();
});

test('ordinary busy pages cannot stall navigation; XR cleanup targets its iframe and reports timeout', async () => {
  const f = fixture();
  const messages = [];
  f.api.tabs.sendMessage = (...args) => { messages.push(args); return new Promise(() => {}); };
  const ordinary = f.bridge.leave({ id: 1 }); await tick();
  assert.equal(f.timers.at(-1).delay, 150); f.timers.at(-1).fn(); await ordinary;
  f.owned.xr = { tabId: 1, documentId: 'iframe-doc', session: 'session-a' };
  const xr = f.bridge.leave({ id: 1 }); const rejected = assert.rejects(xr, /not finished exiting/);
  await tick(); assert.deepEqual(messages.at(-1).at(-1), { documentId: 'iframe-doc' });
  f.timers.at(-1).fn(); await rejected;
});

test('helper reconciliation restores once after verified exit and launcher has no debugging path', () => {
  execFileSync('python3', ['-c', `
import importlib.util,pathlib
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('host','frame/native-host.py');calls=[]
h=m.HostState(lambda:calls.append('hide'),lambda seq:calls.append(('restore',seq)))
def state(xr,enabled=True,seq=0): return {'type':'state','enabled':enabled,'xr':xr,'restoreSequence':seq}
h.update(state(True));h.update(state(True));assert calls==['hide']
h.update(state(False,False,1));assert calls==['hide']
h.update(state(False,True,1));h.update(state(False,True,1));assert calls==['hide',('restore',1)]
h=m.HostState(lambda:calls.append('hide'),lambda seq:calls.append(('restore',seq)),restored=1)
h.update(state(False,True,1));assert len(calls)==2
l=load('launcher','frame/candidate-launcher.py')
cmd=l.command(pathlib.Path('/candidate'),pathlib.Path('/profile'))
assert '--vrwatch-hud' in cmd and '--vrwatch-native' in cmd
assert not any('debugging' in arg or 'browser-host.py' in arg for arg in cmd)
assert '--vrwatch-hud' not in l.command(pathlib.Path('/candidate'),pathlib.Path('/profile'),bridge_only=True)
`]);
});

test('native framing handles fragmented reads, EOF, corrupt and oversized messages', () => {
  execFileSync('python3', ['-c', `
import importlib.util,io,struct,json
spec=importlib.util.spec_from_file_location('native','frame/native-host.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
stream=io.BytesIO();m.write_message(stream,{'type':'hello'});stream.seek(0)
assert m.read_message(stream)=={'protocol':1,'type':'hello'}
assert m.read_message(stream) is None
class Fragmented(io.BytesIO):
    def read(self,n): return super().read(min(n,1))
assert m.read_message(Fragmented(stream.getvalue()))['type']=='hello'
for data in [b'x',struct.pack('=I',70000),struct.pack('=I',10)+b'{}',struct.pack('=I',2)+b'[]',struct.pack('=I',2)+b'{}']:
    try: m.read_message(io.BytesIO(data)); raise AssertionError('accepted invalid message')
    except (ValueError,UnicodeError): pass
`]);
});


test('native helper initialization failure exits while its input pipe remains open', () => {
  execFileSync('python3', ['-c', `
import pathlib,subprocess,sys,tempfile
child = r"""
import importlib.util,os,pathlib,sys,threading,types
spec=importlib.util.spec_from_file_location('host','frame/native-host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
host.browser_parent=lambda:os.getpid()
sys.argv=['native-host.py',host.ORIGIN]
os.environ['VRWATCH_STATE']=os.environ['FIXTURE_STATE']
os.environ['VRWATCH_LAUNCH_TOKEN']='a'*32
blocked=threading.Event();original=host.read_message
def read(stream):
    blocked.set()
    return original(stream)
host.read_message=read
def fail(state):
    assert blocked.wait(2)
    raise RuntimeError('fixture initialization failure')
sys.modules['native_input']=types.SimpleNamespace(NativeInput=fail)
sys.modules['frame_panel']=types.SimpleNamespace(tag_browser_window=lambda *a:None,hide_dashboard=lambda *a:None,show_browser_panel=lambda *a:None)
try: host.main()
except RuntimeError as error:
    print(str(error),file=sys.stderr)
    sys.exit(7)
"""
with tempfile.TemporaryDirectory() as directory:
    import os
    pathlib.Path(directory,'steam-appid').write_text('1')
    process=subprocess.Popen([sys.executable,'-c',child],env={**os.environ,'FIXTURE_STATE':directory},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try: result=process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill();process.wait();raise
    finally: process.stdin.close()
    error=process.stderr.read().decode()
    assert result==7,(result,error)
    assert 'fixture initialization failure' in error
    assert '_enter_buffered_busy' not in error
`]);
});
