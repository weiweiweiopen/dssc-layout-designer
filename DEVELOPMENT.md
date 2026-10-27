# Software development and deployment

For research use and interface instructions, start with the [README](README.md).

## Local setup

Use Node.js 24, as specified in `.nvmrc`:

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

To test and preview a production build:

```sh
npm test
npm run build
npm run preview -- --host 127.0.0.1
```

`src/` contains the React/TypeScript application. The build writes `dist/`, including third-party notices. Relative asset paths support both the GitHub Pages project URL and the local app server.

## Browser and export checks

With Chrome installed, set `APP_URL` to the address of the running app. The development server normally uses port 5173; production preview normally uses 4173.

```sh
APP_URL=http://127.0.0.1:5173 npm run test:browser
```

The published site can be checked with:

```sh
APP_URL=https://weiweiweiopen.github.io/dssc-layout-designer/ npm run test:browser
```

Set `CHROME_PATH` for a nonstandard Chrome installation and `TEST_TMPDIR` to choose the temporary download directory. The script uses an isolated browser profile and checks language switching, parameter persistence, geometry, production ZIPs, PDF and 1-bit TIFF downloads.

## 3D review checks

`npm run test:browser:3d` exercises the lazy-loaded WebGL viewer in Chrome, including camera gestures, projections, layer visibility, independent dyes, persistence and unchanged vector exports. Set `APP_URL`, `CHROME_PATH` and `TEST_TMPDIR` as for the other browser check.

`src/review-model.ts` maps canonical fabrication polygons and keeps visual settings in separate local storage; `src/review-shapes.ts` preserves interior holes during triangulation. `Review3D.tsx` is loaded only when its tab is selected. No external model, environment map or font service is required.

After adding dependencies, run `npm run notices:dependencies` to append their installed license files before building the distributed notice.

## GitHub Pages

Pushes to `main` run `.github/workflows/pages.yml`: install dependencies, run the tests, build the app and publish `dist/`. Repository **Settings → Pages → Source** uses **GitHub Actions**.

CI runs the complete suite sequentially with a 30-second per-test budget for the 60–64-cell numerical cases. Geometry tests yield between cases so worker progress reporting remains responsive.

The checked-in build also supports the portable packager. After an intentional rebuild, update and verify its manifest:

```sh
npm run manifest:dist
npm run manifest:dist -- --check
```

## Language resources

- `src/i18n.tsx`: language context and separate browser preference.
- `src/locales/en.ts`, `zh-TW.ts`: interface text with matching typed keys.
- `src/parameter-help.ts`, `src/locales/parameters.ts`: parameter explanations and labels.
- `src/locales/help.ts`, `diagnostics.ts`: tooltip translations and diagnostic display catalogues.

Language is not part of `DesignConfig`. Browser checks compare exported vector packages across languages and verify that switching preserves the view, camera, seal stage and numeric drafts.

## macOS tools

To update an existing local **DSSC Layout.app** bundle after building:

```sh
npm run sync:app
npm run sync:app -- "/path/to/DSSC Layout.app"
```

The script copies the build and documentation, preserves the service identity and applies an ad-hoc signature. Refresh the app's browser window afterwards.

The separate `portable/` launcher and packager remain available. The published [v0.1.0 macOS release](https://github.com/weiweiweiopen/dssc-layout-designer/releases/tag/v0.1.0) and its [original packaging instructions](https://github.com/weiweiweiopen/dssc-layout-designer/blob/64b9570/README.md) describe the earlier desktop release.

## Notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [DEPENDENCY_LICENSES.txt](DEPENDENCY_LICENSES.txt) for attributed materials and dependencies. These notices do not grant a licence for the application as a whole.
