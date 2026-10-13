import argparse
import importlib.util
import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watch', 'scripts/check-upstream.py')
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)
SOURCE = {'id': 'fixture', 'label': 'Fixture', 'kind': 'github_comments', 'url': 'https://example.invalid'}
OLD = {'1': {'id': 1, 'title': 'Comment', 'html_url': 'https://example.invalid/1', 'body': 'first'}}
NEW = {'1': dict(OLD['1'], body='edited')}


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)

    def events(self):
        return [json.loads(path.read_text()) for path in (self.state / 'inbox').glob('*.json')]

    def check(self, data, save=True):
        return watch.check(SOURCE, self.state, save, current=data)

    def args(self, **overrides):
        sources = self.state / 'sources-fixture.json'
        sources.write_text(json.dumps([SOURCE]))
        values = dict(state_dir=self.state, sources=sources, no_save=False, review=None,
                      health=False, max_age_days=9)
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_unreviewed_change_survives_unchanged_checks(self):
        self.check(OLD)
        self.check(NEW)
        self.assertIn('unchanged:', self.check(NEW))
        events = self.events()
        self.assertEqual(len(events), 2)
        changed = next(event for event in events if event['action'] == 'updated')
        self.assertEqual(changed['before'], OLD['1'])
        self.assertEqual(changed['after'], NEW['1'])
        self.assertEqual(changed['decision'], 'pending')
        self.assertIn(changed['id'], watch.inbox_report(self.state))

    def test_crash_after_queue_write_does_not_lose_or_duplicate_change(self):
        self.check(OLD)
        write = watch.write_json
        def crash(path, value):
            if path == self.state / 'fixture.json':
                raise OSError('simulated interrupted baseline write')
            write(path, value)
        with patch.object(watch, 'write_json', side_effect=crash):
            with self.assertRaises(OSError):
                self.check(NEW)
        self.assertEqual(json.loads((self.state / 'fixture.json').read_text())['records'], OLD)
        self.check(NEW)
        self.assertEqual(len(self.events()), 2)

    def test_legacy_baselines_get_a_review_event(self):
        (self.state / 'fixture.json').write_text(json.dumps({'source': SOURCE, 'records': OLD}))
        self.check(OLD)
        self.check(OLD)
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(self.events()[0]['action'], 'baseline')

    def test_no_save_changes_neither_queue_nor_baseline(self):
        self.check(OLD)
        before = {p.name: p.read_bytes() for p in self.state.rglob('*.json')}
        self.assertIn('CHANGED:', self.check(NEW, save=False))
        after = {p.name: p.read_bytes() for p in self.state.rglob('*.json')}
        self.assertEqual(before, after)

    def test_failed_fetch_keeps_baseline_and_records_failed_health(self):
        self.check(OLD)
        before = (self.state / 'fixture.json').read_bytes()
        args = self.args()
        with patch.object(watch, 'fetch', side_effect=ValueError('bad response')):
            self.assertEqual(watch.run(args), 1)
        self.assertEqual(before, (self.state / 'fixture.json').read_bytes())
        with self.assertRaisesRegex(ValueError, 'last check failed'):
            watch.health(args)

    def test_health_rejects_stale_or_changed_sources(self):
        args = self.args()
        with patch.object(watch, 'fetch', return_value=OLD):
            self.assertEqual(watch.run(args), 0)
        self.assertEqual(watch.health(args), 0)
        path = self.state / 'fixture.json'
        snapshot = json.loads(path.read_text())
        snapshot['observed_at'] = '2020-01-01T00:00:00+00:00'
        watch.write_json(path, snapshot)
        with self.assertRaisesRegex(ValueError, 'Stale source'):
            watch.health(args)
        snapshot['source']['url'] = 'https://example.invalid/new'
        watch.write_json(path, snapshot)
        with self.assertRaisesRegex(ValueError, 'configuration changed'):
            watch.health(args)

    def test_review_needs_a_reason_and_candidate_record(self):
        self.check(OLD)
        event = self.events()[0]
        args = self.args(review=event['id'], decision='candidate', note='Evaluate',
                         reviewer='test-reviewer', revisit_on=None, evidence=None)
        with self.assertRaisesRegex(ValueError, 'adoption record'):
            watch.review(args)
        args.evidence = 'docs/upstream-adoptions.md#frame-seccomp'
        watch.review(args)
        self.check(OLD)
        reviewed = self.events()[0]
        self.assertEqual(reviewed['decision'], 'candidate')
        self.assertEqual(len(reviewed['reviews']), 1)
        args.decision = 'defer'
        with self.assertRaisesRegex(ValueError, 'revisit-on'):
            watch.review(args)
        args.revisit_on = '2026-10-20'
        watch.review(args)
        self.assertEqual(len(self.events()[0]['reviews']), 2)

    def test_overlapping_processes_are_rejected(self):
        with watch.locked(self.state):
            with self.assertRaises(BlockingIOError):
                with watch.locked(self.state):
                    self.fail('Second lock was accepted')

    def test_listing_order_and_rollover_do_not_invent_changes(self):
        self.assertEqual(watch.delta(OLD, {}), [])
        self.assertEqual(watch.delta(OLD, dict(reversed(list(OLD.items())))), [])

    def test_recurring_change_is_not_hidden_by_an_old_ignore_decision(self):
        self.check(OLD)
        self.check(NEW)
        event = next(item for item in self.events() if item['action'] == 'updated')
        args = self.args(review=event['id'], decision='ignore', note='Old occurrence reviewed',
                         reviewer='test-reviewer', revisit_on=None, evidence=None)
        watch.review(args)
        self.check(OLD)
        self.check(NEW)
        repeated = [item for item in self.events() if item['after'] == NEW['1']]
        self.assertEqual(len(repeated), 2)
        self.assertEqual({item['decision'] for item in repeated}, {'ignore', 'pending'})

    def test_complete_comment_pagination_and_listing_gap_detection(self):
        def response(item, link=''):
            stream = io.BytesIO(json.dumps([item]).encode())
            stream.headers = {'Link': link}
            return stream
        item = {'id': 1, 'html_url': 'https://example.invalid/1', 'updated_at': 'now',
                'body': 'first', 'user': {'login': 'fixture'}}
        pages = [response(item, '<https://api.github.com/fixture?page=2>; rel="next"'),
                 response(dict(item, id=2, body='new page'))]
        with patch.object(watch.urllib.request, 'urlopen', side_effect=pages):
            result = watch.fetch(SOURCE)
        self.assertEqual(set(result), {'1', '2'})
        self.check(OLD)
        baseline = (self.state / 'fixture.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'coverage gap'):
            self.check({'2': dict(OLD['1'], id=2)})
        self.assertEqual((self.state / 'fixture.json').read_bytes(), baseline)


if __name__ == '__main__':
    unittest.main()
