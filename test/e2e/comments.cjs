// Comments end to end: note icons, hover, the comment card (Acrobat flow: comment first, then
// replies), formatted text, the quick-action bar, right-click after macOS-style selections
// (which collapse the live selection), the selection bar on marks, the one-shot highlight tool,
// colors, sticky notes, undo/redo, the panel, save/reopen.
// WIDTH=700 is a half-width editor, WIDTH=1400 a full one.
const fs = require("node:fs");
const { start, REPO } = require("./harness.cjs");
const { MOD, suite, selectText, dragSelect, lastEdit, drag, drawn, activeTool } = require("./lib.cjs");
const { parsePdf } = require(`${REPO}/out/pdf/read.js`);

const WIDTH = Number(process.env.WIDTH ?? 700);

suite(`comments-${WIDTH}`, async (t) => {
  const h = await start({ pdf: `${REPO}/resources/example.pdf`, width: WIDTH });
  const { page, host } = h;
  const card = page.locator(".pdf-popup");

  // Note icon: real size, hover preview, click opens the thread with its replies and status.
  const note = page.locator('.pdf-note[data-id="example-note"]');
  await note.scrollIntoViewIfNeeded();
  let box = await note.boundingBox();
  t.check("the toolbar fits without scrolling", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  t.check("the first page opens centered", await page.evaluate(() => {
    const container = document.getElementById("viewerContainer");
    const p = document.querySelector(".page").getBoundingClientRect();
    return Math.abs(p.left - (container.clientWidth - p.right)) < 2;
  }));
  t.check("note icon renders at full size", box?.width === 24 && box?.height === 24, JSON.stringify(box));
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.waitForTimeout(600);
  t.check("hover previews the note", await page.locator(".pdf-preview").isVisible());
  await page.mouse.click(box.x + 12, box.y + 12);
  await page.waitForTimeout(150);
  t.check("click opens the comment card", await card.isVisible());
  t.check("card shows both replies", (await card.locator(".pdf-reply").count()) === 2);
  t.check("card shows the review status", (await card.locator(".pdf-thread-header .pdf-status-pill").textContent()) === "Accepted");
  t.check("a thread with a status has no one-click resolve", (await card.locator(".pdf-resolve").count()) === 0);
  const cardBox = await card.boundingBox();
  t.check("card fits in the window", cardBox.x >= 0 && cardBox.x + cardBox.width <= WIDTH, JSON.stringify(cardBox));
  await t.shot(page, "card");

  // Formatted reply.
  await card.locator(".pdf-reply-box .pdf-editor-area").click();
  await page.keyboard.type("A ");
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type("bold");
  const boldButton = card.locator('.pdf-reply-box [aria-label="Bold (Ctrl+B)"]');
  t.check("the Bold button shows as pressed while typing bold", (await boldButton.getAttribute("aria-pressed")) === "true");
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type(" reply");
  t.check("and released after Ctrl+B", (await boldButton.getAttribute("aria-pressed")) === "false");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ArrowLeft");
  }
  t.check("the caret back in bold text presses it again", (await boldButton.getAttribute("aria-pressed")) === "true");
  await page.keyboard.press("End");
  // Code toggles at the caret like Bold.
  const codeButton = card.locator('.pdf-reply-box [aria-label="Code"]');
  await codeButton.click();
  t.check("Code turns on at the caret", (await codeButton.getAttribute("aria-pressed")) === "true");
  await page.keyboard.type("x()");
  await codeButton.click();
  t.check("and off again", (await codeButton.getAttribute("aria-pressed")) === "false");
  await page.keyboard.type("!");
  await card.locator(".pdf-reply-box .pdf-button.primary").click();
  await page.waitForTimeout(150);
  const reply = lastEdit(host).annotations.at(-1);
  t.check("reply is posted with formatting", lastEdit(host).label === "Add Reply" && JSON.stringify(reply.rich) === JSON.stringify([[{ text: "A " }, { text: "bold", bold: true }, { text: " reply" }, { text: "x()", code: true }, { text: "!" }]]), JSON.stringify(reply.rich));
  t.check("card shows 3 replies", (await card.locator(".pdf-reply").count()) === 3);

  // Maths: $...$ is rendered in the card and kept as source in the text.
  await card.locator(".pdf-reply-box .pdf-editor-area").click();
  await page.keyboard.type("Energy $E = mc^2$ costs $5 and $6");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForFunction(() => document.querySelector(".pdf-popup .pdf-reply:last-child .pdf-math svg"), null, { timeout: 10000 }).catch(() => undefined);
  t.check("a formula in a reply is rendered; prices stay text", (await card.locator(".pdf-reply").last().locator(".pdf-math svg").count()) === 1 && (await card.locator(".pdf-reply").last().textContent()).includes("costs $5 and $6"));
  t.check("its source is what is stored", lastEdit(host).annotations.at(-1).contents === "Energy $E = mc^2$ costs $5 and $6");

  // Drag the note at this width.
  await page.keyboard.press("Escape");
  box = await note.boundingBox();
  await drag(page, [box.x + 12, box.y + 12], [box.x - 60, box.y + 50]);
  const moved = await note.boundingBox();
  t.check("note can be dragged", lastEdit(host).label === "Move" && Math.abs(moved.x - (box.x - 72)) < 3, JSON.stringify(moved));
  t.check("dragging does not open the card", !(await card.isVisible()));

  // Quick-action bar: "Add comment" highlights and opens the card to write the comment.
  await dragSelect(page, "Acrobat, Preview");
  t.check("selecting text shows the quick-action bar", await page.locator(".pdf-quickbar").isVisible());
  await page.locator('.pdf-quickbar [aria-label="Underline"]').hover();
  await page.waitForTimeout(600);
  t.check("hovering a button names it", (await page.locator(".pdf-tooltip").textContent().catch(() => "")) === "Underline");
  await t.shot(page, "quickbar");
  await page.locator('.pdf-quickbar [aria-label="Add comment"]').click();
  await page.waitForTimeout(150);
  t.check("Add comment opens the card in compose mode", await card.locator(".pdf-popup-body .pdf-editor-area").isVisible());
  t.check("no reply box before the first comment", (await card.locator(".pdf-reply-box").count()) === 0);
  await page.keyboard.type("Is this true for every reader?");
  await card.locator(".pdf-popup-body .pdf-button.primary").click();
  await page.waitForTimeout(150);
  const commented = lastEdit(host).annotations.find((a) => a.contents === "Is this true for every reader?");
  t.check("the comment lives on the highlight itself", commented?.kind === "highlight" && !commented.replyTo, commented?.kind);
  t.check("after posting, the reply box appears", await card.locator(".pdf-reply-box").isVisible());

  // Right-click after a triple-click (macOS collapses the selection before the item is clicked).
  // Escape closes the card, then deselects (the selection bar goes too).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  at = await selectText(page, "Press Ctrl+S (Cmd+S on macOS)");
  await page.mouse.click(at.x, at.y, { clickCount: 3 });
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.evaluate(() => getSelection().removeAllRanges()); // what macOS does on Ctrl+click
  const items = await page.locator(".pdf-menu-item .pdf-menu-label").allTextContents();
  t.check("selection menu matches Acrobat's actions", ["Highlight", "Underline", "Strikethrough", "Add Comment", "Copy"].every((i) => items.includes(i)), items.join(" | "));
  const before = (await drawn(page)).markup;
  await page.getByRole("menuitem", { name: "Highlight", exact: true }).click();
  await page.waitForTimeout(150);
  t.check("highlight works even though the selection collapsed", (await drawn(page)).markup === before + 1 && lastEdit(host).label === "Add Highlight");

  // Clicking a mark selects it and shows Acrobat's bar (Comment, Color, …) instead of forcing the card open.
  const bar = page.locator(".pdf-actionbar");
  at = await selectText(page, "first text you post");
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.click(at.x, at.y + 2);
  await page.waitForTimeout(150);
  t.check("clicking a mark shows the selection bar, not the card", (await bar.isVisible()) && !(await card.isVisible()));
  t.check("an uncommented mark offers Comment", await bar.getByRole("button", { name: "Comment" }).isVisible());
  await t.shot(page, "actionbar");
  await bar.getByRole("button", { name: "Color and properties" }).click();
  await page.locator('.pdf-properties .pdf-swatch[title="Purple"]').click();
  await page.keyboard.press("Escape");
  t.check("Color recolors the mark", lastEdit(host).label === "Change Properties" && JSON.stringify(lastEdit(host).annotations.find((a) => a.id === "example-underline").color) === JSON.stringify([0.686, 0.322, 0.871]));
  await page.mouse.click(at.x, at.y + 2);
  await bar.getByRole("button", { name: "Comment" }).click();
  await page.waitForTimeout(150);
  t.check("Comment opens the card to write it, no reply box yet", (await card.locator(".pdf-popup-body .pdf-editor-area").isVisible()) && (await card.locator(".pdf-reply-box").count()) === 0);
  t.check("the bar stays", await bar.isVisible());
  await page.keyboard.type("Now the underline has a comment");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(150);
  t.check("comment stored on the underline", lastEdit(host).annotations.find((a) => a.id === "example-underline")?.contents === "Now the underline has a comment");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.mouse.click(at.x, at.y + 2);
  await page.waitForTimeout(150);
  t.check("clicking a commented mark shows its comment and the bar", (await card.locator(".pdf-comment-text").first().textContent()) === "Now the underline has a comment" && (await bar.isVisible()));
  // Like Acrobat's pop-ups: beside the page (or at the viewer's edge), never over the mark, joined to it by a line.
  const mark = await page.locator('.pdf-outline.selected[data-id="example-underline"]').boundingBox();
  let popupBox = await card.boundingBox();
  t.check("the card does not cover its mark", popupBox.x >= mark.x + mark.width || popupBox.x + popupBox.width <= mark.x || popupBox.y >= mark.y + mark.height, JSON.stringify({ mark, popupBox }));
  const line = async () => page.evaluate(() => ["x1", "y1", "x2", "y2"].map((k) => Number(document.querySelector(".pdf-connector line").getAttribute(k))));
  let [x1, y1, x2, y2] = await line();
  const near = (v, a, b) => v >= a - 6 && v <= b + 6;
  t.check("a line joins the mark to its card", near(x1, mark.x, mark.x + mark.width) && near(y1, mark.y, mark.y + mark.height) && near(x2, popupBox.x, popupBox.x + popupBox.width) && near(y2, popupBox.y, popupBox.y + popupBox.height), JSON.stringify({ line: [x1, y1, x2, y2], mark, popupBox }));
  await drag(page, [popupBox.x + 60, popupBox.y + 14], [popupBox.x + 30, popupBox.y + 74]);
  const movedCard = await card.boundingBox();
  [x1, y1, x2, y2] = await line();
  t.check("the card can be dragged by its header, the line follows", Math.abs(movedCard.x - (popupBox.x - 30)) < 3 && Math.abs(movedCard.y - (popupBox.y + 60)) < 3 && near(y2, movedCard.y, movedCard.y + movedCard.height), JSON.stringify({ popupBox, movedCard }));
  await page.keyboard.press("Escape");
  await page.mouse.click(at.x, at.y + 2);
  await page.waitForTimeout(150);
  popupBox = await card.boundingBox();
  t.check("reopened, it stays where it was moved", Math.abs(popupBox.x - movedCard.x) < 3 && Math.abs(popupBox.y - movedCard.y) < 3);
  t.check("the card has the reply box, and the bar a Reply button", (await card.locator(".pdf-reply-box").isVisible()) && (await bar.getByRole("button", { name: "Reply" }).isVisible()));
  await bar.getByRole("button", { name: "Color and properties" }).click();
  t.check("the bar's Color opens the colors right away and keeps the card", (await page.locator(".pdf-properties").isVisible()) && (await card.isVisible()));
  await page.keyboard.press("Escape");
  await bar.getByRole("button", { name: "Change type" }).click();
  await page.getByRole("menuitem", { name: "Strikethrough" }).click();
  t.check("the bar's type button turns the underline into a strikethrough", lastEdit(host).annotations.find((a) => a.id === "example-underline").kind === "strikeout");
  await page.locator(".pdf-actionbar").getByRole("button", { name: "Change type" }).click();
  await page.getByRole("menuitem", { name: "Underline" }).click();
  await t.shot(page, "commented");
  await page.keyboard.press("Escape");
  t.check("with the card closed, the bar offers Reply", await bar.getByRole("button", { name: "Reply" }).isVisible());
  await bar.getByRole("button", { name: "Reply" }).click();
  t.check("Reply opens the card at the reply box", await page.evaluate(() => document.activeElement?.closest(".pdf-reply-box") !== null));
  await page.keyboard.press("Escape");

  // Selecting other text leaves the clicked mark: its bar and card go, the selection's bar shows.
  await page.mouse.click(at.x, at.y + 2);
  await page.waitForTimeout(150);
  await dragSelect(page, "Select any text");
  t.check("selecting other text closes the mark's bar and card", !(await bar.isVisible()) && !(await card.isVisible()) && (await page.locator(".pdf-quickbar").isVisible()), `${await bar.isVisible()} ${await card.isVisible()} ${await page.locator(".pdf-quickbar").isVisible()} sel=${await page.evaluate(() => getSelection().toString())}`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => getSelection().removeAllRanges());

  // The highlight tool works once, then returns to Select so the new mark can be clicked.
  await page.locator('#pdfToolbar [data-tool="highlight"]').click();
  t.check("highlight tool on", (await activeTool(page)) === "highlight");
  const toolMark = await dragSelect(page, "Hover to preview");
  t.check("highlight tool marks the selection and returns to Select", lastEdit(host).label === "Add Highlight" && (await activeTool(page)) === "select");
  await page.mouse.click(toolMark.x, toolMark.y);
  await page.waitForTimeout(150);
  t.check("the new highlight can be clicked right away", (await bar.isVisible()) && (await page.evaluate(() => document.querySelectorAll(".pdf-outline.selected").length)) >= 1);
  await page.keyboard.press("Escape");

  // Colors: a few presets plus a custom color (for the tool, as nothing is selected).
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // A narrow bar folds the color button away; every tool dropdown holds the same panel.
  if (await page.locator("#pdfProperties").isVisible()) {
    await page.locator("#pdfProperties").click();
  } else {
    await page.locator('#pdfToolbar [data-group="markup"] + .pdf-chevron').click();
  }
  const swatches = await page.locator(".pdf-properties .pdf-swatch:not(.custom)").count();
  t.check("properties offer the 5 shared presets plus a custom color", swatches === 5 && (await page.locator(".pdf-custom-color").count()) === 1, String(swatches));
  await page.locator(".pdf-custom-color").evaluate((input) => {
    input.value = "#8844ff";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.keyboard.press("Escape");
  at = await selectText(page, "redo (Ctrl+Z");
  await page.locator('#pdfToolbar [data-tool="highlight"]').click();
  await page.waitForTimeout(150);
  t.check("highlight uses the custom color", JSON.stringify(lastEdit(host).annotations.at(-1).color) === JSON.stringify([0.533, 0.267, 1]), JSON.stringify(lastEdit(host).annotations.at(-1).color));

  // Sticky note tool, then undo/redo through VS Code.
  await page.locator('#pdfToolbar [data-tool="note"]').click();
  const pageBox = await page.locator(".page").first().boundingBox();
  await page.mouse.click(pageBox.x + 30, Math.min(pageBox.y + pageBox.height * 0.6, 860));
  await page.keyboard.type("Standalone sticky note");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(150);
  t.check("sticky note created", lastEdit(host).label === "Add Sticky Note" && (await drawn(page)).notes === 2);
  await page.keyboard.press("Escape");
  await page.locator("#viewerContainer").focus();
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(200);
  t.check("undo removes it", (await drawn(page)).notes === 1);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(200);
  t.check("redo restores it", (await drawn(page)).notes === 2);

  // Comments panel: lists every thread; filter by type; a card opens its comment.
  await page.locator("#pdfCommentsToggle").click();
  await page.waitForTimeout(300);
  const cards = await page.locator(".pdf-card").count();
  t.check("panel lists every thread", cards >= 12, String(cards));
  await page.locator('.pdf-panel-select[aria-label="Filter by type"]').selectOption("notes");
  t.check("type filter narrows the list", (await page.locator(".pdf-card").count()) === 2);
  await page.locator(".pdf-card").first().click();
  await page.waitForTimeout(300);
  t.check("a card opens its comment", await card.isVisible());
  await t.shot(page, "panel");
  await page.keyboard.press("Escape");
  await page.locator("#pdfCommentsToggle").click();

  // Save, then reopen: everything comes back, drawn by the viewer only.
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForTimeout(800);
  t.check("saved", host.saves === 1, String(host.saves));
  const { annotations } = await parsePdf(new Uint8Array(fs.readFileSync(host.savePath)));
  t.check("formatted reply saved", annotations.some((a) => a.rich?.[0]?.[1]?.bold));
  t.check("no webview errors", h.errors.length === 0, h.errors.join(" | "));
  await h.close();

  const again = await start({ pdf: host.savePath, width: WIDTH });
  const counts = await drawn(again.page);
  t.check("everything is drawn after reopening, nothing twice", counts.notes === 2 && counts.markup === 8 && counts.drawings === 4 && counts.textboxes === 1 && counts.pdfjs === 0, JSON.stringify(counts));
  t.check("no webview errors after reopening", again.errors.length === 0, again.errors.join(" | "));
  await again.close();
});
