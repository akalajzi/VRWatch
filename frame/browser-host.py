#!/usr/bin/env python3
"""Load VRWatch on each Chrome launch, then open its app window over a private pipe."""
import json
import os
import queue
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path


def process_start_time(pid):
    """Identify a live launcher, including PID reuse and unreaped exits."""
    try:
        fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
        return fields[19] if fields[0] not in ('Z', 'X') else None
    except (OSError, IndexError):
        return None


def watch_launcher(pid, started, stopping, stop):
    while not stopping.wait(0.5):
        if process_start_time(pid) != started:
            print('VRWatch launcher exited; stopping its browser.', file=sys.stderr, flush=True)
            stop()
            return


def prepare_profile(args):
    """Allow VR by default without overriding other permissions or site blocks."""
    def switch_value(name, default=None):
        value = default
        for index, arg in enumerate(args):
            if arg.startswith(name + '='):
                value = arg.split('=', 1)[1]
            elif arg == name and index + 1 < len(args):
                value = args[index + 1]
        return value

    profile_root = switch_value('--user-data-dir')
    if not profile_root:
        raise RuntimeError('VRWatch requires its own --user-data-dir.')
    root = Path(profile_root).expanduser()
    lock = root / 'SingletonLock'
    if lock.is_symlink():
        hostname, _, pid = os.readlink(lock).rpartition('-')
        if hostname != socket.gethostname() or not pid.isdigit():
            raise RuntimeError('VRWatch profile is locked. Close the existing browser and retry.')
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            pass  # Chrome handles its stale lock when it starts.
        else:
            raise RuntimeError('VRWatch is already running. Close it and retry.')
    elif lock.exists():
        raise RuntimeError('VRWatch profile is locked. Close the existing browser and retry.')

    profile = root / switch_value('--profile-directory', 'Default')
    preferences = profile / 'Preferences'
    # Do not replace unreadable/corrupt preferences with an empty profile.
    data = json.loads(preferences.read_text()) if preferences.exists() else {}
    defaults = data.setdefault('profile', {}).setdefault('default_content_setting_values', {})
    if defaults.get('vr') == 1:
        return
    defaults['vr'] = 1  # Chrome's CONTENT_SETTING_ALLOW; affects only WebXR VR.
    profile.mkdir(parents=True, exist_ok=True)
    temporary = profile / 'Preferences.vrwatch-new'
    try:
        temporary.write_text(json.dumps(data), encoding='utf-8')
        temporary.chmod(preferences.stat().st_mode & 0o777 if preferences.exists() else 0o600)
        temporary.replace(preferences)
    finally:
        temporary.unlink(missing_ok=True)


