// Fetches what the extension bundles but does not keep in git. Runs on `npm install` (so `make setup` too);
// offline, the copies already there are kept, and a packaged build ships whatever is in place.
// 1. resources/pdf.js: the newest pdf.js release (legacy build), checked for everything the viewer hooks into.
// 2. resources/fonts: the text-box fonts beyond the PDF standard ones and the typed-signature fonts, Google Fonts
//    static TTFs (from the @expo-google-fonts packages on npm) with each family's SIL Open Font License. The viewer
//    shows them through @font-face and src/pdf/fonts.ts embeds the glyphs a text box uses.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const dir = join(import.meta.dirname, "..", "resources", "pdf.js");
const read = (file) => readFileSync(join(dir, file), "utf8");
const installed = existsSync(join(dir, "BUILD_INFO")) ? read("BUILD_INFO").trim().replace("version=", "") : undefined;
// github.com/<repo>/releases/latest redirects to .../tag/v<version>.
const latest = await fetch("https://github.com/mozilla/pdf.js/releases/latest", { method: "HEAD" }).then(
  (res) => res.url.match(/\/tag\/v([\d.]+)$/u)?.[1],
  () => undefined,
);
const version = latest ?? installed;
assert.ok(version, "Could not look up the newest pdf.js release (offline?)");

