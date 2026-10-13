import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('session', 'frame/runtime-build-session.py')
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)

# A tiny executable builder fixture tests orchestration, never Chromium itself.
BUILDER = '''import argparse,json,os,subprocess,uuid
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--work-dir');p.add_argument('--phase')
a,rest=p.parse_known_args()
w=Path(a.work_dir);w.mkdir(exist_ok=True)
commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
with (w/'invocations.jsonl').open('a') as f:f.write(json.dumps({'commit':commit,'args':rest})+'\\n')
with (w/'build.log').open('a') as f:f.write(a.phase+'\\n')
if a.phase=='package':raise SystemExit(7)
with (w/'build.log').open('a') as f:f.write(json.dumps({'stage':'building','pid':os.getpid()})+'\\n')
out=w/'src/out/VRWatch';out.mkdir(parents=True,exist_ok=True)
rows=[{'build_id':str(uuid.uuid4())},
 {'step_id':'compile','rule':'clang/cxx','duration_nanos':100000000000,
  'exec_nanos':1000000000,'utime_nanos':750000000,'stime_nanos':250000000},
 {'step_id':'link','rule':'clang/link','outputs':['chrome'],'exec_nanos':2000000000}]
(out/'siso_metrics.json').write_text(''.join(json.dumps(r)+'\\n' for r in rows))
'''


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'repo'
        self.repo.mkdir()
        self.git('init')
        (self.repo / 'frame').mkdir()
        (self.repo / '.gitignore').write_text('runtime/\n')
        (self.repo / 'frame/build-runtime.py').write_text(BUILDER)
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'builder')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        self.inputs = Path(self.temp.name) / 'inputs'
        (self.inputs / 'patches').mkdir(parents=True)
        (self.inputs / 'patches/0001.patch').write_text('frozen patch')
        (self.inputs / 'args.gn').write_text('frozen args')
        (self.inputs / 'root.gn').write_text('frozen root')
        self.work = self.repo / 'runtime/iteration'

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, stderr=subprocess.DEVNULL, text=True)

    def invoke(self, *extra):
        args = ['session', '--commit', self.commit, '--work-dir', str(self.work),
                '--patch-dir', str(self.inputs / 'patches'), '--gn-args', str(self.inputs / 'args.gn'),
                '--root-gn', str(self.inputs / 'root.gn'), '--bridge-protocol', '1',
                '--runtime-version', 'next.1', *extra]
        output = io.StringIO()
        with patch.object(session, 'REPO', self.repo), patch.object(sys, 'argv', args), contextlib.redirect_stdout(output):
            result = session.main()
        return result, output.getvalue()

    def test_preview_has_no_filesystem_mutations(self):
        result, output = self.invoke()
        plan = json.loads(output)
        self.assertEqual(result, 0)
        self.assertEqual(plan['commit'], self.commit)
        self.assertFalse(plan['execute'])
        self.assertFalse((self.repo / 'runtime').exists())

    def test_pinned_execution_reuses_outputs_despite_main_commit_drift(self):
        out = self.work / 'src/out/VRWatch'
        out.mkdir(parents=True)
        cached = out / 'cached-object.o'
        cached.write_bytes(b'preserve compiled object')
        old_receipt = b'{"original": "compiled-input receipt"}\n'
        (self.work / 'compiled-inputs.json').write_bytes(old_receipt)
        self.assertEqual(self.invoke('--execute')[0], 0)
        (self.repo / 'frame/build-runtime.py').write_text('raise SystemExit("wrong builder")')
        self.git('add', 'frame/build-runtime.py')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'concurrent change')
        self.assertEqual(self.invoke('--execute')[0], 0)
        self.assertEqual(cached.read_bytes(), b'preserve compiled object')
        invocations = [json.loads(s) for s in (self.work / 'invocations.jsonl').read_text().splitlines()]
        self.assertEqual([x['commit'] for x in invocations], [self.commit, self.commit])
        records = [json.loads(s) for s in (self.work / 'build-runs.jsonl').read_text().splitlines()]
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertEqual(record['exitCode'], 0)
            self.assertGreater(record['elapsedSeconds'], 0)
            self.assertEqual(record['siso']['executionWorkerSeconds'], 3)
            self.assertEqual(record['siso']['chromeLinkExecutionSeconds'], 2)
            self.assertGreater(record['logEndByte'], record['logStartByte'])
            self.assertTrue(record['buildInvoked'])
            history = Path(record['receiptHistory'])
            self.assertEqual((history / 'before/compiled-inputs.json').read_bytes(), old_receipt)
            self.assertEqual((history / 'after/compiled-inputs.json').read_bytes(), old_receipt)
            self.assertEqual(json.loads((history / 'run.json').read_text()), record)

    def test_snapshot_tampering_is_rejected_before_builder_runs(self):
        self.invoke('--execute')
        frozen = next((self.repo / 'runtime/build-inputs').iterdir())
        (frozen / 'runtime-args.gn').write_text('tampered')
        with self.assertRaises(SystemExit) as failure:
            self.invoke('--execute')
        self.assertEqual(failure.exception.code, 1)
        self.assertEqual(len((self.work / 'invocations.jsonl').read_text().splitlines()), 1)

    def test_control_checkout_tampering_is_rejected(self):
        self.invoke('--execute')
        (self.repo / 'runtime/build-controls' / self.commit / 'frame/build-runtime.py').write_text('tampered')
        with self.assertRaises(SystemExit):
            self.invoke('--execute')
        self.assertEqual(len((self.work / 'invocations.jsonl').read_text().splitlines()), 1)

    def test_failure_retains_outputs_and_records_exit_status_without_stale_metrics(self):
        self.invoke('--execute')
        metrics = self.work / 'src/out/VRWatch/siso_metrics.json'
        original = metrics.read_bytes()
        self.assertEqual(self.invoke('--execute', '--phase', 'package')[0], 7)
        record = json.loads((self.work / 'build-runs.jsonl').read_text().splitlines()[-1])
        self.assertEqual(record['exitCode'], 7)
        self.assertIsNone(record['siso'])
        self.assertEqual(metrics.read_bytes(), original)

    def test_partial_metrics_do_not_hide_builder_exit_status(self):
        with patch.object(session, 'siso_summary', side_effect=ValueError('partial Siso metrics')):
            self.assertEqual(self.invoke('--execute')[0], 0)
        record = json.loads((self.work / 'build-runs.jsonl').read_text().splitlines()[-1])
        self.assertEqual(record['exitCode'], 0)
        self.assertEqual(record['metricsError'], 'partial Siso metrics')
        self.assertIsNone(record['siso'])

    def test_foreign_build_log_is_not_attributed_to_session(self):
        log = Path(self.temp.name) / 'foreign.log'
        log.write_text(json.dumps({'stage': 'building', 'pid': 100}) + '\n')
        self.assertFalse(session.invoked_build(log, 0, log.stat().st_size, 200))
        self.assertTrue(session.invoked_build(log, 0, log.stat().st_size, 100))

    def test_baseline_review_and_symlink_destinations_are_rejected(self):
        for name in ['chromium-v4l2', 'chromium-v4l2/nested', 'chromium-candidate']:
            with self.assertRaisesRegex(RuntimeError, 'baseline/review'):
                session.validate_work(self.repo, self.repo / 'runtime' / name)
        self.work.mkdir(parents=True)
        (self.work / 'src').symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'symlinked'):
            session.validate_work(self.repo, self.work)


if __name__ == '__main__':
    unittest.main()
