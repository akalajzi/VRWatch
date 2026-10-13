#!/usr/bin/env python3
"""Report upstream changes without modifying browser, device, or reviewed status."""
import argparse
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def locked(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / '.watch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def records(kind, data):
    """Discard reaction counts and transport fields, keeping substantive content."""
    if kind not in ('steam_news', 'github_issues', 'github_comments', 'github_commits', 'gerrit'):
        raise ValueError('Unknown source kind: ' + kind)
    if kind == 'steam_news':
        data = data['appnews']['newsitems']
    if not isinstance(data, list):
        raise ValueError('Expected an API list')
    result = {}
    for item in data:
        if kind == 'github_issues':
            record = {key: item[key] for key in
                      ('id', 'html_url', 'title', 'state', 'updated_at', 'body', 'comments')}
            record['labels'] = sorted(label['name'] for label in item['labels'])
            record['author'] = item['user']['login']
        elif kind == 'github_comments':
            record = {key: item[key] for key in ('id', 'html_url', 'updated_at', 'body')}
            record['title'] = 'Comment by ' + item['user']['login']
        elif kind == 'github_commits':
            record = {'id': item['sha'], 'html_url': item['html_url'],
                      'title': item['commit']['message'].splitlines()[0],
                      'message': item['commit']['message'],
                      'date': item['commit']['committer']['date']}
        elif kind == 'gerrit':
            record = {key: item[key] for key in ('status', 'updated')}
            record.update(id=item['_number'], title=item['subject'],
                          html_url=f"https://chromium-review.googlesource.com/c/chromium/src/+/{item['_number']}")
        elif kind == 'steam_news':
            record = {key: item[key] for key in ('title', 'date', 'contents')}
            record.update(id=item['gid'], html_url=item['url'])
        else:
            raise ValueError('Unknown source kind: ' + kind)
        result[str(record['id'])] = record
    return result


def fetch(source):
    headers = {'User-Agent': 'VRWatch-upstream-watch/1.0', 'Accept': 'application/json'}
    if urllib.parse.urlparse(source['url']).hostname == 'api.github.com' and os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    request = urllib.request.Request(source['url'], headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read().decode('utf-8')
                links = response.headers.get('Link', '')
            break
        except (urllib.error.URLError, TimeoutError) as error:
            retry = not isinstance(error, urllib.error.HTTPError) or error.code in (429, 500, 502, 503, 504)
            if not retry or attempt == 2:
                raise
            time.sleep(2 ** attempt)
    if raw.startswith(")]}'"):
        raw = raw.split('\n', 1)[1]
    result = records(source['kind'], json.loads(raw))
    # Issue comments are oldest-first: checking only page one can silently miss
    # every new comment once a thread exceeds 100 comments.
    next_page = re.search(r'<([^>]+)>;\s*rel="next"', links)
    if source['kind'] == 'github_comments' and next_page:
        if source.get('_page', 1) >= 20:
            raise ValueError('Comment pagination exceeds 20 pages; manual review required')
        if urllib.parse.urlparse(next_page[1]).hostname != 'api.github.com':
            raise ValueError('Unexpected comment pagination host')
        following = dict(source, url=next_page[1], _page=source.get('_page', 1) + 1)
        result.update(fetch(following))
    return result


def delta(previous, current):
    return [(key, 'new' if key not in previous else 'updated')
            for key in current
            if key not in previous or digest(previous[key]) != digest(current[key])]


def check(source, state_dir, save, current=None):
    path = state_dir / (source['id'] + '.json')
    previous = json.loads(path.read_text()) if path.exists() else None
    current = fetch(source) if current is None else current
    same_source = previous is not None and previous['source'] == source
    if same_source and previous['records'] and current and not (previous['records'].keys() & current.keys()):
        raise ValueError('No overlap with previous listing; possible coverage gap. Expand/paginate before advancing')
    changes = delta(previous['records'], current) if same_source else []
    status = 'BASELINE' if not same_source else ('CHANGED' if changes else 'unchanged')
    # A failed fetch/parse never replaces a successful baseline. Rollover out of
    # a bounded API listing is not interpreted as issue closure or patch removal.
    if save:
        # Queue content before advancing the baseline. A crash between the two
        # writes is safe: retrying deduplicates the event instead of losing it.
        events = list(changes) if same_source else [('baseline', 'baseline')]
        if same_source and not previous.get('inbox_initialized'):
            events.insert(0, ('baseline', 'baseline'))
        for key, action in events:
            before = previous['records'].get(key) if same_source and action != 'baseline' else None
            after = current[key] if action != 'baseline' else current
            prior_observation = previous.get('observed_at') if same_source and action != 'baseline' else None
            event_id = digest([source, key, prior_observation, before, after])
            event_path = state_dir / 'inbox' / (event_id + '.json')
            if not event_path.exists():
                write_json(event_path, {'id': event_id, 'source': source, 'entry': key,
                                       'action': action, 'before': before, 'after': after,
                                       'observed_at': datetime.now(timezone.utc).isoformat(),
                                       'decision': 'pending', 'reviews': []})
        snapshot = {'source': source, 'inbox_initialized': True,
                    'observed_at': datetime.now(timezone.utc).isoformat(),
                    'records': current}
        write_json(path, snapshot)
    lines = [f"{status}: {source['label']} ({len(current)} entries)"]
    shown = changes[:8]
    if status == 'BASELINE':
        shown = [(key, 'current') for key in list(current)[:3]]
    for key, action in shown:
        item = current[key]
        title = ' '.join(item['title'].split())
        detail = f" [{item['status']}]" if 'status' in item else ''
        lines.append(f"  {action}: {title}{detail}\n    {item['html_url']}")
    if len(changes) > len(shown):
        lines.append(f"  {len(changes) - len(shown)} more; review {source['url']}")
    return '\n'.join(lines)


def inbox_report(state_dir):
    lines = ['Review queue (observing a change does not clear it):']
    today = datetime.now(timezone.utc).date().isoformat()
    for path in sorted((state_dir / 'inbox').glob('*.json')):
        event = json.loads(path.read_text())
        if event['decision'] == 'ignore':
            continue
        title = event['source']['label'] if event['action'] == 'baseline' else event['after']['title']
        detail = event['decision']
        if event.get('revisit_on') and event['revisit_on'] <= today:
            detail += ', REVIEW DUE'
        lines.append(f"  {event['id']} [{detail}] {' '.join(title.split())}")
    if len(lines) == 1:
        lines.append('  No outstanding entries.')
    return '\n'.join(lines)


def review(args):
    if not re.fullmatch(r'[a-f0-9]{64}', args.review):
        raise ValueError('Use the complete event ID from the review queue')
    if not args.decision or not args.note or not args.reviewer:
        raise ValueError('Review requires --decision, --note and --reviewer')
    if args.decision in ('defer', 'watch') and not args.revisit_on:
        raise ValueError('Deferred/watched entries require --revisit-on YYYY-MM-DD')
    if args.revisit_on:
        datetime.strptime(args.revisit_on, '%Y-%m-%d')
    if args.decision == 'candidate' and not args.evidence:
        raise ValueError('Candidate decisions require --evidence pointing to an adoption record')
    path = args.state_dir / 'inbox' / (args.review + '.json')
    event = json.loads(path.read_text())
    decision = {key: getattr(args, key) for key in
                ('decision', 'note', 'reviewer', 'revisit_on', 'evidence')}
    decision['reviewed_at'] = datetime.now(timezone.utc).isoformat()
    event.update(decision)
    event['reviews'].append(decision)
    write_json(path, event)
    return 'Recorded review. ' + inbox_report(args.state_dir)


def health(args):
    sources = json.loads(args.sources.read_text())
    receipt = json.loads((args.state_dir / 'last-run.json').read_text())
    if not receipt['success']:
        raise ValueError('The last check failed; inspect last-run.json')
    now = datetime.now(timezone.utc)
    for source in sources:
        snapshot = json.loads((args.state_dir / (source['id'] + '.json')).read_text())
        if snapshot['source'] != source:
            raise ValueError('Source configuration changed: ' + source['id'])
        age = (now - datetime.fromisoformat(snapshot['observed_at'])).total_seconds() / 86400
        if age > args.max_age_days:
            raise ValueError(f"Stale source: {source['id']} ({age:.1f} days)")
    print(f"Healthy: all {len(sources)} sources checked within {args.max_age_days} days.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, default=ROOT / 'docs/upstream-watch-sources.json')
    parser.add_argument('--state-dir', type=Path, default=ROOT / 'artifacts/upstream-watch')
    parser.add_argument('--no-save', action='store_true', help='Compare without advancing observation baselines')
    parser.add_argument('--review', help='Record a decision for an existing review-queue event')
    parser.add_argument('--decision', choices=('ignore', 'watch', 'defer', 'candidate'))
    parser.add_argument('--note')
    parser.add_argument('--reviewer')
    parser.add_argument('--revisit-on')
    parser.add_argument('--evidence')
    parser.add_argument('--health', action='store_true', help='Fail on missing, failed or stale observations')
    parser.add_argument('--max-age-days', type=int, default=9)
    args = parser.parse_args()
    if args.review and (args.no_save or args.health):
        parser.error('--review cannot be combined with --no-save or --health')
    try:
        with locked(args.state_dir):
            return run(args)
    except (ValueError, OSError) as error:
        print('Upstream check failed: ' + str(error), file=sys.stderr)
        return 1


def run(args):
    if args.health:
        return health(args)
    if args.review:
        report = review(args) + '\n'
        (args.state_dir / 'latest.txt').write_text(report)
        print(report, end='')
        return 0
    sources = json.loads(args.sources.read_text())
    ids = [source['id'] for source in sources]
    if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[a-z0-9-]+', value) for value in ids):
        raise ValueError('Source IDs must be unique lowercase letters, digits, or hyphens')
    failed = False
    lines = [f"VRWatch upstream check {datetime.now(timezone.utc).isoformat()}",
             'Observation only; changed sources still need review and device validation.']
    receipt = {'attempted_at': datetime.now(timezone.utc).isoformat(), 'sources': {}}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(fetch, source) for source in sources]
        for source, future in zip(sources, futures):
            try:
                current = future.result()
                lines.append(check(source, args.state_dir, not args.no_save, current))
                receipt['sources'][source['id']] = {'success': True, 'entries': len(current)}
            except Exception as error:
                failed = True
                lines.append(f"ERROR: {source['label']}: {error}; prior baseline retained")
                receipt['sources'][source['id']] = {'success': False, 'error': str(error)}
    lines.append(inbox_report(args.state_dir))
    report = '\n\n'.join(lines) + '\n'
    print(report, end='')
    if not args.no_save:
        receipt['completed_at'] = datetime.now(timezone.utc).isoformat()
        receipt['success'] = not failed
        write_json(args.state_dir / 'last-run.json', receipt)
        name = datetime.now(timezone.utc).strftime('report-%Y%m%dT%H%M%S%fZ.txt')
        (args.state_dir / name).write_text(report)
        (args.state_dir / 'latest.txt').write_text(report)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
