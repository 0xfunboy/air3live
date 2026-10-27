#!/usr/bin/env python3
"""Compare the supplied dApp/Eliza snapshots byte for byte with an earlier ZIP."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/validation/current/repository-preservation.json')
    args = parser.parse_args()
    report = {'schema': 'air3.repository-preservation.v1', 'generatedAt': datetime.now(timezone.utc).isoformat(),
              'comparison': 'SHA-256 per byte of every archive repository entry, plus added/missing file detection',
              'sourceArchive': {'filename': args.base.name, 'bytes': args.base.stat().st_size}, 'repositories': []}
    digest = hashlib.sha256()
    with args.base.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    report['sourceArchive']['sha256'] = digest.hexdigest()
    with zipfile.ZipFile(args.base) as archive:
        for repository in ['airewardrop-dapp-main', 'airewardrop-eliza-main']:
            prefix = 'AIR3_Studio_Complete/' + repository + '/'
            previous = {name[len(prefix):]: sha(archive.read(name)) for name in archive.namelist()
                        if name.startswith(prefix) and not name.endswith('/')}
            if not previous:
                raise ValueError('Repository absent from source archive: ' + repository)
            folder = ROOT / repository
            current = {path.relative_to(folder).as_posix(): sha(path.read_bytes()) for path in folder.rglob('*') if path.is_file()}
            missing, added = sorted(previous.keys() - current.keys()), sorted(current.keys() - previous.keys())
            modified = sorted(name for name in previous.keys() & current.keys() if previous[name] != current[name])
            tree = lambda rows: sha(''.join(value + '  ' + name + '\n' for name, value in sorted(rows.items())).encode())
            report['repositories'].append({'repository': repository, 'passed': not (missing or added or modified),
                'previousFiles': len(previous), 'currentFiles': len(current),
                'unchangedFiles': len(previous.keys() & current.keys()) - len(modified),
                'missing': missing, 'added': added, 'modified': modified,
                'previousTreeSha256': tree(previous), 'currentTreeSha256': tree(current),
                'files': [{'path': name, 'previousSha256': previous.get(name), 'currentSha256': current.get(name),
                           'unchanged': previous.get(name) == current.get(name)} for name in sorted(previous.keys() | current.keys())]})
    report['passed'] = all(row['passed'] for row in report['repositories'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'sourceArchive': report['sourceArchive'],
                      'repositories': [{key: value for key, value in row.items() if key != 'files'} for row in report['repositories']]}))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
