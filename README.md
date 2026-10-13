# DSSC Layout Designer

Browser-based DSSC layout design, preview and manufacturing-file export.

## Download: macOS Apple Silicon

Download **DSSC-Layout-Portable-macOS-arm64-0.1.0.zip** from this repository's [Releases](https://github.com/weiweiweiopen/dssc-layout-designer/releases), unzip it, and double-click **DSSC Layout Portable.app**. You may move the app to Applications or another folder, including paths with spaces. No Node.js installation, npm, terminal command or global package installation is required for users.

- **Apple Silicon (arm64) only; macOS 11 or later.** Intel is not supported by this download. Minimum OS is the runtime/launcher target; older macOS versions have not been separately tested.
- The app starts a bundled local server and opens your default browser at `http://127.0.0.1:18763`. It binds only to loopback, not your LAN. It does not use or stop an existing service on port 5173.
- Launching again reuses the same build's running service. If another service/build occupies 18763, an error is shown; nothing is killed. Close the conflicting service before trying again.
- Browser settings are stored per browser and origin. Settings from a 5173 development version do not automatically migrate. Export/download files before switching versions if needed.
- Closing the browser does not stop the local server. It exits at logout/restart; to stop it sooner, use Activity Monitor to identify the `node` process whose open files belong to **DSSC Layout Portable.app**, and quit only that process. Stop it before replacing/removing the app.
- Diagnostic logs are in `~/Library/Logs/DSSC Layout Portable/`.

### First launch / Gatekeeper

This build is **ad-hoc signed, not Developer ID signed or notarized**. macOS may block an internet download on first launch. After trying to open it, use **System Settings → Privacy & Security → Open Anyway** (or the equivalent Security & Privacy panel on older macOS), review the normal macOS prompt and approve only if you trust the download. Managed Macs may prohibit this. Do not disable Gatekeeper or remove quarantine attributes. Organization approval may be needed on managed devices.

Verify the ZIP against the published `SHA256SUMS.txt` before opening. No bypass command is required or provided.

## Source and build

`src/` contains the React/TypeScript application; `dist/` is the ready-to-run static build, kept independent from source. `portable/` contains the native launcher, local static server and packaging script. No dependency installation is needed to use the downloaded app.

For development, install Node.js 22 (22.16.0 was used for release validation), then from the repository root:

```sh
npm ci
npm run build
npm test
npm run dev -- --host 127.0.0.1
```

The current checked-in dist was preserved from the existing working application. A fresh isolated lockfile install and source build reproduced all 10 files **byte-for-byte**, verified by `dist-manifest.json`. There is no missing iCloud source dependency in this release.

Browser/export validation requires Chrome and a running server:

```sh
APP_URL=http://127.0.0.1:18763 npm run test:browser
```

Set `CHROME_PATH` if Chrome is not in a standard location. The test uses its own browser profile and temporary downloads.

## Package the portable app

On macOS with Python 3.12+ and Xcode Command Line Tools:

```sh
python3 portable/package.py --output release
```

The script downloads the pinned official Node.js 22.16.0 darwin-arm64 archive, verifies its recorded SHA256, verifies the runtime binary, checks that dynamic dependencies are macOS system libraries, compiles the arm64 Cocoa launcher and ad-hoc signs the runtime and app. The bundled runtime is self-contained; no Homebrew libraries are used. `--runtime PATH` may point at the extracted official distribution (including `bin/node` and `LICENSE`). Output must not already contain the app.

The packager verifies `dist-manifest.json` first. If you intentionally change/rebuild dist, regenerate the manifest after reviewing the changes:

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json
root = Path('dist')
manifest = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}
Path('dist-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
```

Archive with macOS `ditto` to retain the app structure and executable permissions:

```sh
ditto -c -k --keepParent --norsrc 'release/DSSC Layout Portable.app' release/DSSC-Layout-Portable-macOS-arm64-0.1.0.zip
(cd release && shasum -a 256 DSSC-Layout-Portable-macOS-arm64-0.1.0.zip > SHA256SUMS.txt)
```

Ad-hoc signatures are not reproducible byte-for-byte release ZIP guarantees. A trusted Developer ID signing/notarization workflow is not included.

## Licensing

No license is granted for this project as a whole by this release. The MIT notice in `THIRD_PARTY_NOTICES.md` applies **only to the attributed Voronoi Font material**. Dependency notices are in `DEPENDENCY_LICENSES.txt`. The bundled Node.js and its included components' licenses are reproduced in `portable/NODE-LICENSE.txt` and inside the app at `Contents/Resources/runtime/LICENSE`. These third-party licenses do not relicense this application.
