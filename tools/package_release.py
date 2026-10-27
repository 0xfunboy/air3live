#!/usr/bin/env python3
"""Package the unified project, preserving sources and measured QA, excluding local state."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OMIT_DIRS = {'.git', 'node_modules', '.cache', '__pycache__', 'asset-backups', 'recordings', '.release', '.qa'}
OMIT_ROOT_QA = {'avatar-smoke.json', 'browser-smoke.json', 'system-qa-report.json', 'check-results.txt',
                 'studio-tests.txt', 'eliza-tests.txt', 'avatar-preview.png',
                 'user-feedback-front-proportions.png', 'user-feedback-side-proportions.png'}

def excluded(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in OMIT_DIRS for part in rel.parts):
        return True
    name = path.name
    if name == '.browser-path' or name == '.env' or (name.startswith('.env.') and name not in {'.env.example', '.env.sample', '.env.template'}):
        return True
    if path.suffix.lower() == '.zip' and rel.parts[:3] != ('source-assets', 'lookdev', 'hair'):
        return True
    if path.suffix.lower() in {'.tmp', '.pyc', '.mkv', '.mp4', '.sqlite', '.db'} or name.endswith(('.sqlite-wal', '.sqlite-shm')):
        return True
    if rel.parts[:2] == ('studio-broadcast', 'data'):
        return True
    # Unmodified copies of these imported files are preserved under docs/history/imported/.
    if rel.parent.as_posix() == 'docs/validation' and name in OMIT_ROOT_QA:
        return True
    # Use the clean framebuffer renders; this other image is an internal video-frame probe.
    if rel.as_posix() == 'docs/validation/current/avatar-smoke/avatar-preview.png':
        return True
    return False

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.release/AIR3_Studio_Refined_2.3_2026-10-25.zip')
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    qa = ROOT / 'docs/validation/current'
    reports = {name: json.loads((qa / filename).read_text()) for name, filename in {
        'system': 'system-qa-report.json', 'visual': 'compiled-visual-qa.json', 'capture': 'avatar-smoke/result.json'}.items()}
    for name, report in reports.items():
        if not report.get('passed'):
            raise RuntimeError('Current QA did not pass: ' + name)
    for check in reports['system'].get('postSuiteChecks', []):
        if check.get('exitCode') != 0 or digest(ROOT / check['path']) != check['sha256']:
            raise RuntimeError('Post-suite source check is stale: ' + check['path'])
    build = json.loads((ROOT / 'studio-broadcast/public/build/manifest.json').read_text())
    if reports['system'].get('frontendBuild') != build:
        raise RuntimeError('System QA did not build the delivered frontend')
    for record in build['inputs'] + build['outputs'] + build.get('assets', []):
        if digest(ROOT / 'studio-broadcast' / record['path']) != record['sha256']:
            raise RuntimeError('Frontend changed since the verified build: ' + record['path'])
    if [x['sha256'] for x in reports['visual']['build']['outputs']] != [x['sha256'] for x in build['outputs']]:
        raise RuntimeError('Visual QA did not execute the delivered bundle')
    if reports['visual']['build'].get('assets') != build.get('assets'):
        raise RuntimeError('Visual QA did not execute the delivered asset set')
    look = reports['visual'].get('preview', {}).get('lookdev', {})
    if not look.get('reloadPersisted') or not look.get('outfitReloadPersisted') or len(look.get('hair', [])) < 10 or len(look.get('shoes', [])) != 3 or len(look.get('mocap', [])) != 7:
        raise RuntimeError('Appearance, preset or mocap browser checks are missing')
    if {row['fit'] for row in look.get('bootFits', [])} != {'relaxed', 'low-cut'} or {row['style'] for row in look.get('clothing', [])} != {'original', 'crop'}:
        raise RuntimeError('Both shirt and boot-fit variants must be exercised in the compiled browser')
    for profile in reports['visual'].get('studio', []):
        if profile.get('corporateOverlayCount') != 1 or profile['ready'].get('branding') != {'corporateInScene': 1, 'projectInScene': 1, 'monitorLogos': 0}:
            raise RuntimeError('Branding placement was not verified in the compiled studio')
    capture_build = reports['capture'].get('frontendBuild', {})
    if [x['sha256'] for x in capture_build.get('outputs', [])] != [x['sha256'] for x in build['outputs']]:
        raise RuntimeError('Capture QA did not execute the delivered bundle')
    if capture_build.get('assets') != build.get('assets'):
        raise RuntimeError('Capture QA did not execute the delivered assets')
    for filename in ['camera-attention-report.json', 'stage-motion-report.json', 'motion-refinement-report.json']:
        report = json.loads((qa / filename).read_text())
        if not report.get('passed'):
            raise RuntimeError('Presence QA did not pass: ' + filename)
        for path, record in report.get('sources', {}).items():
            if digest(ROOT / 'studio-broadcast' / path) != record['sha256']:
                raise RuntimeError('Presence source changed since QA: ' + path)
    validation = json.loads((qa / 'avatar-gltf-validator.json').read_text())
    if validation['issues']['numErrors']:
        raise RuntimeError('Invalid avatar GLB')
    imported = json.loads((qa / 'imported-assets-validator.json').read_text())
    if not imported.get('passed') or imported.get('totalErrors') != 0 or len(imported.get('assets', [])) != 6:
        raise RuntimeError('Imported asset validation is missing or failed')
    for asset in imported['assets']:
        if asset['errors'] or digest(ROOT / asset['path']) != asset['sha256']:
            raise RuntimeError('Imported asset changed since validation: ' + asset['path'])
    preservation = json.loads((qa / 'repository-preservation.json').read_text())
    if not preservation.get('passed'):
        raise RuntimeError('Repository preservation check failed')
    for repository in preservation['repositories']:
        repository_root = ROOT / repository['repository']
        expected = {record['path']: record['currentSha256'] for record in repository['files']}
        current = {path.relative_to(repository_root).as_posix() for path in repository_root.rglob('*') if path.is_file()}
        if current != set(expected):
            raise RuntimeError('Repository file list changed since preservation check: ' + repository['repository'])
        for path, sha256 in expected.items():
            if digest(repository_root / path) != sha256:
                raise RuntimeError('Repository file changed: ' + repository['repository'] + '/' + path)
    release = {
        'schema': 'air3.refined-release.v4', 'version': '2.3.0', 'createdAt': datetime.now(timezone.utc).isoformat(),
        'root': 'AIR3_Studio_Complete', 'scope': 'Transparent AIR3/corporate branding with two corporate placements; happy expression at full preset intensity; Wavy espresso with linked brows and reinforced eye makeup; exact supplied lighting; preset v2; selectable supplied short shirt and two boot shaft fits; centered finite mocap turns, calibrated shoulders and continuous phase transitions. Camera presence, lipsync and headless broadcasting preserved. Supplied dApp/Eliza snapshots unchanged.',
        'checks': {'tests': reports['system']['tests'], 'syntax': reports['system']['syntax'],
                   'frontendBuild': True, 'compiledVisual': True, 'headlessAudioVideo': True, 'cameraAttention': True, 'recordedStageMotion': True,
                   'appearanceControls': True, 'clothingAndBootFitControls': True, 'brandingPlacement': True,
                   'motionRefinement60Hz': True, 'presetRoundtripAndPersistence': True, 'runtimeAssetHashes': True,
                   'gltfErrors': validation['issues']['numErrors'], 'gltfWarnings': validation['issues']['numWarnings'],
                   'importedAssets': len(imported['assets']), 'importedAssetErrors': imported['totalErrors'],
                   'importedAssetWarnings': imported['totalWarnings'], 'repositoriesPreserved': True},
        'avatar': {'file': 'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb',
                   'sha256': digest(ROOT / 'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb')},
        'runtimePrerequisites': ['Node.js >=24 and npm ci', 'Chrome for Testing and FFmpeg for capture', 'Configured external TTS and market source for live operation'],
        'notCertified': ['Unreal visual parity', 'Target-host NVIDIA/NVENC or Intel/QuickSync execution', '1080p30/60 sustained rendering', '24/7 soak', 'External TTS inference and live RTMP/RTSP ingest'],
        'omitted': ['Local credentials and databases', 'Installed npm modules and downloaded Chrome', 'Caches and temporary assets', 'Internal recordings', 'Duplicate historic QA files; originals preserved under docs/history/imported'],
        'recordingNote': 'Capture result/log and clean WebGL renders are included. The internal smoke recording is omitted; scripts reproduce it.'}
    (ROOT / 'RELEASE_MANIFEST.json').write_text(json.dumps(release, indent=2) + '\n')
    paths = []
    for path in sorted(ROOT.rglob('*')):
        if excluded(path) or path == output or path.name == 'SHA256SUMS':
            continue
        if path.is_symlink():
            raise RuntimeError('Unexpected symlink in release: ' + str(path.relative_to(ROOT)))
        if path.is_file():
            paths.append(path)
    sums = ''.join(digest(path) + '  ' + path.relative_to(ROOT).as_posix() + '\n' for path in paths)
    checksum_file = ROOT / 'SHA256SUMS'
    checksum_file.write_text(sums)
    paths.append(checksum_file)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path in paths:
            archive.write(path, 'AIR3_Studio_Complete/' + path.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(output) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError('Archive CRC failed: ' + bad)
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise RuntimeError('Duplicate archive names')
    summary = {'file': str(output), 'files': len(paths), 'bytes': output.stat().st_size,
               'uncompressedBytes': sum(path.stat().st_size for path in paths), 'sha256': digest(output), 'crcPassed': True}
    output.with_suffix('.zip.receipt.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))

if __name__ == '__main__':
    main()