if (version === installed) {
  console.log(`pdf.js ${version} already in place`);
} else {
  console.log(`Fetching pdf.js ${version}`);
  const res = await fetch(`https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-legacy-dist.zip`);
  assert.ok(res.ok, `pdf.js ${version}: HTTP ${res.status}`);
  const zip = join(mkdtempSync(join(tmpdir(), "pdfjs-")), "dist.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Windows has no unzip, but its tar reads zips.
  try {
    execFileSync("unzip", ["-q", zip, "-d", dir]);
  } catch {
    execFileSync("tar", ["-xf", zip, "-C", dir]);
  }
  rmSync(join(zip, ".."), { recursive: true, force: true });
  for (const file of readdirSync(dir, { recursive: true })) {
    if (file.endsWith(".map")) rmSync(join(dir, file));
  }
  for (const file of ["compressed.tracemonkey-pldi-09.pdf", "debugger.css", "debugger.mjs"]) {
    rmSync(join(dir, "web", file), { force: true });
  }
  writeFileSync(join(dir, "BUILD_INFO"), `version=${version}\n`);
}

// A release that drops any of these would break the viewer, so fail now rather than at runtime.
const files = ["build/pdf.mjs", "build/pdf.worker.mjs", "web/viewer.html", "web/viewer.mjs", "web/viewer.css", "web/cmaps/LICENSE", "web/standard_fonts/LICENSE_FOXIT", "web/locale/locale.json"];
for (const file of files) assert.ok(existsSync(join(dir, file)), `pdf.js ${version} has no ${file}`);
const expect = (file, snippets) => {
  const text = read(file);
  for (const snippet of snippets) assert.ok(text.includes(snippet), `pdf.js ${version}: ${file} no longer contains ${snippet}`);
};
// resources/viewer/main.mjs imports the app, sets these options and replaces the print and save handlers.
expect("web/viewer.mjs", [
  "export { PDFViewerApplication,",
  "AppOptions as PDFViewerApplicationOptions",
  'eventBus.on("print", this.triggerPrinting.bind(this)',
  'eventBus.on("download", this.downloadOrSave.bind(this)',
  ...["annotationEditorMode", "enableComment", "enableHighlightFloatingButton", "enableSplitMerge", "docBaseUrl", "scrollModeOnLoad", "spreadModeOnLoad"].map((option) => `["${option}", {`),
  ...["pagesinit", "pagesloaded", "pagerendered", "textlayerrendered", "updateviewarea", "rotationchanging", "switchspreadmode", "cursortoolchanged"].map((event) => `"${event}"`),
]);
// src/editor/html.ts rewrites viewer.html around these.
expect("web/viewer.html", ['id="outerContainer"', 'id="viewerContainer"', 'id="toolbarViewerRight"', 'id="editorModeButtons"', 'href="locale/locale.json"', 'src="../build/pdf.mjs"', 'href="viewer.css"', 'src="viewer.mjs"']);
assert.ok(/\n  saveDocument\(/u.test(read("build/pdf.mjs")), `pdf.js ${version}: pdf.mjs has no saveDocument() (needed to save form fields)`);
console.log(`pdf.js ${version} checked`);

// --- Fonts ------------------------------------------------------------------------

const fontDir = join(import.meta.dirname, "..", "resources", "fonts");
const STYLES = Object.entries({ Regular: "400Regular", Bold: "700Bold", Italic: "400Regular_Italic", BoldItalic: "700Bold_Italic" });
const REGULAR = STYLES.slice(0, 1);
// Text-box fonts: keep in step with src/pdf/fonts.ts and resources/viewer/layers.mjs. Each family was checked to embed and
// render correctly through pdf-lib's fontkit (fonts with contextual alternates, such as Caveat or JetBrains Mono, do not).
// Signature fonts (SIGNATURE_FONTS in layers.mjs) are only drawn onto an image in the viewer, so one face each will do.
// `license` is the license's path in github.com/google/fonts, saved as e.g. OFL-Roboto.txt.
const FAMILIES = [
  { name: "Roboto", npm: "roboto", version: "0.4.3", license: "ofl/roboto/OFL.txt", styles: STYLES },
  { name: "Lora", npm: "lora", version: "0.4.2", license: "ofl/lora/OFL.txt", styles: STYLES },
  { name: "ComicNeue", npm: "comic-neue", version: "0.4.1", license: "ofl/comicneue/OFL.txt", styles: STYLES },
  { name: "Birthstone", npm: "birthstone", version: "0.4.2", license: "ofl/birthstone/OFL.txt", styles: REGULAR },
  { name: "Allison", npm: "allison", version: "0.4.2", license: "ofl/allison/OFL.txt", styles: REGULAR },
  { name: "Yellowtail", npm: "yellowtail", version: "0.4.1", license: "apache/yellowtail/LICENSE.txt", styles: REGULAR },
  { name: "GreatVibes", npm: "great-vibes", version: "0.4.1", license: "ofl/greatvibes/OFL.txt", styles: REGULAR },
];
const licenseFile = (family) => `${basename(family.license, ".txt")}-${family.name}.txt`;

mkdirSync(fontDir, { recursive: true });
for (const family of FAMILIES) {
  const wanted = [...family.styles.map(([style]) => `${family.name}-${style}.ttf`), licenseFile(family)];
  if (wanted.every((file) => existsSync(join(fontDir, file)))) {
    continue;
  }
  console.log(`Fetching ${family.name}`);
  const res = await fetch(`https://registry.npmjs.org/@expo-google-fonts/${family.npm}/-/${family.npm}-${family.version}.tgz`);
  assert.ok(res.ok, `${family.name}: HTTP ${res.status}`);
  const work = mkdtempSync(join(tmpdir(), "pdf-fonts-"));
  const archive = join(work, "package.tgz");
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const members = family.styles.map(([, weight]) => `package/${weight}/${family.name}_${weight}.ttf`);
  execFileSync("tar", ["-xzf", archive, "-C", work, ...members]);
  for (const [i, [style]] of family.styles.entries()) {
    copyFileSync(join(work, members[i]), join(fontDir, `${family.name}-${style}.ttf`));
  }
  rmSync(work, { recursive: true, force: true });
  const license = await fetch(`https://raw.githubusercontent.com/google/fonts/main/${family.license}`);
  assert.ok(license.ok, `${family.name} license: HTTP ${license.status}`);
  writeFileSync(join(fontDir, licenseFile(family)), await license.text());
}
// Fonts dropped from the list would otherwise still be packaged.
const keep = new Set(FAMILIES.flatMap((family) => [...family.styles.map(([style]) => `${family.name}-${style}.ttf`), licenseFile(family)]));
for (const file of readdirSync(fontDir)) {
  if (!keep.has(file)) {
    rmSync(join(fontDir, file));
    console.log(`Removed ${file}`);
  }
}
console.log("Fonts in place");
