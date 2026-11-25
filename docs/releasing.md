# Releasing GifHop

1. Run `npm test`, one production build, `npm run test:ui`, and `npm run test:desktop`. Review `git diff --check` and runtime dependency audit.
2. Update `package.json` and lockfile to the release version. Commit the reviewed change to `main`; tag the exact commit `v<version>`.
3. Push the commit/tag. `.github/workflows/desktop.yml` builds macOS arm64/x64, Windows x64 and Linux x64 independently. Each job runs validation before packaging. No account secrets or generated image requests run in CI.
4. Download the four successful workflow artifacts. Inspect file names/sizes, run a packaged app smoke test where possible, and generate SHA-256 checksums for every distributable.
5. Publish installers and `SHA256SUMS.txt` to GitHub Releases on `Bavoch/GifHop`. Never publish environment files, CI logs or local recovery files as release assets.
6. For an unsigned/unnotarized candidate, set GitHub's prerelease flag and state the limitation. Do not label it as notarized or bypass Gatekeeper automatically.

A production signing release requires a Developer ID Application certificate and Apple notarization credentials, plus an appropriate Windows signing identity. Store them in private CI secrets, switch macOS `identity` to the intended distribution identity, enable notarization, and add signature verification to the workflow. Current candidates use macOS ad-hoc signing and unsigned Windows NSIS installers; no privileged installer, auto-update or background agent is installed.

Publish checksums after all builds succeed. To roll back, retain the preceding release and mark the failing candidate withdrawn; installed apps do not silently update. Do not replace published version assets with different bytes.
