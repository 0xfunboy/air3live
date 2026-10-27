#!/usr/bin/env python3
"""Rebuild the delivered runtime avatar from the two included source assets.
Run with Python 3 and NumPy installed. Paths resolve from this script, so the
working directory and operating system do not change the inputs.
"""
from pathlib import Path
import subprocess,sys,tempfile
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='air3-avatar-build-') as tmp:
 intermediate=Path(tmp)/'AIR3-retargeted.glb'
 subprocess.run([sys.executable,str(root/'tools/retarget_body_translations.py'),str(root/'source-assets/AIR3-runtime.before-quality.glb'),str(intermediate),'--report',str(root/'docs/validation/body-translation-retarget.json')],check=True)
 subprocess.run([sys.executable,str(root/'tools/add_facial_controls.py'),str(intermediate),str(root/'source-assets/AI_MetaHumanIdentity_FaceMesh.sparse.glb'),str(root/'studio-broadcast/public/assets/air3/metadata/air3-missing-metadata.json'),str(root/'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb'),'--report',str(root/'docs/validation/facial-subset-validation.json')],check=True)
