#!/usr/bin/env python3
"""Loopback-only manual acceptance fixture; no browser debugging transport.

Serve from an isolated validation directory containing the existing synthetic
codec samples. Events describe this fixture only, never arbitrary browsing.
"""
import argparse
import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PAGE = b'''<!doctype html><meta charset="utf-8"><title>VRWatch native acceptance</title>
<style>body{font:24px sans-serif;background:#15171b;color:#eee;margin:32px}button,a,input{font:inherit;margin:8px;padding:16px}a{color:#8df}video{width:75vw;max-height:65vh}section{height:110vh}pre{white-space:pre-wrap}</style>
<h1>VRWatch native acceptance</h1><pre id="state"></pre>
<button onclick="report('mark')">Record bounds / focus</button>
<button onclick="report('before-modal');alert('Dismiss this dialog, then verify page focus.');report('after-modal')">Modal dialog</button>
<button onclick="Notification.requestPermission().then(x=>report('permission-'+x))">Notification permission</button>
<button onclick="window.open('/?popup','fixture-popup','width=720,height=600')">Script popup</button>
<a href="/?new-tab" target="_blank">Target-blank tab</a>
<button onclick="report('before-busy');let t=performance.now()+4000;while(performance.now()<t){};report('after-busy')">Busy JS (4 seconds)</button>
<p><a href="/?codec=h264-high-4k.mp4">H.264 High</a><a href="/?codec=vp9-4k.webm">VP9</a><a href="/?codec=av1-4k.mp4">AV1</a><a href="/?iframe">Iframe video</a></p>
<div id="media"></div><section><p>Scroll target: move down and back using the thumbstick.</p></section><h2>Bottom scroll marker</h2>
<script>
const id=crypto.randomUUID(), params=new URLSearchParams(location.search);
function report(event){const v=document.querySelector('video');const r={id,event,query:location.search,time:performance.now(),width:innerWidth,height:innerHeight,focused:document.hasFocus(),visibility:document.visibilityState,scrollY,video:v?{time:v.currentTime,paused:v.paused,width:v.videoWidth,height:v.videoHeight,quality:v.getVideoPlaybackQuality()}:null};document.querySelector('#state').textContent=JSON.stringify(r,null,2);navigator.sendBeacon('/events',JSON.stringify(r));}
if(params.has('iframe')){const f=document.createElement('iframe');f.src='/?codec=h264-high-4k.mp4';f.allow='xr-spatial-tracking; fullscreen';f.width='1500';f.height='900';document.querySelector('#media').append(f);}
else{const file=params.get('codec');if(['h264-high-4k.mp4','vp9-4k.webm','av1-4k.mp4'].includes(file)){const v=document.createElement('video');v.controls=true;v.loop=true;v.src='/'+file;document.querySelector('#media').append(v);for(const e of ['loadedmetadata','playing','pause','seeked','ended','error'])v.addEventListener(e,()=>report(e));}}
for(const e of ['resize','focus','blur','pageshow','pagehide'])addEventListener(e,()=>report(e));document.addEventListener('visibilitychange',()=>report('visibilitychange'));let timer;addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(()=>report('scroll'),200)});report('loaded');
</script>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4193)
    args = parser.parse_args()
    directory = args.directory.resolve()
    args.events.parent.mkdir(parents=True, exist_ok=True)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(directory), **kw)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/':
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(PAGE)))
                self.end_headers()
                self.wfile.write(PAGE)
            elif path in ('/h264-high-4k.mp4', '/vp9-4k.webm', '/av1-4k.mp4'):
                super().do_GET()
            else:
                self.send_error(404)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/events' or not 0 < length <= 16384:
                self.send_error(400)
                return
            try:
                event = json.loads(self.rfile.read(length))
                if not isinstance(event, dict):
                    raise ValueError('Expected object')
            except (ValueError, UnicodeError):
                self.send_error(400)
                return
            with args.events.open('a') as out:
                out.write(json.dumps({'receivedUnix': time.time(), **event}) + '\n')
            self.send_response(204)
            self.end_headers()

    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
