#!/usr/bin/env python3
"""Freeze baseline + candidate patch inputs without preparing or building Chromium."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def freeze(output):
    if output.exists():
        raise ValueError('Use a new immutable candidate input directory')
    output.mkdir(parents=True)
    patches = output / 'patches'
    patches.mkdir()
    sources = sorted((REPO / 'frame/runtime-patches').glob('*.patch')) + sorted((REPO / 'frame/next-runtime-patches').glob('*.patch'))
    provenance = {}
    for index, source in enumerate(sources, 1):
        name = f'{index:04d}-' + source.name.split('-', 1)[1]
        shutil.copy2(source, patches / name)
        provenance[name] = {'source': str(source.relative_to(REPO)), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}
    for name in ('runtime-args.gn', 'runtime-root.gn'):
        shutil.copy2(REPO / 'frame' / name, output / name)
    (output / 'inputs.json').write_text(json.dumps({'revision': '1cd9d5e8a79498099345785815a507f5d6e6811a',
        'bridgeProtocol': 1, 'patches': provenance,
        'configuration': {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in ('runtime-args.gn', 'runtime-root.gn')}}, indent=2) + '\n')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(freeze(args.output.resolve()))
