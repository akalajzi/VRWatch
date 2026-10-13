#!/usr/bin/env python3
"""Isolated existing-runtime diagnostic. CDP is test instrumentation only.

Runs on Frame under a separate Xvfb display and a TemporaryDirectory profile.
Never reads the installed user profile or changes the selected browser.
"""
import argparse
import importlib.util
import json
import tempfile
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, required=True)
    parser.add_argument('--extension', type=Path, required=True)
    parser.add_argument('--host-module', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('host', args.host_module)
    host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
    with tempfile.TemporaryDirectory(prefix='vrwatch-real-tabs-') as temporary:
        chrome = host.ChromePipe(['xvfb-run', '-a', '-s', '-screen 0 1280x800x24',
            str(args.browser.resolve()), '--user-data-dir=' + temporary,
            '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--disable-seccomp-filter-sandbox', '--disable-gpu-rasterization',
            '--disable-features=NtpFooter', 'about:blank'])
        def evaluate(session, expression):
            reply = chrome.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True,
                                'returnByValue': True}, session)
            if 'exceptionDetails' in reply:
                raise RuntimeError(json.dumps(reply['exceptionDetails']))
            return reply.get('result', {}).get('value')
        try:
            extension_id = chrome.call('Extensions.loadUnpacked', {'path': str(args.extension.resolve())})['id']
            assert extension_id == 'bkjijegjmneghekcknijmioimbahmfap'
            target = next(t for t in chrome.call('Target.getTargets')['targetInfos'] if t['type'] == 'page')
            session = chrome.call('Target.attachToTarget', {'targetId': target['targetId'], 'flatten': True})['sessionId']
            chrome.call('Page.navigate', {'url': f'chrome-extension://{extension_id}/home.html'}, session)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    if evaluate(session, '!!globalThis.chrome?.runtime?.id'): break
                except RuntimeError: pass
                time.sleep(0.1)
            # The real extension's messaging and tab implementation is exercised.
            result = evaluate(session, """(async()=>{
              const request=async(action,extra={})=>{const reply=await chrome.runtime.sendMessage({type:'vrwatch:browser',action,...extra});if(reply.error)throw Error(reply.error);return reply.value};
              const first=await request('state'); const windowId=(await chrome.tabs.get(first.currentId)).windowId;
              const samples=[];
              for(const count of [1,5,10]) {
                while((await chrome.tabs.query({windowId})).length<count) await chrome.tabs.create({windowId,active:false,url:'about:blank'});
                const durations=[];
                for(let i=0;i<10;i++){const start=performance.now();await request('state');durations.push(performance.now()-start)}
                const tabs=await chrome.tabs.query({windowId});
                const switches=[];
                for(let i=0;i<5;i++){const start=performance.now();await request('activate',{tabId:tabs.at(-1).id});switches.push(performance.now()-start);await request('activate',{tabId:first.currentId})}
                samples.push({count,metadataMs:durations,switchMs:switches,windows:(await chrome.windows.getAll()).map(w=>({id:w.id,type:w.type}))});
              }
              await chrome.storage.local.set({prepMarker:'synthetic-disposable-profile'});
              return {extensionId:chrome.runtime.id,samples,currentId:first.currentId,storageMarker:(await chrome.storage.local.get('prepMarker')).prepMarker};
            })()""")
            worker = next(t for t in chrome.call('Target.getTargets')['targetInfos'] if t['type'] == 'service_worker' and extension_id in t['url'])
            worker_session = chrome.call('Target.attachToTarget', {'targetId': worker['targetId'], 'flatten': True})['sessionId']
            evaluate(worker_session, "globalThis.originalCapture=chrome.tabs.captureVisibleTab.bind(chrome.tabs);chrome.tabs.captureVisibleTab=async(...args)=>{await new Promise(r=>setTimeout(r,750));return originalCapture(...args)};true")
            time.sleep(1.5)
            result['slowCapture'] = evaluate(session, """(async()=>{
              const request=(action,extra={})=>chrome.runtime.sendMessage({type:'vrwatch:browser',action,...extra});
              const capture=request('capture',{viewport:{width:innerWidth,top:0}});
              await new Promise(r=>setTimeout(r,30));
              let start=performance.now();const state=await request('state');const metadataMs=performance.now()-start;
              start=performance.now();const selected=await request('activate',{tabId:state.value.currentId});const selectMs=performance.now()-start;
              const captured=await capture;
              return {injectedCaptureDelayMs:750,metadataMs,selectMs,error:captured.error??selected.error??null};
            })()""")
            result['limits'] = 'Xvfb, synthetic blank tabs, disposable profile; no headset, component loading, real XR, or site challenge validation'
            args.output.write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result), flush=True)
        finally:
            try: chrome.call('Browser.close')
            except Exception: chrome.process.terminate()
            try: chrome.process.wait(timeout=10)
            except Exception: chrome.process.kill(); chrome.process.wait()


if __name__ == '__main__':
    main()
