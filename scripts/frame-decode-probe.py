#!/usr/bin/env python3
"""Measure actual decoder selection through VRWatch's opt-in loopback CDP relay.

Serve the built probe page/samples on Frame loopback, forward the relay over SSH,
and run --help. Never infer hardware decoding from featureStatus alone.
"""
import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


CPU_SCRIPT = r'''
import json,os,pathlib
root=int(__import__('sys').argv[1]); rows={}
for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
 try:
  text=path.read_text(); fields=text[text.rfind(')')+2:].split()
  pid=int(path.parent.name)
  args=(path.parent/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
  kind='browser'
  for flag in ('gpu-process','renderer','utility','zygote'):
   if '--type='+flag in args:kind=flag;break
  rows[pid]=(int(fields[1]),int(fields[11])+int(fields[12]),kind)
 except (OSError,ValueError):pass
owned={root}
while True:
 new={p for p,r in rows.items() if r[0] in owned}-owned
 if not new:break
 owned.update(new)
pss_kib=0; readable=0; decoder_files=set()
decoder_path=os.path.realpath('/dev/video-dec0')
for pid in owned:
 for descriptor in pathlib.Path('/proc',str(pid),'fd').glob('*'):
  try:
   path=os.readlink(descriptor)
   if path in ('/dev/video-dec0',decoder_path):decoder_files.add(path)
  except OSError:pass
 try:
  for line in pathlib.Path('/proc',str(pid),'smaps_rollup').read_text().splitlines():
   if line.startswith('Pss:'):pss_kib+=int(line.split()[1]);readable+=1;break
 except OSError:pass
print(json.dumps({'clockTicks':os.sysconf('SC_CLK_TCK'),'processes':{p:rows[p][1:] for p in owned if p in rows},'pssMiB':pss_kib/1024 if readable else None,'pssProcessCoverage':readable,'processCount':len(owned),'decoderDeviceFiles':sorted(decoder_files)}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--relay', default='http://127.0.0.1:19231')
    parser.add_argument('--ssh', required=True, help='Explicit SSH destination for the test device')
    parser.add_argument('--url', default='http://127.0.0.1:4190/')
    parser.add_argument('--codec', choices=['h264', 'h264-high', 'vp9', 'av1', 'vp8'], default='h264')
    parser.add_argument('--seconds', type=int, default=45)
    parser.add_argument('--warmup-seconds', type=float, default=2)
    parser.add_argument('--xr', action='store_true')
    parser.add_argument('--texture', action='store_true', help='Compare WebGL VideoTexture readback with Canvas2D before the timed interval')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.seconds < 1:
        parser.error('--seconds must be positive')
    if args.warmup_seconds < 0:
        parser.error('--warmup-seconds must be nonnegative')
    base = args.relay.rstrip('/')

    def get(path=''):
        return json.load(urllib.request.urlopen(base + path, timeout=35))

    def call(method, params=None, session=None):
        body = {'method': method, 'params': params or {}}
        if session:
            body['sessionId'] = session
        request = urllib.request.Request(base, json.dumps(body).encode(),
                                         {'Content-Type': 'application/json'})
        try:
            result = json.load(urllib.request.urlopen(request, timeout=35))
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        if 'error' in result:
            raise RuntimeError(result['error'])
        return result['result']

    deadline = time.monotonic() + 20
    while True:
        try:
            meta = get()
            break
        except (OSError, urllib.error.URLError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)
    target = call('Target.createTarget', {'url': 'about:blank'})['targetId']
    session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
    result = {'codec': args.codec, 'xrRequested': args.xr,
              'cpuUnits': 'percent of one logical CPU, entire owned browser process tree',
              'samples': [], 'mediaEvents': []}

    def evaluate(expression):
        value = call('Runtime.evaluate', {'expression': expression, 'returnByValue': True,
                                          'awaitPromise': True, 'userGesture': True}, session)
        if 'exceptionDetails' in value:
            raise RuntimeError(json.dumps(value['exceptionDetails']))
        return value['result'].get('value')

    def cpu():
        return json.loads(subprocess.check_output(
            ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', args.ssh,
             'python3 - ' + str(meta['chromePid'])], input=CPU_SCRIPT.encode(), timeout=15))

    try:
        call('Runtime.enable', session=session)
        call('Media.enable', session=session)
        call('Network.enable', session=session)
        call('Network.setCacheDisabled', {'cacheDisabled': True}, session)
        call('Page.navigate', {'url': args.url}, session)
        call('Page.bringToFront', session=session)
        deadline = time.monotonic() + 20
        while not evaluate('Boolean(globalThis.decodeProbe)'):
            if time.monotonic() > deadline:
                raise TimeoutError('Probe page did not load')
            time.sleep(0.2)
        result['version'] = call('Browser.getVersion')
        result['systemInfo'] = call('SystemInfo.getInfo')
        result['startup'] = evaluate(f'decodeProbe.start({json.dumps(args.codec)})')
        if args.texture:
            result['textureCheck'] = evaluate('decodeProbe.checkTexture()')
        if args.xr:
            call('Browser.grantPermissions', {'origin': args.url.rstrip('/'), 'permissions': ['vr']})
            result['xrStartup'] = evaluate('decodeProbe.enterXR()')
            subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', args.ssh,
                            'python3 "$HOME/.local/share/vrwatch/steam-shortcut.py" hide-dashboard'],
                           check=True, timeout=15)
        print(json.dumps({'startup': result['startup']}), flush=True)
        time.sleep(args.warmup_seconds)
        result['warmupSeconds'] = args.warmup_seconds
        result['preMeasurement'] = evaluate('decodeProbe.beginMeasurement()')
        previous_cpu, previous_time = cpu(), time.monotonic()
        start = previous_time
        seen = set()
        while time.monotonic() - start < args.seconds:
            time.sleep(min(1, max(0, args.seconds - (time.monotonic() - start))))
            current_cpu, now = cpu(), time.monotonic()
            usage = {}
            for pid, (ticks, kind) in current_cpu['processes'].items():
                if pid in previous_cpu['processes']:
                    delta = max(0, ticks - previous_cpu['processes'][pid][0])
                    usage[kind] = usage.get(kind, 0) + delta / current_cpu['clockTicks'] / (now - previous_time) * 100
            sample = evaluate('decodeProbe.snapshot()')
            sample.update(elapsedSeconds=now - start, cpuPercent=sum(usage.values()), cpuByProcessType=usage)
            sample.update(processTreePssMiB=current_cpu['pssMiB'], pssProcessCoverage=current_cpu['pssProcessCoverage'], processCount=current_cpu['processCount'])
            sample['decoderDeviceFiles'] = current_cpu['decoderDeviceFiles']
            result['samples'].append(sample)
            for event in get('/events'):
                if event.get('sessionId') == session and event['method'].startswith('Media.'):
                    key = json.dumps(event, sort_keys=True)
                    if key not in seen:
                        seen.add(key)
                        result['mediaEvents'].append(event)
            previous_cpu, previous_time = current_cpu, now
        result['final'] = evaluate('decodeProbe.snapshot()')
        result['exit'] = evaluate('decodeProbe.stop()')
        by_player = {}
        for event in result['mediaEvents']:
            if event['method'] == 'Media.playerPropertiesChanged':
                params = event['params']
                by_player.setdefault(params['playerId'], {}).update(
                    {p['name']: p['value'] for p in params['properties']})
        result['players'] = by_player
        result['cpuMeanPercent'] = sum(s['cpuPercent'] for s in result['samples']) / len(result['samples'])
        print(json.dumps({k: result[k] for k in ['codec', 'cpuMeanPercent', 'players', 'final', 'exit']}), flush=True)
    finally:
        try:
            evaluate('globalThis.decodeProbe?.stop()')
        finally:
            call('Target.closeTarget', {'targetId': target})
            if args.xr:
                call('Browser.resetPermissions')
            call('Page.bringToFront', session=meta['sessionId'])
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