class ChromePipe:
    def __init__(self, args):
        # Chrome uses fd 3/4 for CDP. Keep browser diagnostics on stderr, not stdout.
        self.process = subprocess.Popen(
            ['bash', '-c', 'exec 3<&0 4>&1; exec 0</dev/null 1>/dev/null; exec "$@"',
             'vrwatch-browser', *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.condition = threading.Condition()
        self.write_lock = threading.Lock()
        self.responses = {}
        self.next_id = 0
        self.events = []
        self.native_events = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        buffer = b''
        while True:
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                with self.condition:
                    self.condition.notify_all()
                return
            buffer += chunk
            while b'\0' in buffer:
                raw, buffer = buffer.split(b'\0', 1)
                if not raw:
                    continue
                reply = json.loads(raw)
                if 'id' in reply:
                    with self.condition:
                        self.responses[reply['id']] = reply
                        self.condition.notify_all()
                else:
                    if reply.get('method') == 'Runtime.bindingCalled' and reply.get('params', {}).get('name') == '__vrwatchNative':
                        self.native_events.put(reply)
                    elif reply.get('method') in ('Target.attachedToTarget', 'Target.detachedFromTarget',
                                                'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed',
                                                'Runtime.executionContextsCleared'):
                        self.native_events.put(reply)
                    if os.environ.get('VRWATCH_TEST_RELAY'):
                        with self.condition:
                            self.events.append(reply)
                            self.events = self.events[-500:]

    def call(self, method, params=None, session_id=None):
        with self.write_lock:
            self.next_id += 1
            ident = self.next_id
            request = {'id': ident, 'method': method, 'params': params or {}}
            if session_id:
                request['sessionId'] = session_id
            self.process.stdin.write(json.dumps(request).encode() + b'\0')
            self.process.stdin.flush()
        deadline = time.monotonic() + 30
        with self.condition:
            while ident not in self.responses:
                if self.process.poll() is not None:
                    raise RuntimeError('Browser exited before VRWatch loaded. Close the existing VRWatch window and retry.')
                if time.monotonic() >= deadline:
                    raise TimeoutError('Browser did not answer ' + method)
                self.condition.wait(0.5)
            reply = self.responses.pop(ident)
        if 'error' in reply:
            raise RuntimeError(method + ': ' + reply['error']['message'])
        return reply.get('result', {})


def main():
    try:
        prepare_profile(sys.argv[1:])
    except Exception as error:
        print('VRWatch startup failed: ' + str(error), file=sys.stderr)
        return 1
    state = Path(os.environ.get('VRWATCH_STATE', str(Path.home() / '.local/share/vrwatch')))
    library = None
    if (state / 'library-server.py').exists():
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location('vrwatch_library', state / 'library-server.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            library = module.start_library(Path.home() / '.config/vrwatch/library.json', state / 'extension')
        except OSError as error:
            print('VRWatch media library could not start: ' + str(error), file=sys.stderr)
    expected_id = (state / 'extension-id').read_text().strip()
    start_url = os.environ.get('VRWATCH_START_URL', 'chrome-extension://' + expected_id + '/home.html?startup=1')
    # Chrome rejects about: URLs for --app and silently opens a tabbed browser.
    # Use a local page until the session-scoped extension is ready to navigate.
    bootstrap = state / 'browser-start.html'
    bootstrap.write_text('<!doctype html><meta charset="utf-8"><title>VRWatch</title>'
                         '<body style="background:#191a1f;color:#f1f2f4;font:16px system-ui;padding:24px">'
                         'Opening VRWatch…</body>', encoding='utf-8')
    bootstrap_url = bootstrap.resolve().as_uri()
    chrome = ChromePipe([*sys.argv[1:], '--remote-debugging-pipe',
                         '--enable-unsafe-extension-debugging', '--app=' + bootstrap_url])
    identity = None
    thumbsticks = None
    stopping = threading.Event()
    def stop(*_):
        if stopping.is_set():
            return
        stopping.set()
        if chrome.process.poll() is None:
            chrome.process.terminate()
            def force_stop():
                if chrome.process.poll() is None:
                    chrome.process.kill()
            timer = threading.Timer(3, force_stop)
            timer.daemon = True
            timer.start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # The browser service is outside Steam's process tree. SIGKILL cannot run
    # the shell's trap, so supervise its original launcher from the service.
    owner_pid = os.environ.get('VRWATCH_LAUNCHER_PID')
    owner_started = os.environ.get('VRWATCH_LAUNCHER_START_TIME')
    if owner_pid and owner_started:
        threading.Thread(target=watch_launcher,
                         args=(owner_pid, owner_started, stopping, stop), daemon=True).start()
    try:
        if (state / 'app.json').exists():
            # The helper is a background OpenVR client, not the scene process.
            # Avoid Steam treating it as the shortcut's VR application.
            identity_env = {key: value for key, value in os.environ.items()
                            if key not in ('SteamAppId', 'SteamGameId', 'STEAM_GAME_ID')}
            identity = subprocess.Popen([sys.executable, str(state / 'app-identity.py'),
                                         'watch', str(state), str(chrome.process.pid)], env=identity_env)
        actual_id = chrome.call('Extensions.loadUnpacked', {'path': str(state / 'extension')})['id']
        if actual_id != expected_id:
            raise RuntimeError('Loaded extension ID does not match VRWatch. Reinstall the application.')
        deadline = time.monotonic() + 10
        while True:
            targets = chrome.call('Target.getTargets')['targetInfos']
            target = next((t for t in targets if t['type'] == 'page' and t['url'] == bootstrap_url), None)
            if target:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Chrome did not create its app window.')
            time.sleep(0.1)
        session = chrome.call('Target.attachToTarget', {'targetId': target['targetId'], 'flatten': True})['sessionId']
        page_sessions = {session: target['targetId']}
        input_contexts = {}
        input_lock = threading.Lock()
        appid = None
        if (state / 'steam-appid').exists() and os.environ.get('DISPLAY'):
            from frame_panel import tag_browser_window, show_browser_panel, hide_dashboard
            appid = int((state / 'steam-appid').read_text().strip())
            tag_browser_window(chrome.process.pid, appid)
            # Available only in the extension's isolated content-script world.
            chrome.call('Runtime.addBinding', {'name': '__vrwatchNative', 'executionContextName': 'VRWatch'}, session)
            chrome.call('Runtime.enable', session_id=session)
            # New app pages get their own isolated-world binding. Restore the
            # page that ended XR rather than always returning to the first one.
            chrome.call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': False,
                                               'flatten': True, 'filter': [{'type': 'page', 'exclude': False}]})

        def native_events():
            while chrome.process.poll() is None:
                try:
                    event = chrome.native_events.get(timeout=0.5)
                except queue.Empty:
                    continue
                method = event.get('method')
                event_session = event.get('sessionId')
                if method == 'Runtime.executionContextCreated':
                    context = event['params']['context']
                    owned = context.get('name') == 'VRWatch' or context.get('origin') == 'chrome-extension://' + expected_id
                    if event_session in page_sessions and owned:
                        with input_lock:
                            input_contexts.setdefault(event_session, set()).add(context['id'])
                    continue
                if method in ('Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'):
                    with input_lock:
                        if method == 'Runtime.executionContextsCleared':
                            input_contexts.pop(event_session, None)
                        else:
                            input_contexts.get(event_session, set()).discard(event['params']['executionContextId'])
                    continue
                if event.get('method') == 'Target.attachedToTarget':
                    params = event['params']
                    attached = params['sessionId']
                    try:
                        if params.get('targetInfo', {}).get('type') != 'page' or appid is None:
                            continue
                        if params['targetInfo']['targetId'] in page_sessions.values():
                            # Auto-attach may also announce the manually attached
                            # startup page. One binding/session per page prevents
                            # duplicate dashboard hides and XR-return events.
                            continue
                        chrome.call('Runtime.addBinding', {'name': '__vrwatchNative', 'executionContextName': 'VRWatch'}, attached)
                        chrome.call('Runtime.enable', session_id=attached)
                        page_sessions[attached] = params['targetInfo']['targetId']
                        tag_browser_window(chrome.process.pid, appid)
                    except Exception as error:
                        print('VRWatch could not register a new browser page: ' + str(error), file=sys.stderr, flush=True)
                    finally:
                        # Browser-level auto-attach pauses window.open() popups
                        # even when waitingForDebugger is reported as false.
                        # Release every session, including duplicates and pages
                        # whose native binding could not be registered.
                        try:
                            chrome.call('Runtime.runIfWaitingForDebugger', session_id=attached)
                        except Exception as error:
                            print('VRWatch could not release a new browser page: ' + str(error), file=sys.stderr, flush=True)
                    continue
                if event.get('method') == 'Target.detachedFromTarget':
                    page_sessions.pop(event['params']['sessionId'], None)
                    with input_lock:
                        input_contexts.pop(event['params']['sessionId'], None)
                    continue
                payload = event['params'].get('payload')
                event_session = event.get('sessionId')
                if event_session not in page_sessions or payload not in ('xr-started', 'xr-ended') or appid is None:
                    continue
                try:
                    if payload == 'xr-started':
                        if page_sessions[event_session] != target['targetId']:
                            # The new X11 window may not have been mapped yet
                            # when its target first attached.
                            tag_browser_window(chrome.process.pid, appid)
                        hide_dashboard(state)
                        continue
                    chrome.call('Page.bringToFront', session_id=event_session)
                    show_browser_panel(state, appid)
                    print('VRWatch browser panel restored after XR exit.', file=sys.stderr, flush=True)
                except Exception as error:
                    print('VRWatch could not restore browser panel: ' + str(error), file=sys.stderr, flush=True)
        threading.Thread(target=native_events, daemon=True).start()
        if appid is not None and (state / 'browser_input.py').exists():
            input_env = {key: value for key, value in os.environ.items()
                         if key not in ('SteamAppId', 'SteamGameId', 'STEAM_GAME_ID')}
            thumbsticks = subprocess.Popen([sys.executable, str(state / 'browser_input.py'), str(state)],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=input_env)
            def relay_thumbsticks():
                was_enabled = None
                for line in thumbsticks.stdout:
                    if stopping.is_set():
                        return
                    try:
                        pads = json.loads(line)
                        if not isinstance(pads, list) or len(pads) > 2:
                            continue
                        with input_lock:
                            contexts = [(sess, context) for sess, ids in input_contexts.items() for context in ids]
                        expression = ('(()=>{const enabled=window.top===window&&document.visibilityState==="visible"&&document.hasFocus()'
                                      '&&document.getElementById("vrwatch-viewer")?.dataset.xrActive!=="true";'
                                      'if(enabled)document.dispatchEvent(new CustomEvent("vrwatch:thumbstick",{detail:' + json.dumps(pads) + '}));return enabled})()')
                        enabled = False
                        for sess, context in contexts:
                            try:
                                result = chrome.call('Runtime.evaluate', {'expression': expression, 'contextId': context,
                                                                         'silent': True, 'returnByValue': True}, sess)
                                enabled = enabled or result.get('result', {}).get('value') is True
                            except (RuntimeError, TimeoutError):
                                # Navigation can destroy a context between the snapshot and dispatch.
                                pass
                        if enabled != was_enabled:
                            thumbsticks.stdin.write('1\n' if enabled else '0\n')
                            thumbsticks.stdin.flush()
                            was_enabled = enabled
                    except (ValueError, OSError):
                        continue
            threading.Thread(target=relay_thumbsticks, daemon=True).start()
        result = chrome.call('Page.navigate', {'url': start_url}, session)
        if result.get('errorText'):
            raise RuntimeError('Could not open VRWatch: ' + result['errorText'])
        print('VRWatch UI loaded.', file=sys.stderr, flush=True)

        def watch_windows():
            # The private control connection and extension may keep Chrome
            # alive after its last window closes. Close the app in that case.
            while not stopping.wait(1):
                if chrome.process.poll() is not None:
                    return
                try:
                    pages = chrome.call('Target.getTargets')['targetInfos']
                    if not any(target['type'] == 'page' for target in pages):
                        stop()
                        return
                except Exception:
                    if chrome.process.poll() is not None:
                        return
        threading.Thread(target=watch_windows, daemon=True).start()

        # Explicit opt-in for device development only; normal launches open no port.
        relay_port = os.environ.get('VRWATCH_TEST_RELAY')
        if relay_port:
            from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
            class Relay(BaseHTTPRequestHandler):
                def do_POST(self):
                    try:
                        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                        value = {'result': chrome.call(request['method'], request.get('params'), request.get('sessionId'))}
                        code = 200
                    except Exception as error:
                        value = {'error': str(error)}
                        code = 500
                    self.respond(value, code)
                def do_GET(self):
                    if self.path == '/events':
                        with chrome.condition:
                            self.respond(chrome.events, 200)
                        return
                    self.respond({'running': chrome.process.poll() is None, 'extensionId': actual_id,
                                  'sessionId': session, 'chromePid': chrome.process.pid}, 200)
                def respond(self, value, code):
                    data = json.dumps(value).encode()
                    self.send_response(code)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                def log_message(self, *_):
                    pass
            relay = ThreadingHTTPServer(('127.0.0.1', int(relay_port)), Relay)
            threading.Thread(target=relay.serve_forever, daemon=True).start()
        return chrome.process.wait()
    except Exception as error:
        print('VRWatch startup failed: ' + str(error), file=sys.stderr)
        return 1
    finally:
        if library is not None:
            library.shutdown()
            library.server_close()
        if thumbsticks is not None:
            thumbsticks.terminate()
            try:
                thumbsticks.wait(timeout=3)
            except subprocess.TimeoutExpired:
                thumbsticks.kill()
                thumbsticks.wait()
        if identity is not None:
            identity.terminate()
            try:
                identity.wait(timeout=5)
            except subprocess.TimeoutExpired:
                identity.kill()
                identity.wait()
        stop()
        try:
            chrome.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.process.kill()
            chrome.process.wait()


if __name__ == '__main__':
    sys.exit(main())
