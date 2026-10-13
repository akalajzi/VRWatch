import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('Frame panel registration tags only the owned VRWatch window and tolerates closed windows', () => {
  const result = execFileSync('python3', ['-c', `
import importlib.util
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('frame_panel','frame/frame_panel.py')
panel=importlib.util.module_from_spec(spec);spec.loader.exec_module(panel)
commands=[]
def run(args,**kwargs):
    commands.append(args)
    if '_NET_WM_PID' not in args:return SimpleNamespace(returncode=0)
    if args[2]=='0x100':return SimpleNamespace(returncode=0,stdout='_NET_WM_PID(CARDINAL) = 999\\nWM_CLASS(STRING) = "google-chrome"')
    if args[2]=='0x200':return SimpleNamespace(returncode=1,stdout='')
    return SimpleNamespace(returncode=0,stdout='_NET_WM_PID(CARDINAL) = 123\\nWM_CLASS(STRING) = "crx_about_blank", "VRWatch"')
with patch.object(panel.subprocess,'check_output',return_value='  0x100 other browser\\n  0x200 closed window\\n  0x300 VRWatch\\n'),patch.object(panel.subprocess,'run',side_effect=run):
    assert panel.tag_browser_window(123,2377856887)=='0x300'
assert commands[-1]==['xprop','-id','0x300','-f','STEAM_GAME','32c','-set','STEAM_GAME','2377856887']
assert sum('STEAM_GAME' in command for command in commands)==1
print('owned window registered')
`], { encoding: 'utf8' });
  assert.match(result, /owned window registered/);
});

test('every page window owned by the VRWatch browser is tagged for Frame', () => {
  const result = execFileSync('python3', ['-c', `
import importlib.util
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('frame_panel','frame/frame_panel.py')
panel=importlib.util.module_from_spec(spec);spec.loader.exec_module(panel)
tagged=[]
def run(args,**kwargs):
    if 'STEAM_GAME' in args:tagged.append(args[2]);return SimpleNamespace(returncode=0)
    pid=999 if args[2]=='0x100' else 123
    return SimpleNamespace(returncode=0,stdout=f'_NET_WM_PID(CARDINAL) = {pid}\\nWM_CLASS(STRING) = "chrome", "VRWatch"')
with patch.object(panel.subprocess,'check_output',return_value='  0x100 unrelated\\n  0x200 first page\\n  0x300 second page\\n'),patch.object(panel.subprocess,'run',side_effect=run):
    assert panel.tag_browser_window(123,2377856887)=='0x200'
assert tagged==['0x200','0x300']
print('both owned pages registered')
`], { encoding: 'utf8' });
  assert.match(result, /both owned pages registered/);
});
