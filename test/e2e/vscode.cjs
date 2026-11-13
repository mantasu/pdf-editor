// Real VS Code end to end (macOS by default; set PDF_VSCODE to the VS Code executable elsewhere):
// launches VS Code with this extension, opens PDFs in the custom editor and checks what only the
// real webview host shows: the pdf.js worker starting (no 30 s "fake worker" fallback), MathJax loading, plain
// files posted correctly, right-click actions after a triple-click, the comment card surviving
// VS Code's hot-exit backups, and saving to disk.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { REPO } = require("./harness.cjs");
const { MOD, suite, selectText } = require("./lib.cjs");
const { parsePdf } = require(`${REPO}/out/pdf/read.js`);

const VSCODE = process.env.PDF_VSCODE ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
if (!fs.existsSync(VSCODE)) {
  console.log(`SKIP VS Code not found at ${VSCODE} (set PDF_VSCODE)`);
  process.exit(0);
}

async function plainPdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 1; i <= 8; i++) {
    doc.addPage([595, 842]).drawText(`Plain page ${i} without any annotations.`, { x: 60, y: 760, size: 14, font });
  }
  fs.writeFileSync(file, await doc.save());
}

suite("vscode", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-vscode-"));
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.copyFileSync(`${REPO}/resources/example.pdf`, path.join(ws, "example.pdf"));
  await plainPdf(path.join(ws, "plain.pdf"));
  const app = await _electron.launch({
    executablePath: VSCODE,
    args: [
      `--extensionDevelopmentPath=${REPO}`,
      `--user-data-dir=${tmp}/user`,
      `--extensions-dir=${tmp}/extensions`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
      ws,
    ],
  });
  const win = await app.firstWindow();
  const warnings = [];
  win.on("console", (m) => /fake worker|PDF Viewer:/iu.test(m.text()) && warnings.push(m.text()));
  await win.waitForTimeout(3000);

  async function open(name) {
    // F1 + Backspace = Quick Open (Ctrl/Cmd+P inside a PDF prints it).
    await win.keyboard.press("F1");
    await win.waitForTimeout(400);
    await win.keyboard.press("Backspace");
    await win.keyboard.type(name);
    await win.waitForTimeout(600);
    await win.keyboard.press("Enter");
    const started = Date.now();
    const pages = name === "plain.pdf" ? 8 : 3;
    for (;;) {
      for (const frame of win.frames().filter((f) => f.url().includes("fake.html"))) {
        if ((await frame.evaluate(() => PDFViewerApplication.pdfDocument?.numPages).catch(() => 0)) === pages) {
          return { frame, ms: Date.now() - started };
        }
      }
      if (Date.now() - started > 20000) {
        return { ms: Date.now() - started };
      }
      await win.waitForTimeout(100);
    }
  }

  const plain = await open("plain.pdf");
  t.check("a PDF without comments loads", Boolean(plain.frame));
  t.check("it loads fast, on a real pdf.js worker", plain.ms < 5000 && !warnings.some((w) => /fake worker/iu.test(w)), `${plain.ms} ms ${warnings.join(" | ")}`);

  const { frame } = await open("example.pdf");
  t.check("the example opens", Boolean(frame));
  await frame.locator(".pdf-ui-layer").first().waitFor();
  // MathJax loads from the extension under the webview's CSP and renders the example's formula.
  const formula = await frame.locator(".pdf-textbox .pdf-math svg").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  t.check("maths renders in the real webview", formula);
  const at = await selectText(frame, "Press Ctrl+S (Cmd+S on macOS)");
  // Frame boxes are relative to the window already, nested webview frames included.
  const offset = await (await frame.frameElement()).boundingBox();
  const [x, y] = [at.x + offset.x, at.y + offset.y];
  await win.mouse.click(x, y, { clickCount: 3 });
  await win.mouse.click(x, y, { button: "right" });
  await frame.getByRole("menuitem", { name: "Add Comment", exact: true }).click();
  await win.keyboard.type("Written in VS Code");
  await win.keyboard.press(`${MOD}+Enter`);
  await win.waitForTimeout(300);
  t.check("right-click > Add Comment after a triple-click", (await frame.locator(".pdf-popup .pdf-comment-text").allTextContents()).includes("Written in VS Code"));
  // VS Code backs the document up (hot exit) about a second after each edit: the card must stay open.
  const replyBox = frame.locator(".pdf-popup .pdf-reply-box .pdf-editor-area");
  await replyBox.click();
  await win.keyboard.type("A reply");
  await win.waitForTimeout(2500);
  t.check("the card survives backups while a reply is typed", (await frame.locator(".pdf-popup").isVisible()) && (await replyBox.textContent()) === "A reply");
  await frame.locator(".pdf-popup .pdf-reply-box .pdf-button.primary").click();
  await win.waitForTimeout(2500);
  t.check("and after the reply is posted", (await frame.locator(".pdf-popup").isVisible()) && (await frame.locator(".pdf-popup .pdf-reply").count()) === 1);
  await win.keyboard.press("Escape");

  // Ask Copilot goes through the real host to VS Code's Language Model API. This test profile has no
  // Copilot sign-in, so the answer is the "not available" message (with Copilot it streams an answer).
  const passage = await selectText(frame, "Undo and");
  await win.mouse.click(passage.x + offset.x, passage.y + offset.y, { clickCount: 2 });
  await win.mouse.click(passage.x + offset.x, passage.y + offset.y, { button: "right" });
  await frame.getByRole("menuitem", { name: "Ask Copilot" }).hover();
  await frame.getByRole("menuitem", { name: "Explain" }).click();
  const outcome = await frame.locator(".pdf-copilot :is(.pdf-copilot-error, .pdf-button.primary)").first().waitFor({ timeout: 30000 }).then(() => frame.locator(".pdf-copilot").textContent(), () => "");
  t.check("Ask Copilot gets an answer or a clear reason", /not available|may not use Copilot|Add as Comment/u.test(outcome), outcome.slice(0, 160));
  await win.keyboard.press("Escape");
  await win.keyboard.press(`${MOD}+s`);
  await win.waitForTimeout(1500);
  const { annotations } = await parsePdf(new Uint8Array(fs.readFileSync(path.join(ws, "example.pdf"))));
  const commented = annotations.find((a) => a.kind === "highlight" && a.contents === "Written in VS Code");
  t.check("Cmd/Ctrl+S writes the comment and its reply into the file", Boolean(commented) && annotations.some((a) => a.replyTo === commented.id && a.contents === "A reply"));
  t.check("no extension errors", !warnings.some((w) => w.startsWith("PDF Viewer:")), warnings.join(" | "));
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
