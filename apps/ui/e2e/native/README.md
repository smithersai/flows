# Native desktop app coverage — E12.1–E12.7, CN-22

The Electrobun app is the shipped alpha artifact. Before this directory it had
no coverage of any kind.

## Why the split

`electrobun.config.ts` sets `bundleCEF: false` on every platform, so the window
is the **system webview** — WKWebView on macOS, GTKWebKit on Linux, WebView2 on
Windows. That has three consequences that shape everything here:

- **There is no CDP endpoint.** `chromiumFlags.remote-debugging-port` only
  applies when the build bundles CEF. Nothing can attach a debugger to the
  shipped window.
- **There is no headless mode.** The CLI's commands are `init`, `build`, `run`
  and `dev`. None of them takes a headless flag.
- **The bun side cannot read the DOM.** `BrowserView` offers only
  `executeJavascript`, which is fire-and-forget with no return value.

So the work is split. Everything decidable without a window is a `bun test`
under `src/bun/`, and runs in CI on every push. Only the launch itself needs a
real window, and only macOS can provide one.

| id | Where it is proved |
| --- | --- |
| E12.1 | `native-launch.ts` (macOS), plus `src/bun/Main.test.ts` for the window it builds |
| E12.2 | `src/bun/Main.test.ts` (all six URL branches), `native-launch.ts` end to end |
| E12.3 | `src/bun/Main.test.ts` — registration, binding, and every handler answering |
| E12.4 | `src/bun/LocalRepository.test.ts` (real git), `src/bun/Main.test.ts` (through the RPC seam) |
| E12.5 | `src/bun/Main.test.ts` (channel → URL), `native-artifact.ts` (channel stamp on the artifact) |
| E12.6 | `native-artifact.ts` (macOS) |
| E12.7 | **Human task — see below. There is no signing configuration in this repository.** |
| CN-22 | `native-launch.ts --target https://canary.smithers.sh` |

## The files

- **`Probe.ts`** — the wire contract between the driver and the test. No side
  effects, so a test can import it.
- **`MainProcess.ts`** — runs the REAL `src/bun/index.ts` in a subprocess with
  `electrobun/bun` replaced by a recording host fake, exercises the RPC
  handlers the entrypoint registered, and prints one JSON report. The
  entrypoint is a top-level-await module that builds the window as an import
  side effect, so it can only run once per process; a subprocess per scenario
  is how every URL branch is asserted against the shipped module instead of a
  copy of its logic. Driven by `src/bun/Main.test.ts`, not run by hand.
- **`native-launch.ts`** — macOS only. Serves the built SPA from a local
  origin, points the app at it through `SMITHERS_APP_URL`, and watches what the
  window asks for. `GET /` proves the webview loaded the document, `GET
  /assets/*.js` proves it fetched the bundle, `GET /api/auth/session` proves
  the bundle executed (main.tsx reaches `loadSession` only after
  `createAppStore` resolved and the controller was built), and the absence of
  `POST /api/client-errors` proves nothing threw. With `--target <origin>` it
  launches against a deployed origin instead; the page is then served remotely,
  so only the launch and the URL resolution are asserted, and the summary says
  so.
- **`native-artifact.ts`** — macOS only. Verifies a `--env=canary` build. Pass
  `--build` to build first. What is left at
  `build/canary-macos-<arch>/Smithers-canary.app` is the SELF-EXTRACTOR, not
  the app, so "the .app exists" proves nothing about the SPA; the check
  decompresses `Contents/Resources/<hash>.tar.zst` with electrobun's own
  `zig-zstd` and lists it.

## Running them

```sh
cd apps/ui
bun test src/bun                       # no window needed, runs anywhere
bun e2e/native/native-launch.ts        # macOS, real window, ~25s warm
bun e2e/native/native-launch.ts --target https://canary.smithers.sh   # CN-22
bun e2e/native/native-artifact.ts --build   # macOS, ~1-2 min
```

Neither script rebuilds the SPA. Both require `apps/ui/dist/index.html` to
exist, because `dist/` is shared build output.

On a non-macOS host both print `SKIP:` and exit 0. That is not a pass. Nothing
on `ubuntu-latest` can drive this window: the linux build target exists, but
launching needs WebKitGTK and a display server, and the app ships no icon or
`.desktop` handling. macOS is the only launch platform for the alpha.

## E12.7 — signing and notarization is a human task, not a test

**Status: the macOS artifact is unsigned and unnotarized.** A repository-wide
grep for `codesign`, `notariz` and `ELECTROBUN_DEVELOPER_ID` across `apps/` and
`.github/` matches exactly one line: the checklist row E12.7 itself.
`build.mac.codesign` and `build.mac.notarize` both default to `false` and
`apps/ui/electrobun.config.ts` overrides neither, so every canary build prints
`skipping codesign` and `skipping notarization`. Gatekeeper refuses the
resulting `.dmg` on any machine that did not build it.

This cannot become a test. Signing needs an Apple Developer Program
membership, a Developer ID Application certificate in a keychain, and Apple's
notary service — none of which a repository can assert.
`native-artifact.ts` states that the artifact is unsigned; it cannot make it
signed.

What a human must do:

1. Enrol the publishing identity in the Apple Developer Program and issue a
   **Developer ID Application** certificate.
2. Set `build.mac.codesign: true` and `build.mac.notarize: true` in
   `apps/ui/electrobun.config.ts`. Keep the default entitlements
   (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`,
   `disable-library-validation`); a Bun-runtime hardened-runtime app needs
   them.
3. Export `ELECTROBUN_DEVELOPER_ID` — the certificate's common name, for
   example `Developer ID Application: Example Inc (TEAMID)`.
4. Export either `ELECTROBUN_APPLEAPIISSUER` + `ELECTROBUN_APPLEAPIKEY` +
   `ELECTROBUN_APPLEAPIKEYPATH` (App Store Connect API key, preferred for CI)
   or `ELECTROBUN_APPLEID` + `ELECTROBUN_APPLEIDPASS` + `ELECTROBUN_TEAMID`.
5. Run `pnpm --filter smithers-ui run build:canary` on a macOS host with the
   keychain unlocked.
6. Verify:
   `codesign --verify --deep --strict --verbose=2 apps/ui/build/canary-macos-<arch>/Smithers-canary.app`,
   `spctl -a -vvv -t install <dmg>`, and `xcrun stapler validate -v <dmg>`.
7. Confirm on a machine that never built it: download the `.dmg`, check the
   quarantine flag with `xattr -l`, then open it. A signed and notarized
   artifact opens with no Gatekeeper prompt.

Until then the alpha ships with an install note:
`xattr -dr com.apple.quarantine /Applications/Smithers-canary.app`.
