import fs from "node:fs/promises";
import path from "node:path";

const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const blocks = [];
const missing = [];
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (!directory || entry.dev) continue;
  const files = await fs.readdir(directory);
  const metadata = JSON.parse(
    await fs.readFile(path.join(directory, "package.json"), "utf8"),
  );
  const licenseFiles = files.filter((name) =>
    /^(licen[sc]e|copying)(\.(txt|md|markdown))?$/i.test(name),
  );
  const texts = await Promise.all(
    licenseFiles.map((name) => fs.readFile(path.join(directory, name), "utf8")),
  );
  // React's empty client marker package declares MIT but doesn't ship a LICENSE file.
  if (!texts.length && metadata.name === "client-only")
    texts.push(await fs.readFile("node_modules/react/LICENSE", "utf8"));
  if (!texts.length) {
    missing.push(metadata.name);
    continue;
  }
  const notice = files.find((name) => /^NOTICE(\.txt|\.md)?$/i.test(name));
  if (notice)
    texts.push(await fs.readFile(path.join(directory, notice), "utf8"));
  blocks.push(
    `=== ${metadata.name} ${entry.version} (${metadata.license || "see license"}) ===\n\n${texts.join("\n\n").replace(/\r\n/g, "\n").trimEnd()}`,
  );
}
if (missing.length)
  throw new Error(`Missing dependency license texts: ${missing.join(", ")}`);
await fs.writeFile(
  "public/THIRD_PARTY_NOTICES.txt",
  `GifHop third-party notices\n\nGifHop includes the following open-source components. Electron and Chromium notices are also supplied with the desktop runtime.\n\n${blocks.join("\n\n")}\n`,
);
console.log(
  `Updated third-party notices for ${blocks.length} production dependencies.`,
);
