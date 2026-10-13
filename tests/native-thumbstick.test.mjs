import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('Frame samples invert Y, clear disconnected inputs, and reject nonfinite axes', () => {
  execFileSync('python3', ['-c', `
import importlib.util,json,ctypes as C
from pathlib import Path
spec=importlib.util.spec_from_file_location('input','frame/browser_input.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
assert C.sizeof(module.ActiveSet)==32
assert C.sizeof(module.Analog)==48
reader=module.Thumbsticks.__new__(module.Thumbsticks)
calls=[]
reader.update=lambda pointer,size,count:calls.append((pointer,size,count)) or 0
assert reader.sample(False)==[]
assert calls==[(None,32,0)]
reader.update=lambda *args:8
assert reader.sample(False)==[]
for active,y,expected in [(True,1,-1),(True,-1,1),(False,1,0),(True,float('nan'),0),(True,float('inf'),0)]:
    value=module.Analog(active=active,y=y)
    pad=module.sample_pad(0,value)
    assert pad['axes']==[0,expected]
    assert pad['connected']==active
    json.dumps(pad,allow_nan=False)
actions=json.loads(Path('frame/browser-input/actions.json').read_text())
binding=json.loads(Path('frame/browser-input/frame-controller.json').read_text())
names={action['name'] for action in actions['actions']}
sources=binding['bindings']['/actions/browser']['sources']
assert {source['inputs']['position']['output'] for source in sources}==names
assert {source['path'] for source in sources}=={'/user/hand/left/input/thumbstick','/user/hand/right/input/thumbstick'}
`]);
});
