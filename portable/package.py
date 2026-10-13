#!/usr/bin/env python3
"""Package preserved dist. Requires macOS, Python 3 and Xcode Command Line Tools."""
from pathlib import Path
import argparse, hashlib, json, plistlib, shutil, subprocess, tempfile, tarfile, urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = '22.16.0'
ARCHIVE = f'node-v{VERSION}-darwin-arm64.tar.gz'
URL = f'https://nodejs.org/dist/v{VERSION}/'
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / 'release')
parser.add_argument('--runtime', type=Path, help='Existing extracted official Node distribution')
args = parser.parse_args()
out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
app = out / 'DSSC Layout Portable.app'
if app.exists(): raise SystemExit(f'Refusing to overwrite {app}')
manifest = json.loads((ROOT/'dist-manifest.json').read_text())
actual = {str(p.relative_to(ROOT/'dist')): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/'dist').rglob('*')) if p.is_file()}
if actual != manifest: raise SystemExit('dist differs from dist-manifest.json; review and regenerate the manifest first')
with tempfile.TemporaryDirectory(prefix='dssc-package-') as temp:
    temp = Path(temp)
    runtime = args.runtime.resolve() if args.runtime else None
    if runtime is None:
        archive = temp / ARCHIVE
        urllib.request.urlretrieve(URL + ARCHIVE, archive)
        expected = json.loads((ROOT/'portable/runtime.json').read_text())['sha256']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected: raise SystemExit('Runtime checksum mismatch')
        with tarfile.open(archive) as tar:
            tar.extractall(temp, filter='data')
        runtime = temp / f'node-v{VERSION}-darwin-arm64'
    expected_binary = json.loads((ROOT/'portable/runtime.json').read_text())['nodeSha256']
    if hashlib.sha256((runtime/'bin/node').read_bytes()).hexdigest() != expected_binary: raise SystemExit('Runtime binary mismatch')
    deps = subprocess.check_output(['/usr/bin/otool','-L',str(runtime/'bin/node')],text=True)
    for dep in deps.splitlines()[1:]:
        if not dep.strip().startswith(('/usr/lib/','/System/Library/')): raise SystemExit('Non-system dependency: '+dep)
    resources = app/'Contents/Resources'; macos = app/'Contents/MacOS'
    resources.mkdir(parents=True); macos.mkdir()
    shutil.copytree(ROOT/'dist',resources/'dist')
    (resources/'runtime').mkdir()
    shutil.copy2(runtime/'bin/node',resources/'runtime/node')
    shutil.copy2(runtime/'LICENSE',resources/'runtime/LICENSE')
    shutil.copy2(ROOT/'portable/launcher.mjs',resources/'launcher.mjs')
    for name in ['THIRD_PARTY_NOTICES.md','DEPENDENCY_LICENSES.txt','dist-manifest.json']:
        shutil.copy2(ROOT/name,resources/name)
    build = hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
    (resources/'identity.json').write_text(json.dumps({'app':'dssc-layout-portable-arm64','build':build}))
    subprocess.run(['/usr/bin/clang','-arch','arm64','-mmacosx-version-min=11.0','-fobjc-arc','-framework','Cocoa',str(ROOT/'portable/main.m'),'-o',str(macos/'DSSCLayout')],check=True)
    info = {'CFBundleExecutable':'DSSCLayout','CFBundleIdentifier':'org.dssc.layout.portable','CFBundleName':'DSSC Layout Portable','CFBundleDisplayName':'DSSC Layout Portable','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1.0','LSMinimumSystemVersion':'11.0','LSUIElement':True,'NSHighResolutionCapable':True}
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    for p in app.rglob('*'):
        p.chmod(0o755 if p.is_dir() or p.name in ['node','DSSCLayout'] else 0o644)
    subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(resources/'runtime/node')],check=True)
    subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(app)],check=True)
    subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)
print(app)
