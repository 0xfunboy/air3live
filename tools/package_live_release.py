#!/usr/bin/env python3
"""Validate and package #AIR3 Live 3.0 without repositories or local credentials.

Use --validate-only to inspect the release gates without writing any artifact.
Use --self-test for a small isolated gate/exclusion/integrity test fixture.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SERVICE = 'studio-broadcast'
QA = 'docs/validation/live-3.0'
ARCHIVE_ROOT = 'AIR3_Live_Standalone'
DEFAULT_NAME = 'AIR3_Live_Standalone_3.0_2026-10-27.zip'
BUILD_PATH = f'{SERVICE}/public/build/manifest.json'
REPORTS = {
    'system': f'{QA}/system-qa-report.json',
    'compiledLive': f'{QA}/compiled-live/report.json',
    'gltf': f'{QA}/imported-assets-validator.json',
    'rtmpLoopback': f'{QA}/rtmp-loopback.json',
}
SHA = re.compile(r'^[0-9a-f]{64}$')
OMIT_DIRS = {
    'node_modules', '.cache', '__pycache__', 'recordings', 'temp', 'tmp',
    'backup', 'backups', 'asset-backups', '.release', '.qa', 'patches',
}
# Runtime state is location-specific: textures/data contains required maps.
OMIT_STATE_PATHS = {('data',), (SERVICE, 'data')}
OMIT_FILES = {
    '.browser-path', '.ds_store', 'thumbs.db', 'desktop.ini', '.npmrc', '.netrc',
    '.pypirc', 'credentials.json', 'live-settings.json', 'live-session.log',
    'tools/package_release.py', 'tools/verify_repository_preservation.py',
}
ALLOWED_DOT_FILES = {'.env.example', '.env.sample', '.env.template', '.gitignore',
                     '.dockerignore', '.gitattributes', '.editorconfig', '.nvmrc'}
OMIT_SUFFIXES = {'.tmp', '.temp', '.bak', '.old', '.orig', '.pyc', '.pyo', '.swp',
                 '.swo', '.sqlite', '.sqlite3', '.db', '.pid', '.pem', '.key', '.p12',
                 '.pfx', '.kdbx', '.mkv', '.mp4', '.webm', '.mov', '.avi'}
SOURCE_ARCHIVES = {'.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz'}
UI_CAPTURE_MARKERS = ('browser-ui', 'browser-screenshot', 'ui-screenshot',
                      'operator-screenshot', 'control-screenshot', 'screenshot-control')
REQUIRED_GLTF_IDS = {'avatar', 'hair-wavy', 'hair-artemis', 'footwear-boot',
                     'footwear-shoes-test', 'clothing-crop'}


class GateFailure(RuntimeError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__('; '.join(errors))


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def relative_path(raw: object) -> PurePosixPath:
    if not isinstance(raw, str) or not raw or '\\' in raw or ':' in raw or any(ord(c) < 32 for c in raw):
        raise ValueError('invalid relative path')
    path = PurePosixPath(raw)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != raw:
        raise ValueError('non-canonical relative path')
    return path


def owned_file(root: Path, raw: object) -> Path:
    rel = relative_path(raw)
    path = root
    for part in rel.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError('symlink is not a release input')
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('file is missing or outside the release')
    return path


def exclusion_reason(rel: PurePosixPath, is_dir: bool = False) -> str | None:
    parts = rel.parts
    directories = parts if is_dir else parts[:-1]
    lowered_directories = tuple(part.casefold() for part in directories)
    if any(lowered_directories[:len(path)] == path for path in OMIT_STATE_PATHS):
        return 'local runtime state'
    for part in directories:
        lower = part.casefold()
        if lower.startswith('airewardrop'):
            return 'external repository'
        if lower in OMIT_DIRS or lower.startswith('.'):
            return 'local state, dependencies or historical integration'
        if lower.endswith(('.bak', '.old', '.backup')):
            return 'backup directory'
    if is_dir:
        return None
    name = rel.name.casefold()
    if rel.as_posix().casefold() in OMIT_FILES or name in OMIT_FILES:
        return 'local configuration or historical tool'
    if name.startswith('.') and name not in ALLOWED_DOT_FILES:
        return 'private/local dot file'
    if name.startswith('.env') and name not in ALLOWED_DOT_FILES:
        return 'local environment'
    if name.endswith(('~', '.sqlite-wal', '.sqlite-shm', '.sqlite3-wal', '.sqlite3-shm', '.db-wal', '.db-shm', '.receipt.json')):
        return 'local state or previous package receipt'
    suffix = rel.suffix.casefold()
    if suffix in OMIT_SUFFIXES:
        return 'temporary file, credential container or recording'
    if suffix in SOURCE_ARCHIVES and (not parts or parts[0] != 'source-assets' or name.startswith('airewardrop')):
        return 'nested release or external repository archive'
    if any(marker in name for marker in UI_CAPTURE_MARKERS):
        return 'browser interface capture'
    return None


def inventory(root: Path, ignored: set[Path] | None = None) -> list[Path]:
    ignored = {p.absolute() for p in (ignored or set())}
    files: list[Path] = []
    for base, dirs, names in os.walk(root, followlinks=False):
        parent = Path(base)
        kept = []
        for name in sorted(dirs):
            path = parent / name
            if exclusion_reason(PurePosixPath(path.relative_to(root).as_posix()), True):
                continue
            if path.is_symlink():
                raise GateFailure(['Unexpected directory symlink: ' + path.relative_to(root).as_posix()])
            kept.append(name)
        dirs[:] = kept
        for name in sorted(names):
            path = parent / name
            if path.absolute() in ignored or name == 'SHA256SUMS':
                continue
            rel = PurePosixPath(path.relative_to(root).as_posix())
            if exclusion_reason(rel):
                continue
            try:
                relative_path(rel.as_posix())
                if path.is_symlink() or not path.is_file():
                    raise ValueError('not a regular file')
            except ValueError:
                raise GateFailure(['Unsupported release entry: ' + rel.as_posix()]) from None
            files.append(path)
    files.sort(key=lambda p: p.relative_to(root).as_posix())
    folded: dict[str, str] = {}
    for path in files:
        rel = path.relative_to(root).as_posix()
        if rel.casefold() in folded:
            raise GateFailure(['Case-insensitive archive path collision: ' + rel])
        folded[rel.casefold()] = rel
    return files


def release_inventory(root: Path, verified: dict, ignored: set[Path] | None = None) -> list[Path]:
    """The same exclusion gate is used by read-only validation and packaging."""
    files = inventory(root, ignored)
    included = {path.relative_to(root).as_posix() for path in files}
    required = {BUILD_PATH, 'package.json', f'{SERVICE}/package.json', f'{SERVICE}/package-lock.json'}
    required.update(item['path'] for item in verified['evidence'].values())
    for group in ['inputs', 'outputs', 'assets']:
        required.update(f'{SERVICE}/{path}' for path in verified['identity'][group])
    missing = required - included
    if missing:
        raise GateFailure(['Required release file would be excluded: ' + path for path in sorted(missing)])
    return files


def read_json(root: Path, name: str, errors: list[str]) -> dict | None:
    try:
        path = owned_file(root, name)
        if path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError('report too large')
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError('expected object')
        return value
    except (OSError, ValueError, json.JSONDecodeError):
        errors.append('Missing or invalid JSON: ' + name)
        return None


def records(value: object, label: str, errors: list[str]) -> dict[str, str]:
    if not isinstance(value, list) or not value:
        errors.append('Missing nonempty record set: ' + label)
        return {}
    result: dict[str, str] = {}
    for row in value:
        try:
            if not isinstance(row, dict):
                raise ValueError('not an object')
            path = relative_path(row.get('path')).as_posix()
            digest = row.get('sha256')
            if not isinstance(digest, str) or not SHA.fullmatch(digest) or path in result:
                raise ValueError('invalid or duplicate digest record')
            if 'bytes' in row and (type(row['bytes']) is not int or row['bytes'] < 0):
                raise ValueError('invalid byte count')
            result[path] = digest
        except ValueError:
            errors.append('Invalid hash record in ' + label)
    return result


def build_identity(value: object, label: str, errors: list[str]) -> dict:
    if not isinstance(value, dict) or value.get('schema') != 'air3.frontend-build.v1':
        errors.append('Missing/unsupported frontend build: ' + label)
        return {}
    return {group: records(value.get(group), f'{label}.{group}', errors) for group in ['inputs', 'outputs', 'assets']}


def assert_file_digest(root: Path, path: str, expected: str, errors: list[str], bytes_expected: int | None = None) -> None:
    try:
        file = owned_file(root, path)
        if sha256(file) != expected or (bytes_expected is not None and file.stat().st_size != bytes_expected):
            errors.append('File changed since validation: ' + path)
    except (OSError, ValueError):
        errors.append('Missing/unsafe validated file: ' + path)


def validate(root: Path) -> dict:
    """Read-only gates. No manifest, checksum, directory or archive is written."""
    errors: list[str] = []
    package = read_json(root, 'package.json', errors)
    service = read_json(root, f'{SERVICE}/package.json', errors)
    lock = read_json(root, f'{SERVICE}/package-lock.json', errors)
    if package and package.get('version') != '3.0.0':
        errors.append('Root version must be 3.0.0')
    if service and service.get('version') != '1.0.0':
        errors.append('Service version must be 1.0.0')
    if lock and (lock.get('version') != '1.0.0' or lock.get('packages', {}).get('', {}).get('version') != '1.0.0'):
        errors.append('Service lockfile version must match 1.0.0')

    reports = {key: read_json(root, path, errors) for key, path in REPORTS.items()}
    build = read_json(root, BUILD_PATH, errors)
    identity = build_identity(build, 'delivered build', errors)
    if build:
        for group in ['inputs', 'outputs', 'assets']:
            for row in build.get(group, []) if isinstance(build.get(group), list) else []:
                if not isinstance(row, dict) or row.get('path') not in identity.get(group, {}):
                    continue
                assert_file_digest(root, f'{SERVICE}/' + row['path'], row['sha256'], errors, row.get('bytes'))
        # A new/removed file omitted from an old manifest is also build drift.
        for relative, group, ignored in [('public/assets/air3', 'assets', set()), ('public/build', 'outputs', {'manifest.json'})]:
            folder = root / SERVICE / relative
            # build.mjs deliberately ignores editor/transfer dotfiles and
            # dot-directories; they are not runtime inventory additions.
            actual = {p.relative_to(root / SERVICE).as_posix() for p in folder.rglob('*')
                      if p.is_file() and p.name not in ignored
                      and not any(part.startswith('.') for part in p.relative_to(folder).parts)}
            if actual != set(identity.get(group, {})):
                errors.append('Build inventory changed: ' + relative)

    system = reports['system']
    if system:
        tests, syntax, compilation = system.get('tests', {}), system.get('syntax', {}), system.get('build', {})
        if system.get('passed') is not True:
            errors.append('System QA did not pass')
        # export-qa-logs.mjs records a pass count, not a boolean. Accept either
        # explicit boolean format or that measured TAP format, never truthiness.
        passed = tests.get('passed')
        if passed is True:
            tests_ok = tests.get('exitCode', 0) == 0 and tests.get('failed', 0) == 0
        else:
            total, skipped = tests.get('tests'), tests.get('skipped', 0)
            tests_ok = (type(passed) is int and type(total) is int and type(skipped) is int and total > 0 and passed > 0
                        and skipped >= 0 and passed + skipped == total and tests.get('failed') == 0 and tests.get('exitCode') == 0)
        if not tests_ok:
            errors.append('Tests must pass with zero failures and consistent measured counts')
        if syntax.get('passed') is False or syntax.get('exitCode') != 0 or type(syntax.get('modules')) is not int or syntax['modules'] <= 0:
            errors.append('Syntax check must pass and include checked modules')
        if compilation.get('exitCode') != 0:
            errors.append('Build command did not pass')
        tested = build_identity(system.get('frontendBuild'), 'system QA', errors)
        if tested != identity:
            errors.append('System QA does not identify the delivered frontend input/output/asset set')
        for check in system.get('postSuiteChecks', []):
            if not isinstance(check, dict) or check.get('exitCode') != 0 or not isinstance(check.get('sha256'), str):
                errors.append('Invalid post-suite source check')
                continue
            assert_file_digest(root, check.get('path', ''), check['sha256'], errors)
        for filename in ['studio-tests.txt', 'check-results.txt', 'build-results.txt']:
            try:
                owned_file(root, f'{QA}/{filename}')
            except ValueError:
                errors.append('Missing QA log: ' + filename)

    compiled = reports['compiledLive']
    if compiled:
        if compiled.get('passed') is not True or compiled.get('errors') or compiled.get('httpErrors'):
            errors.append('Compiled live/end-to-end QA did not pass cleanly')
        tested = build_identity(compiled.get('build'), 'compiled live QA', errors)
        for group in ['outputs', 'assets']:
            if tested.get(group) != identity.get(group):
                errors.append('Compiled live QA does not identify delivered ' + group)

    gltf = reports['gltf']
    if gltf:
        assets = gltf.get('assets')
        if gltf.get('passed') is not True or gltf.get('totalErrors') != 0 or not isinstance(assets, list) or not assets:
            errors.append('glTF validation must pass with zero errors and asset records')
            assets = []
        if not REQUIRED_GLTF_IDS.issubset({a.get('id') for a in assets if isinstance(a, dict)}):
            errors.append('glTF report is missing avatar, hair, footwear or crop-top validation')
        seen = set()
        for asset in assets:
            if not isinstance(asset, dict) or asset.get('errors') != 0 or asset.get('exitCode', 0) != 0:
                errors.append('An imported glTF asset failed validation')
                continue
            path, digest = asset.get('path'), asset.get('sha256')
            if not isinstance(path, str) or not isinstance(digest, str) or not SHA.fullmatch(digest) or path in seen:
                errors.append('Invalid imported glTF identity')
                continue
            seen.add(path)
            assert_file_digest(root, path, digest, errors, asset.get('bytes'))
        if sum(a.get('errors', 0) for a in assets if isinstance(a, dict)) != 0:
            errors.append('glTF error totals are inconsistent')

    rtmp = reports['rtmpLoopback']
    if rtmp:
        if rtmp.get('passed') is not True:
            errors.append('Local RTMP loopback QA did not pass')
        # Some transport probes contain a frontend identity; when present it
        # must match. A test-pattern/transport-only probe makes no such claim.
        captured_build = rtmp.get('frontendBuild') or rtmp.get('build')
        if captured_build:
            tested = build_identity(captured_build, 'RTMP QA', errors)
            for group in ['outputs', 'assets']:
                if tested.get(group) != identity.get(group):
                    errors.append('RTMP QA does not identify delivered ' + group)

    if errors:
        raise GateFailure(list(dict.fromkeys(errors)))
    return {'reports': reports, 'build': build, 'identity': identity, 'buildManifestSha256': sha256(root / BUILD_PATH),
            'evidence': {key: {'path': path, 'sha256': sha256(root / path)} for key, path in REPORTS.items()},
            'versions': {'project': package['version'], 'service': service['version']}}


def release_manifest(verified: dict) -> dict:
    system = verified['reports']['system']
    gltf = verified['reports']['gltf']
    return {
        'schema': 'air3.live-release.v1', 'version': '3.0.0', 'serviceVersion': '1.0.0',
        'createdAt': datetime.now(timezone.utc).isoformat(), 'root': ARCHIVE_ROOT,
        'product': '#AIR3 Live Standalone',
        'scope': 'Independent control room, headless audio/video renderer, Restream/Twitch/custom RTMP(S) output, optional Twitch chat, editorial titles and ticker APIs, native wallpanel and market heatmap; fitted white off-shoulder default and corrected talking shoulder posture. dApp and Eliza remain optional API producers.',
        'checks': {'tests': system['tests'], 'syntax': system['syntax'], 'frontendHashesFresh': True,
                   'compiledLive': True, 'localRtmpLoopback': True, 'gltfErrors': gltf['totalErrors'],
                   'gltfWarnings': gltf.get('totalWarnings'), 'validatedImportedAssets': len(gltf['assets'])},
        'evidence': verified['evidence'],
        'frontendBuild': {'manifest': BUILD_PATH, 'sha256': verified['buildManifestSha256'],
                          'builtAt': verified['build'].get('builtAt'), 'outputs': verified['build']['outputs'], 'assets': verified['build']['assets']},
        'externalServicesTested': False, 'targetGpuBenchmarked': False,
        'notCertified': ['Unreal visual parity', 'Target NVIDIA/NVENC or Intel/QuickSync throughput',
                         'Sustained 1080p30/60 on the target host', '24/7 operation',
                         'Restream/Twitch publication with real channel credentials', 'Real-account Twitch OAuth/chat',
                         'External TTS inference', 'Entitled CoinGlass live data', 'Binance availability from the target network'],
        'runtimePrerequisites': ['Node.js >=24 and npm ci --prefix studio-broadcast',
                                 'Chrome for Testing and FFmpeg for headless capture',
                                 'Configured streaming endpoint and key for publication',
                                 'Reachable TTS API for generated narration; market source access for live market data'],
        'omitted': ['dApp and Eliza repositories', 'Historical integration patches and obsolete unified-package tools',
                    'Credentials, local environment/state, recordings and credential containers',
                    'Installed npm dependencies, downloaded browser and caches',
                    'Browser-interface captures and temporary/backup files'],
        'included': ['Current standalone source and compiled frontend', 'Runtime assets, original source assets and licenses',
                     'Versioned documentation, test logs and permitted canvas evidence', 'SHA256SUMS for all included files except itself'],
    }


def write_json_atomic(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def package(root: Path, output: Path, verified: dict) -> dict:
    root, output = root.resolve(), output.absolute()
    if output.suffix.casefold() != '.zip' or output.is_relative_to(root / SERVICE / 'public'):
        raise GateFailure(['Output must be a ZIP outside the public runtime directory'])
    if output.is_symlink() or any(p.is_symlink() for p in output.parents if p.exists()):
        raise GateFailure(['Output cannot traverse a symlink'])
    manifest = release_manifest(verified)
    write_json_atomic(root / 'RELEASE_MANIFEST.json', manifest)
    temporary = output.with_name(output.name + '.part')
    receipt_file = output.with_suffix('.zip.receipt.json')
    files = release_inventory(root, verified, {output, temporary, receipt_file})
    digests = {p.relative_to(root).as_posix(): sha256(p) for p in files}
    # Bind the archive bytes to the files that passed validation, not merely
    # to a second hash observed after validation while an editor may be active.
    validated_digests = {BUILD_PATH: verified['buildManifestSha256']}
    for group in ['inputs', 'outputs', 'assets']:
        validated_digests.update({f'{SERVICE}/{path}': digest for path, digest in verified['identity'][group].items()})
    validated_digests.update({item['path']: item['sha256'] for item in verified['evidence'].values()})
    drift = [path for path, expected in validated_digests.items() if digests.get(path) != expected]
    if drift:
        raise GateFailure(['Validated file changed before packaging: ' + path for path in sorted(drift)])
    checksum = root / 'SHA256SUMS'
    checksum.write_text(''.join(f'{digests[p.relative_to(root).as_posix()]}  {p.relative_to(root).as_posix()}\n' for p in files), encoding='utf-8')
    files.append(checksum); digests['SHA256SUMS'] = sha256(checksum)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for path in files:
                relative = path.relative_to(root).as_posix()
                info = zipfile.ZipInfo.from_file(path, f'{ARCHIVE_ROOT}/{relative}', strict_timestamps=False)
                info.compress_type = zipfile.ZIP_DEFLATED
                digest = hashlib.sha256()
                with path.open('rb') as source, archive.open(info, 'w', force_zip64=True) as target:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(block); target.write(block)
                if digest.hexdigest() != digests[relative]:
                    raise GateFailure(['File changed while packaging: ' + relative])
        with zipfile.ZipFile(temporary) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or len(names) != len({n.casefold() for n in names}):
                raise GateFailure(['Duplicate archive entry'])
            bad = archive.testzip()
            if bad:
                raise GateFailure(['ZIP CRC failed: ' + bad])
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    result = {'schema': 'air3.live-release-receipt.v1', 'version': '3.0.0', 'file': str(output),
              'files': len(files), 'bytes': output.stat().st_size, 'uncompressedBytes': sum(p.stat().st_size for p in files),
              'sha256': sha256(output), 'crcPassed': True, 'uniquePaths': True,
              'externalServicesTested': False, 'targetGpuBenchmarked': False}
    write_json_atomic(receipt_file, result)
    return result


def self_test() -> dict:
    """Small fixture only: verifies gates and actual ZIP exclusion/integrity."""
    with tempfile.TemporaryDirectory(prefix='air3-release-gates-') as directory:
        root = Path(directory)
        def put(path: str, value: object) -> None:
            file = root / path; file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(json.dumps(value) if isinstance(value, (dict, list)) else str(value), encoding='utf-8')
        def record(path: str) -> dict:
            file = root / SERVICE / path
            return {'path': path, 'sha256': sha256(file), 'bytes': file.stat().st_size}
        def validate_only_result() -> tuple[int, dict]:
            captured = io.StringIO()
            before = {p.relative_to(root).as_posix(): sha256(p) for p in root.rglob('*') if p.is_file()}
            with redirect_stdout(captured):
                exit_code = main(['--validate-only'], root=root)
            after = {p.relative_to(root).as_posix(): sha256(p) for p in root.rglob('*') if p.is_file()}
            assert before == after, '--validate-only changed a fixture file'
            return exit_code, json.loads(captured.getvalue())
        put('package.json', {'version': '3.0.0'})
        put(f'{SERVICE}/package.json', {'version': '1.0.0'})
        put(f'{SERVICE}/package-lock.json', {'version': '1.0.0', 'packages': {'': {'version': '1.0.0'}}})
        put(f'{SERVICE}/public/app.mjs', 'export const fixture = true;')
        put(f'{SERVICE}/public/build/app.js', 'console.log("fixture");')
        imported = []
        for identifier in sorted(REQUIRED_GLTF_IDS):
            path = f'public/assets/air3/{identifier}.glb'
            put(f'{SERVICE}/{path}', 'fixture, not an actual model')
            imported.append({'id': identifier, 'path': f'{SERVICE}/{path}', 'sha256': sha256(root / SERVICE / path), 'errors': 0, 'warnings': 0, 'exitCode': 0})
        put(f'{SERVICE}/public/assets/air3/branding/airewardrop-lockup.svg', '<svg/>')
        data_texture = 'public/assets/air3/textures/data/face-normal.png'
        put(f'{SERVICE}/{data_texture}', 'Fixture normal map; data is an asset directory')
        assets = [record(p.relative_to(root / SERVICE).as_posix()) for p in sorted((root / SERVICE / 'public/assets/air3').rglob('*')) if p.is_file()]
        build = {'schema': 'air3.frontend-build.v1', 'inputs': [record('public/app.mjs')], 'outputs': [record('public/build/app.js')], 'assets': assets}
        def put_build_evidence() -> None:
            put(BUILD_PATH, build)
            put(REPORTS['system'], {'passed': True, 'tests': {'tests': 1, 'passed': 1, 'failed': 0, 'skipped': 0, 'exitCode': 0},
                                  'syntax': {'exitCode': 0, 'modules': 1}, 'build': {'exitCode': 0}, 'frontendBuild': build})
            put(REPORTS['compiledLive'], {'passed': True, 'errors': [], 'httpErrors': [], 'build': build})
        put_build_evidence()
        put(REPORTS['gltf'], {'passed': True, 'totalErrors': 0, 'totalWarnings': 0, 'assets': imported})
        put(REPORTS['rtmpLoopback'], {'passed': True})
        for name in ['studio-tests.txt', 'check-results.txt', 'build-results.txt']:
            put(f'{QA}/{name}', 'Self-test fixture only, not project validation.')
        secret_paths = ['studio-broadcast/.env', 'studio-broadcast/.env.production', '.aws/credentials',
                        'studio-broadcast/.browser-path', 'studio-broadcast/data/live-settings.json',
                        'studio-broadcast/data/market-history.json', 'data/local-state.json',
                        'studio-broadcast/public/assets/air3/models/.model-upload.glb.tmp',
                        'studio-broadcast/node_modules/example/index.js', 'recordings/file.mkv', 'temp/file.txt',
                        'nested/airewardrop-dapp-main/package.json', 'nested/airewardrop-eliza-main/file.ts',
                        'patches/eliza-studio.patch', 'tools/package_release.py', 'tools/verify_repository_preservation.py',
                        'docs/validation/live-3.0/control-screenshot.png']
        for path in secret_paths:
            put(path, 'must not ship')
        put('studio-broadcast/.env.example', 'AIR3_PRODUCER_TOKEN=replace-me')
        put('source-assets/lookdev/hair/original.zip', 'Fixture original source archive')
        put('README.md', 'Package gate self-test fixture')
        code, result = validate_only_result()
        assert code == 0 and result['validated'] is True and result['written'] is False
        # Reproduce a build that accidentally inventories a temporary model.
        # Its hashes are valid, but both CLI validation and packaging must fail
        # because the protected-path filter would omit a declared runtime file.
        excluded_asset = 'public/assets/air3/models/model-backup.glb.bak'
        put(f'{SERVICE}/{excluded_asset}', 'Fixture temporary model')
        build['assets'].append(record(excluded_asset))
        put_build_evidence()
        excluded_verified = validate(root)
        code, result = validate_only_result()
        assert code == 1 and any('Required release file would be excluded' in e and excluded_asset in e for e in result['errors'])
        try:
            package(root, root / '.release' / 'excluded-runtime.zip', excluded_verified)
        except GateFailure as error:
            assert any('Required release file would be excluded' in e and excluded_asset in e for e in error.errors)
            assert not (root / '.release' / 'excluded-runtime.zip').exists()
        else:
            raise AssertionError('An excluded required asset was accepted by packaging')
        (root / SERVICE / excluded_asset).unlink()
        build['assets'].pop()
        put_build_evidence()
        verified = validate(root)
        put(f'{SERVICE}/public/app.mjs', 'changed after build')
        try:
            validate(root)
        except GateFailure as error:
            assert any('File changed since validation' in e for e in error.errors)
        else:
            raise AssertionError('Build drift was accepted')
        try:
            package(root, root / '.release' / 'must-not-exist.zip', verified)
        except GateFailure as error:
            assert any('Validated file changed before packaging' in e for e in error.errors)
            assert not (root / '.release' / 'must-not-exist.zip').exists()
        else:
            raise AssertionError('Mutation between validation and packaging was accepted')
        put(f'{SERVICE}/public/app.mjs', 'export const fixture = true;')
        output = root / '.release' / 'fixture.zip'
        receipt = package(root, output, validate(root))
        with zipfile.ZipFile(output) as archive:
            names = {n.removeprefix(ARCHIVE_ROOT + '/') for n in archive.namelist()}
            assert not names.intersection(secret_paths)
            for path in ['studio-broadcast/.env.example', f'{SERVICE}/public/assets/air3/branding/airewardrop-lockup.svg',
                         f'{SERVICE}/{data_texture}', 'source-assets/lookdev/hair/original.zip', 'RELEASE_MANIFEST.json', 'SHA256SUMS']:
                assert path in names, path
            for line in archive.read(ARCHIVE_ROOT + '/SHA256SUMS').decode().splitlines():
                expected, name = line.split('  ', 1)
                assert hashlib.sha256(archive.read(ARCHIVE_ROOT + '/' + name)).hexdigest() == expected
            assert archive.testzip() is None
        return {'selfTestPassed': True, 'fixtureFiles': receipt['files'], 'buildDriftRejected': True, 'postValidationDriftRejected': True,
                'credentialAndRepositoryPathsExcluded': True, 'brandingAndSourceAssetsPreserved': True,
                'dataTexturesPreserved': True, 'runtimeStateExcluded': True, 'validateOnlyRejectsExcludedRuntime': True,
                'unlistedTemporaryDotfilesIgnored': True,
                'checksumsAndCrcPassed': True, 'projectArchiveCreated': False}


def main(argv: list[str] | None = None, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=root / '.release' / DEFAULT_NAME,
                        help='Absolute ZIP destination; defaults to .release/' + DEFAULT_NAME)
    parser.add_argument('--validate-only', action='store_true', help='Check gates without writing anything')
    parser.add_argument('--self-test', action='store_true', help='Run a tiny isolated packaging fixture; never packages the project')
    args = parser.parse_args(argv)
    try:
        if args.self_test:
            print(json.dumps(self_test(), ensure_ascii=False)); return 0
        if not args.output.is_absolute():
            raise GateFailure(['--output must be an absolute path'])
        verified = validate(root)
        if args.validate_only:
            files = release_inventory(root, verified, {args.output, args.output.with_name(args.output.name + '.part'), args.output.with_suffix('.zip.receipt.json')})
            print(json.dumps({'validated': True, 'version': '3.0.0', 'serviceVersion': '1.0.0', 'eligibleFiles': len(files),
                              'buildOutputs': len(verified['identity']['outputs']), 'runtimeAssets': len(verified['identity']['assets']),
                              'reports': list(REPORTS), 'written': False}, ensure_ascii=False)); return 0
        print(json.dumps(package(root, args.output, verified), ensure_ascii=False)); return 0
    except GateFailure as error:
        print(json.dumps({'validated': False, 'errors': error.errors[:24], 'errorCount': len(error.errors), 'archiveWritten': False}, ensure_ascii=False))
        return 1
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(json.dumps({'validated': False, 'error': type(error).__name__, 'archiveWritten': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
