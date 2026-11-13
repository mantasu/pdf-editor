// Editing end to end: review status from the menu, the card's resolve ✓ and status pill, editing comments, changing
// a mark's type and color, Delete, discarding drafts, text-field undo, the rotated page, form
// filling (saved and undoable), page operations, and printing.
const fs = require("node:fs");
const { start, REPO } = require("./harness.cjs");
const { MOD, suite, selectText, dragSelect, lastEdit, edits, drawn } = require("./lib.cjs");
const { parsePdf } = require(`${REPO}/out/pdf/read.js`);
const { PDFDocument } = require(`${REPO}/node_modules/pdf-lib`);

suite("editing", async (t) => {
  const h = await start({ pdf: `${REPO}/resources/example.pdf`, width: 900 });
  const { page, host } = h;
  const card = page.locator(".pdf-popup");
  const menu = (name) => page.getByRole("menuitem", { name, exact: true });

  // Status from the note's context menu ("Completed" shows as Resolved); checkmarks are not offered.
  const note = page.locator('.pdf-note[data-id="example-note"]');
  await note.scrollIntoViewIfNeeded();
  let box = await note.boundingBox();
  await page.mouse.click(box.x + 12, box.y + 12, { button: "right" });
  await menu("Status").hover();
  await menu("Resolved").click();
  const states = lastEdit(host).annotations.filter((a) => a.state?.model === "Review");
  t.check("status added next to John's", lastEdit(host).label === "Set Status: Resolved" && states.length === 2);
  t.check("a resolved note fades", await note.evaluate((node) => node.classList.contains("pdf-closed") && node.querySelector('.pdf-status-badge[data-status="Completed"]') !== null));
  await page.mouse.click(box.x + 12, box.y + 12, { button: "right" });
  t.check("no checkmark to add", (await menu("Add Checkmark").count()) === 0 && (await menu("Status").count()) === 1);
  await page.keyboard.press("Escape");

  // Double-click a note to edit its comment.
  await page.mouse.dblclick(box.x + 12, box.y + 12);
  await page.waitForTimeout(150);
  await card.locator(".pdf-popup-body .pdf-editor-area").fill("Edited sticky note");
  await card.locator(".pdf-popup-body .pdf-button.primary").click();
  t.check("comment edited", lastEdit(host).label === "Edit Comment" && lastEdit(host).annotations.some((a) => a.contents === "Edited sticky note"));

  // Ctrl/Cmd+Z while typing a reply stays in the field.
  await card.locator(".pdf-reply-box .pdf-editor-area").click();
  await page.keyboard.type("draft reply");
  const undos = host.log.filter((m) => m.command === "undo").length;
  await page.keyboard.press(`${MOD}+z`);
  t.check("Ctrl+Z in a text field undoes the typing, not the document", host.log.filter((m) => m.command === "undo").length === undos);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // File > Save (no keyboard involved) keeps a reply that is still being typed.
  await page.mouse.click(box.x + 12, box.y + 12);
  await card.locator(".pdf-reply-box .pdf-editor-area").click();
  await page.keyboard.type("typed, not posted");
  await host.command("workbench.action.files.save");
  const withReply = await parsePdf(new Uint8Array(fs.readFileSync(host.savePath)));
  t.check("saving includes a reply still being typed", withReply.annotations.some((a) => a.contents === "typed, not posted"));

  // Underline -> Change To -> Strikethrough, then color, then Delete.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  let at = await selectText(page, "first text you post");
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.click(at.x, at.y, { button: "right" });
  t.check("a mark without a comment has no Reply or Status", (await menu("Reply").count()) === 0 && (await menu("Status").count()) === 0 && (await menu("Add Comment").count()) === 1);
  await menu("Change To").hover();
  await menu("Strikethrough").click();
  t.check("type changed", lastEdit(host).annotations.some((a) => a.id === "example-underline" && a.kind === "strikeout" && a.subtype === "StrikeOut" && a.subject === "Strikethrough"));
  await page.mouse.click(at.x, at.y, { button: "right" });
  await menu("Color").hover();
  await menu("Purple").click();
  t.check("color changed", JSON.stringify(lastEdit(host).annotations.find((a) => a.id === "example-underline").color) === JSON.stringify([0.686, 0.322, 0.871]));
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press("Delete");
  t.check("Delete removes the selected mark", lastEdit(host).label === "Delete Strikethrough", `${lastEdit(host).label} ${await page.evaluate(() => [document.activeElement?.className, document.querySelector(".pdf-actionbar") !== null, !!document.querySelector(".pdf-popup")].join())}`);

  // The card's ✓ resolves a commented thread in one click; the status pill that replaces it reopens it.
  at = await selectText(page, "and browsers");
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(150);
  await card.locator(".pdf-resolve").click();
  const resolved = lastEdit(host).annotations.filter((a) => a.replyTo === "example-strikeout" && a.state?.model === "Review");
  t.check("the card's ✓ resolves the thread", lastEdit(host).label === "Resolve" && resolved.length === 1 && resolved[0].state.value === "Completed");
  t.check("the pill takes the ✓'s place", (await card.locator(".pdf-status-pill").textContent()) === "Resolved" && (await card.locator(".pdf-resolve").count()) === 0);
  await card.locator(".pdf-status-pill").click();
  await menu("No Status").click();
  t.check("the pill's menu reopens it", lastEdit(host).label === "Set Status: None" && (await card.locator(".pdf-resolve").count()) === 1 && (await card.locator(".pdf-status-pill").count()) === 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Escape discards a new sticky note.
  const before = edits(host).length;
  await page.locator('#pdfToolbar [data-tool="note"]').click();
  const pageBox = await page.locator(".page").first().boundingBox();
  await page.mouse.click(pageBox.x + 30, pageBox.y + 400);
  await page.keyboard.type("never mind");
  await page.keyboard.press("Escape");
  t.check("Escape discards the draft", edits(host).length === before && (await drawn(page)).notes === 1);

  // The rotated page: the quick-action bar highlights there too.
  await dragSelect(page, "All tools work on rotated pages");
  at = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  await page.locator('.pdf-quickbar [aria-label="Highlight"]').click();
  const rotated = lastEdit(host).annotations.at(-1);
  t.check("highlight on the rotated page", rotated.page === 1 && rotated.quads.length === 8);
  const polygon = await page.locator('.page[data-page-number="2"] .pdf-markup-layer path').boundingBox();
  const [cx, cy] = [polygon.x + polygon.width / 2, polygon.y + polygon.height / 2];
  t.check("drawn exactly over the selection", cx >= at.left - 5 && cx <= at.right + 5 && cy >= at.top - 5 && cy <= at.bottom + 5, JSON.stringify({ polygon, at }));

  // Forms: filling is saved with the comments and is undoable.
  await page.locator('.page[data-page-number="3"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const email = () => page.locator('.page[data-page-number="3"] .annotationLayer input').nth(1);
  await email().fill("jane@example.com");
  await email().press("Tab");
  await page.waitForTimeout(800); // form edits are reported after a pause in typing
  t.check("form edit reported", host.log.some((m) => m.type === "form-edit"));
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForTimeout(1000);
  const saved = new Uint8Array(fs.readFileSync(host.savePath));
  t.check("form value saved", (await PDFDocument.load(saved)).getForm().getTextField("form.email").getText() === "jane@example.com");
  t.check("comments saved with the form", (await parsePdf(saved)).annotations.some((a) => a.contents === "Edited sticky note"));
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.getElementById("viewerContainer").focus();
  });
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(800);
  t.check("undo restores the form field", (await email().inputValue().catch(() => "?")) === "");
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(800);
  t.check("redo restores the value", (await email().inputValue().catch(() => "?")) === "jane@example.com");

  // Page operations are undoable edits that keep comments on their pages.
  await page.evaluate(() => {
    PDFViewerApplication.page = 1;
  });
  await page.waitForTimeout(300);
  const first = await page.locator(".page").first().boundingBox();
  await page.mouse.click(first.x + 30, first.y + 30, { button: "right" });
  await menu("Move Page Down").click();
  await page.waitForFunction(() => document.querySelector('.page[data-page-number="2"] .pdf-note'), null, { timeout: 10000 });
  t.check("comments move with the page", (await page.locator('.page[data-page-number="2"] .pdf-note').count()) === 1);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction(() => document.querySelector('.page[data-page-number="1"] .pdf-note'), null, { timeout: 10000 });
  t.check("undo moves it back", (await page.locator('.page[data-page-number="1"] .pdf-note').count()) === 1);
  await page.waitForTimeout(500);
  t.check("form value survives the page-op undo", (await email().inputValue().catch(() => "?")) === "jane@example.com");

  // Ctrl/Cmd+P prints through the host (pdf.js would call the webview's no-op window.print).
  await page.keyboard.press(`${MOD}+p`);
  await page.waitForTimeout(200);
  t.check("Ctrl/Cmd+P prints", host.printed === 1, String(host.printed));
  t.check("no webview errors", h.errors.length === 0, h.errors.join(" | "));
  await h.close();
});
