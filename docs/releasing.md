# Releasing GifHop

1. Run `npm test`, one production build, `npm run test:ui`, and `npm run test:desktop`. Review `git diff --check` and runtime dependency audit.
2. Update `package.json` and lockfile to the release version. Commit the reviewed change to `main`; tag the exact commit `v<version>`.
3. Push the commit/tag. `.github/workflows/desktop.yml` builds macOS arm64/x64, Windows x64 and Linux x64 independently. Each job runs validation before packaging. No account secrets or generated image requests run in CI.
4. Download the four successful workflow artifacts. Inspect file names/sizes, run a packaged app smoke test where possible, and generate SHA-256 checksums for every distributable.
5. Upload installers and `SHA256SUMS.txt` to a draft GitHub Release on `Bavoch/GifHop`. Verify the uploaded asset names and SHA-256 digests before making it public. Never publish environment files, CI logs or local recovery files as release assets.
6. Mark a stable version as the latest release. Use GitHub’s prerelease flag for release candidates. State the actual signing status and possible operating system prompts in the release notes.

The default distribution uses macOS ad-hoc signing and unsigned Windows NSIS installers. Apple’s notarization service and Windows publisher signing are optional when explicitly requested. macOS Gatekeeper and Windows SmartScreen may show warnings or block an install according to the device’s policy. No privileged installer, auto-update or background agent is installed.

Publish checksums after all builds succeed. To roll back, retain the preceding release and mark the failing candidate withdrawn; installed apps do not silently update. Do not replace published version assets with different bytes.
