// Tools end to end: pen (strokes join one drawing), lines/arrows (Shift snaps),
// rectangles (Shift = square), ovals, one-shot tools that select what they made, the selection
// bar, moving, resizing, formatted text boxes, Fill & Sign, Hand, images, properties, deleting,
// the rotated page, and save/reopen.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { start, REPO } = require("./harness.cjs");
const { MOD, suite, lastEdit, edits, drag, drawn, dragSelect, useTool, activeTool } = require("./lib.cjs");
const { parsePdf } = require(`${REPO}/out/pdf/read.js`);
const { pngOf } = require(`${REPO}/out/pdf/image.js`);

suite("tools", async (t) => {
  const h = await start({ pdf: `${REPO}/resources/example.pdf`, width: 1200, height: 900 });
  const { page, host } = h;
  const drawTool = (title) => useTool(page, "draw", title);
  const pageBox = await page.locator(".page").first().boundingBox();
  // Points in the empty lower part of page 1 (visible at this size).
  const at = (fx, y) => [pageBox.x + pageBox.width * fx, y];
  const added = () => lastEdit(host).annotations.at(-1);

  // Pen: two quick strokes make one drawing; undo removes only the second stroke.
  await drawTool("Draw freehand");
  t.check("the pen cursor is shown", await page.evaluate(() => getComputedStyle(document.querySelector(".page")).cursor.startsWith("url(")));
  await drag(page, at(0.1, 820), at(0.3, 860));
  await drag(page, at(0.1, 860), at(0.3, 820));
  t.check("first stroke adds a drawing, the second joins it", edits(host).at(-2).label === "Add Drawing" && lastEdit(host).label === "Draw" && added().ink.length === 2);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(150);
  t.check("undo removes the last stroke only", (await drawn(page)).drawings === 5);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(150);

  // Changing the pen color starts a new drawing instead of joining the last one.
  await page.locator("#pdfProperties").click();
  await page.locator('.pdf-properties .pdf-swatch[title="Blue"]').click();
  await page.keyboard.press("Escape");
  await drag(page, at(0.32, 820), at(0.36, 860));
  t.check("a stroke in another color is a new drawing", lastEdit(host).label === "Add Drawing" && (await drawn(page)).drawings === 6, String((await drawn(page)).drawings));
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(150);

  // Line with Shift snaps to 45° steps; arrow; square with Shift; oval.
  await drawTool("Draw line");
  await drag(page, at(0.4, 820), at(0.55, 826), { shift: true });
  const line = added().line;
  t.check("Shift snaps the line horizontal", lastEdit(host).label === "Add Line" && Math.abs(line[1] - line[3]) < 0.01, JSON.stringify(line));
  await drawTool("Draw arrow");
  await drag(page, at(0.4, 850), at(0.55, 880));
  t.check("arrow drawn", lastEdit(host).label === "Add Arrow" && added().arrow === true);
  t.check("one use returns to Select and selects what was drawn", (await activeTool(page)) === "select" && (await page.locator(".pdf-handle").count()) === 2 && (await page.locator(".pdf-actionbar").isVisible()));
  // Comment on the arrow; clicking it later shows that comment (and the bar).
  await page.locator(".pdf-actionbar").getByRole("button", { name: "Comment" }).click();
  await page.keyboard.type("Look here");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  t.check("closing and deselecting hides the card and the bar", !(await page.locator(".pdf-popup").isVisible()) && !(await page.locator(".pdf-actionbar").isVisible()));
  const arrowId = added().id;
  // A point a quarter along the arrow's shaft, on screen.
  const onArrow = await page.evaluate((id) => {
    const path = document.querySelector(`.pdf-draw-layer [data-id="${id}"]`);
    const p = path.getPointAtLength(path.getTotalLength() / 4).matrixTransform(path.getScreenCTM());
    return [p.x, p.y];
  }, arrowId);
  await page.mouse.click(...onArrow);
  await page.waitForTimeout(150);
  t.check("clicking a commented shape shows its comment and the bar", (await page.locator(".pdf-popup .pdf-comment-text").textContent()) === "Look here" && (await page.locator(".pdf-actionbar").isVisible()));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await drawTool("Draw rectangle");
  await drag(page, at(0.62, 810), at(0.75, 830), { shift: true });
  const square = added().rect;
  t.check("Shift draws a square", lastEdit(host).label === "Add Rectangle" && Math.abs(square[2] - square[0] - (square[3] - square[1])) < 0.01, JSON.stringify(square));
  await drawTool("Draw oval");
  await drag(page, at(0.8, 810), at(0.92, 870));
  t.check("oval drawn", lastEdit(host).label === "Add Oval");
  await page.keyboard.press("Escape");

  // Select the square by its outline, move it, then resize from a corner handle.
  const sq = edits(host).find((e) => e.label === "Add Rectangle").annotations.at(-1);
  const outline = await page.locator(".pdf-draw-layer rect").last().boundingBox();
  await page.mouse.click(outline.x + 1, outline.y + outline.height / 2);
  await page.waitForTimeout(100);
  t.check("clicking the outline selects the shape", (await page.locator(".pdf-handle").count()) === 4);
  await drag(page, [outline.x + 1, outline.y + outline.height / 2], [outline.x - 40, outline.y + outline.height / 2]);
  const movedRect = lastEdit(host).annotations.find((a) => a.id === sq.id).rect;
  t.check("drag moves it", lastEdit(host).label === "Move" && movedRect[0] < sq.rect[0] - 20);
  const handle = await page.locator('.pdf-handle[data-handle="nw"]').boundingBox();
  await drag(page, [handle.x + 4, handle.y + 4], [handle.x - 36, handle.y - 30]);
  const resized = lastEdit(host).annotations.find((a) => a.id === sq.id).rect;
  t.check("corner handle resizes it", lastEdit(host).label === "Resize" && resized[2] - resized[0] > movedRect[2] - movedRect[0] + 15, JSON.stringify(resized));
  // Dragging an unselected object selects it, so a click elsewhere takes its bar away again.
  await page.mouse.click(...at(0.9, 890));
  let rectBox = await page.locator(".pdf-draw-layer rect").last().boundingBox();
  await drag(page, [rectBox.x + 1, rectBox.y + rectBox.height / 2], [rectBox.x + 21, rectBox.y + rectBox.height / 2]);
  t.check("dragging an object selects it", lastEdit(host).label === "Move" && (await page.locator(".pdf-actionbar").isVisible()) && (await page.locator(".pdf-handle").count()) === 4);
  await page.mouse.click(...at(0.9, 890));
  await page.waitForTimeout(100);
  t.check("and a click elsewhere then hides its bar", !(await page.locator(".pdf-actionbar").isVisible()));
  rectBox = await page.locator(".pdf-draw-layer rect").last().boundingBox();
  await page.mouse.click(rectBox.x + 1, rectBox.y + rectBox.height / 2);
  await page.keyboard.press("Delete");
  t.check("Delete removes the selected shape", lastEdit(host).label === "Delete Rectangle");
  // S and H switch to Select and Hand from any tool.
  await useTool(page, "markup", "Highlight text");
  await page.keyboard.press("s");
  t.check("S returns to Select from another tool", (await activeTool(page)) === "select");
  await useTool(page, "markup", "Highlight text");
  await page.keyboard.press("h");
  await page.keyboard.press("h");
  t.check("H picks Hand (and pressing it again keeps it)", (await activeTool(page)) === "hand");
  await page.keyboard.press("s");

  // Text box: type with formatting, edit, restyle, empty deletes.
  await useTool(page, "insert", "Add text box");
  await page.mouse.click(...at(0.5, 760));
  t.check("the text box shows a formatting bar", await page.locator(".pdf-textbox-format").isVisible());
  await page.keyboard.type("Typed into a ");
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type("text");
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type(" box, x");
  await page.locator('.pdf-textbox-format [aria-label="Superscript"]').click();
  await page.keyboard.type("2");
  await page.mouse.click(...at(0.9, 890));
  await page.waitForTimeout(100);
  const textbox = added();
  t.check("text box created", lastEdit(host).label === "Add Text Box" && textbox.contents === "Typed into a text box, x2" && textbox.font.family === "Helvetica", textbox.contents);
  t.check("its formatting is kept", JSON.stringify(textbox.rich) === JSON.stringify([[{ text: "Typed into a " }, { text: "text", bold: true }, { text: " box, x" }, { text: "2", sup: true }]]), JSON.stringify(textbox.rich));
  t.check("and drawn", (await page.locator(`.pdf-textbox[data-id="${textbox.id}"] sup`).count()) === 1 && (await page.locator(`.pdf-textbox[data-id="${textbox.id}"] strong`).count()) === 1);
  const tb = page.locator(`.pdf-textbox[data-id="${textbox.id}"]`);
  const tbBox = await tb.boundingBox();
  await page.mouse.dblclick(tbBox.x + 10, tbBox.y + tbBox.height / 2);
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(" edited");
  await page.keyboard.press("Escape");
  t.check("double-click edits the text", lastEdit(host).label === "Edit Text Box" && lastEdit(host).annotations.find((a) => a.id === textbox.id).contents === "Typed into a text box, x2 edited", lastEdit(host).annotations.find((a) => a.id === textbox.id).contents);
  await page.mouse.click(tbBox.x + 10, tbBox.y + tbBox.height / 2);
  await page.locator("#pdfProperties").click();
  t.check("text colors are five dark shades", (await page.locator(".pdf-properties .pdf-prop-section:first-child .pdf-swatch:not(.custom)").count()) === 5 && (await page.locator('.pdf-properties .pdf-swatch[title="Yellow"]').getAttribute("data-fill")) === "#8A7300");
  t.check("bold and italic are left to the format bar", (await page.locator('.pdf-properties [title="Bold"]').count()) === 0);
  await page.locator(".pdf-font-picker").click();
  t.check("the font list shows each font in itself", await page.getByRole("option", { name: "Lora", exact: true }).evaluate((node) => getComputedStyle(node).fontFamily.startsWith("Lora")));
  await page.getByRole("option", { name: "Times", exact: true }).click();
  await page.locator('.pdf-properties .pdf-align[aria-label="Center"]').click();
  t.check("a text box can be centred", lastEdit(host).annotations.find((a) => a.id === textbox.id).align === "center" && (await tb.evaluate((node) => getComputedStyle(node).textAlign)) === "center");
  const [w0] = ((r) => [r[2] - r[0], r[3] - r[1]])(lastEdit(host).annotations.find((a) => a.id === textbox.id).rect);
  await page.locator(".pdf-font-picker").click();
  await page.locator('.pdf-properties .pdf-align[aria-label="Vertical text"]').click();
  const turned = lastEdit(host).annotations.find((a) => a.id === textbox.id);
  // "Typed into a text box, x2 edited" down the old 180 pt width, 14 letters a column at 12 pt: 3 columns of 1.2 em.
  t.check("a text box can be made vertical, sized for its upright columns", turned.vertical === true && Math.abs(turned.rect[3] - turned.rect[1] - w0) < 0.01 && Math.abs(turned.rect[2] - turned.rect[0] - (3 * 14.4 + 4)) < 0.01 && (await tb.locator(".pdf-vertical-letter").count()) > 20, JSON.stringify(turned.rect));
  t.check("the font list stays open while other settings change", await page.locator(".pdf-font-list").isVisible());
  await page.locator(".pdf-font-picker").click();
  await page.locator('.pdf-properties .pdf-align[aria-label="Horizontal text"]').click();
  await page.locator('.pdf-properties select[aria-label="Font size"]').selectOption("18");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const restyled = lastEdit(host).annotations.find((a) => a.id === textbox.id);
  t.check("properties change the font", restyled.font.family === "Times" && restyled.font.size === 18, JSON.stringify(restyled.font));
  // With the box selected, the text tool's own dropdown edits the box too.
  await page.mouse.click(tbBox.x + 10, tbBox.y + tbBox.height / 2);
  await page.locator('#pdfToolbar [data-group="insert"] + .pdf-chevron').click();
  await page.locator('.pdf-tool-dropdown select[aria-label="Font size"]').selectOption("16");
  await page.keyboard.press("Escape");
  t.check("the text tool's dropdown edits the selected text box", lastEdit(host).annotations.find((a) => a.id === textbox.id).font.size === 16);
  await page.mouse.dblclick(tbBox.x + 10, tbBox.y + tbBox.height / 2);
  t.check("double-click after other actions opens the editor", await page.evaluate(() => document.activeElement.classList.contains("pdf-textbox-editor")));
  await page.keyboard.press(`${MOD}+a`);
  t.check("select-all stays inside the text box", (await page.evaluate(() => getSelection().toString())) === "Typed into a text box, x2 edited");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  t.check("emptying a text box deletes it", lastEdit(host).label === "Delete Text Box", edits(host).slice(-3).map((e) => e.label).join(","));

  // Fill & Sign: marks are placed with one click; a signature is drawn once and reused.
  await useTool(page, "insert", "Add checkmark");
  await page.mouse.click(...at(0.15, 780));
  await page.waitForTimeout(150);
  const check = added();
  t.check("checkmark placed and selected", lastEdit(host).label === "Add Checkmark" && check.kind === "ink" && check.subject === "Checkmark" && (await activeTool(page)) === "select", `${lastEdit(host).label} ${await activeTool(page)}`);
  t.check("the hand-drawn tick is one smooth stroke", check.ink.length === 1 && check.ink[0].length > 20);
  await page.locator('#pdfToolbar [data-group="insert"] + .pdf-chevron').click();
  await page.locator('.pdf-variants [aria-label="Add checkmark"]').click();
  await page.locator('.pdf-mark-style[aria-label="In a box"]').click();
  await page.keyboard.press("Escape");
  await page.mouse.click(...at(0.1, 780));
  await page.waitForTimeout(150);
  t.check("a boxed checkmark is a box and a tick", lastEdit(host).label === "Add Checkmark" && added().ink.length === 2 && added().rect[2] - added().rect[0] > 14);
  // The toolbar's color button edits what was just placed, Style included: the box goes, the tick stays put.
  const boxed = added();
  await page.locator("#pdfProperties").click();
  await page.locator('.pdf-properties .pdf-mark-style[aria-label="Classic"]').click();
  const restyledCheck = lastEdit(host).annotations.find((a) => a.id === boxed.id);
  t.check("Color and properties restyles a placed checkmark", lastEdit(host).label === "Change Properties" && restyledCheck.ink.length === 1 && (await page.locator('.pdf-properties .pdf-swatch[title="Black"]').count()) === 1);
  await page.keyboard.press("Escape");
  await useTool(page, "insert", "Add dot");
  await page.mouse.click(...at(0.2, 780));
  await page.waitForTimeout(150);
  t.check("dot placed", lastEdit(host).label === "Add Dot" && added().kind === "circle" && JSON.stringify(added().fill) === JSON.stringify(added().color));
  await page.locator('#pdfToolbar [data-group="insert"] + .pdf-chevron').click();
  // Without a signature yet, choosing Sign asks for one first.
  await page.locator('.pdf-variants [aria-label="Sign"]').click();
  const pad = await page.locator(".pdf-signature-pad").boundingBox();
  await drag(page, [pad.x + 20, pad.y + 100], [pad.x + 200, pad.y + 40]);
  await drag(page, [pad.x + 210, pad.y + 110], [pad.x + 320, pad.y + 60]);
  await page.locator(".pdf-dialog .pdf-button.primary").click();
  t.check("saving a signature arms the Sign tool", (await activeTool(page)) === "signature");
  await page.mouse.click(...at(0.3, 800));
  await page.waitForTimeout(150);
  const signature = added();
  t.check("signature placed as a drawing", lastEdit(host).label === "Add Signature" && signature.kind === "ink" && signature.ink.length === 2 && signature.rect[2] - signature.rect[0] > 100, JSON.stringify(signature.rect));
  await page.keyboard.press("Escape");

  // "Keep tool selected" keeps a tool for several uses.
  await page.locator('#pdfToolbar [data-group="insert"] + .pdf-chevron').click();
  await page.locator('.pdf-variants [aria-label="Add cross"]').click();
  await page.locator(".pdf-keep-tool input").check();
  await page.keyboard.press("Escape");
  await page.mouse.click(...at(0.4, 780));
  await page.mouse.click(...at(0.45, 780));
  await page.waitForTimeout(150);
  t.check("a kept tool stays on", edits(host).slice(-2).every((e) => e.label === "Add Cross") && (await activeTool(page)) === "cross");
  await page.keyboard.press("Escape");
  t.check("Escape leaves it", (await activeTool(page)) === "select");

  // Text marks: highlights start half-strength with rounded ends; underlines take a thickness and an opacity
  // that the page follows while the slider moves and that is saved once it is let go.
  await dragSelect(page, "signatures");
  await page.locator('.pdf-quickbar [aria-label="Highlight"]').click();
  const highlight = added();
  t.check("a new highlight is 70% strong and rounded", highlight.opacity === 0.7 && (await page.locator(`.pdf-markup-layer g[data-id="${highlight.id}"] path`).getAttribute("d")).includes("C"));
  const marked = await dragSelect(page, "text markup");
  await page.locator('.pdf-quickbar [aria-label="Underline"]').click();
  const underline = added();
  await page.mouse.click(marked.x, marked.y);
  await page.locator('.pdf-actionbar [aria-label="Color and properties"]').click();
  await page.locator('.pdf-properties .pdf-chip[aria-label="2 pt"]').click();
  t.check("an underline takes a thickness", lastEdit(host).label === "Change Properties" && lastEdit(host).annotations.find((a) => a.id === underline.id).width === 2);
  const editCount = edits(host).length;
  const slider = await page.locator(".pdf-properties .pdf-range").boundingBox();
  await page.mouse.move(slider.x + slider.width - 2, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(slider.x + slider.width * 0.3, slider.y + slider.height / 2, { steps: 4 });
  const liveOpacity = Number(await page.locator(`.pdf-markup-layer g[data-id="${underline.id}"]`).getAttribute("opacity"));
  t.check("the page follows the opacity slider while it moves", liveOpacity < 0.6 && edits(host).length === editCount, `${liveOpacity}`);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const faded = lastEdit(host).annotations.find((a) => a.id === underline.id).opacity;
  t.check("and saves it on release", edits(host).length === editCount + 1 && Math.abs(faded - liveOpacity) < 0.001, `${faded}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.getElementById("viewerContainer").scrollTop = 0;
  });
  await page.waitForTimeout(200);

  // Hand: drag scrolls the page instead of selecting text.
  await useTool(page, "cursor", "Hand (pan)");
  const scrolled = await page.evaluate(() => document.getElementById("viewerContainer").scrollTop);
  await drag(page, at(0.5, 600), at(0.5, 400));
  t.check("the hand tool pans", (await page.evaluate(() => document.getElementById("viewerContainer").scrollTop)) > scrolled + 100 && (await page.evaluate(() => PDFViewerApplication.pdfCursorTools.activeTool)) === 1);
  await page.locator('#pdfToolbar [data-group="cursor"]').click();
  t.check("the shared Select/Hand button turns it off", (await page.evaluate(() => PDFViewerApplication.pdfCursorTools.activeTool)) === 0);
  await page.evaluate(() => {
    document.getElementById("viewerContainer").scrollTop = 0;
  });
  await page.waitForTimeout(200);

  // Image: inserted from a file, resizing keeps its aspect ratio.
  const png = path.join(os.tmpdir(), "pdf-e2e.png");
  fs.writeFileSync(png, pngOf(200, 100, 3, new Uint8Array(200 * 100 * 3).fill(90)));
  // As in Acrobat: pick the picture, then click where it goes.
  await page.locator('#pdfToolbar [data-group="insert"] + .pdf-chevron').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('.pdf-variants [aria-label="Add image"]').click();
  await (await chooser).setFiles(png);
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  t.check("picking a picture arms the image tool", (await activeTool(page)) === "image");
  await page.mouse.click(...at(0.5, 700));
  await page.waitForTimeout(300);
  const image = added();
  t.check("image placed where clicked and selected", lastEdit(host).label === "Add Image" && image.image.startsWith("data:image/png") && (await page.locator(".pdf-handle").count()) === 4);
  const imageHandle = await page.locator('.pdf-handle[data-handle="se"]').boundingBox();
  await drag(page, [imageHandle.x + 4, imageHandle.y + 4], [imageHandle.x + 80, imageHandle.y + 10]);
  const [x1, y1, x2, y2] = lastEdit(host).annotations.find((a) => a.id === image.id).rect;
  t.check("image keeps its aspect ratio", Math.abs((x2 - x1) / (y2 - y1) - 2) < 0.05, ((x2 - x1) / (y2 - y1)).toFixed(3));
  await t.shot(page, "drawings");

  // Maths in a text box: rendered in the viewer, drawn into the saved PDF as outlines.
  await page.keyboard.press("Escape");
  await useTool(page, "insert", "Add text box");
  await page.mouse.click(...at(0.12, 660));
  await page.keyboard.type("Area $\\pi r^2$ or $\\dfrac{a}{b}$");
  // The color button while typing saves the box and edits it, fonts and all.
  await page.locator("#pdfProperties").click();
  t.check("Color and properties edits the text box being typed", lastEdit(host).label === "Add Text Box" && (await page.locator(".pdf-properties .pdf-font-picker").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.mouse.click(...at(0.9, 890));
  await page.waitForTimeout(300);
  const formula = added();
  const oneLine = 12 * 1.2 + 4;
  t.check("formulas in a text box are rendered", formula.contents === "Area $\\pi r^2$ or $\\dfrac{a}{b}$" && (await page.locator(`.pdf-textbox[data-id="${formula.id}"] .pdf-math svg`).count()) === 2);
  t.check("the box is sized for the rendered formula", formula.rect[3] - formula.rect[1] > oneLine, JSON.stringify(formula.rect));
  // A bundled font: shown in the viewer, embedded (subset) when saving.
  const formulaBox = await page.locator(`.pdf-textbox[data-id="${formula.id}"]`).boundingBox();
  await page.mouse.click(formulaBox.x + 4, formulaBox.y + 4);
  await page.locator("#pdfProperties").click();
  await page.locator(".pdf-font-picker").click();
  await page.getByRole("option", { name: "Comic Neue", exact: true }).click();
  await page.keyboard.press("Escape");
  t.check("a bundled font draws the text box", await page.locator(`.pdf-textbox[data-id="${formula.id}"]`).evaluate((node) => getComputedStyle(node).fontFamily.startsWith('"Comic Neue"') && document.fonts.check('12px "Comic Neue"')));
  await page.keyboard.press("Escape");

  // The page layout chosen in pdf.js's menu (two pages side by side) is remembered.
  await page.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchspreadmode", { source: null, mode: 1 }));
  await page.waitForTimeout(500);
  t.check("two-page view is remembered", host.log.some((m) => m.type === "preferences" && m.preferences.spreadMode === 1) && (await page.evaluate(() => PDFViewerApplication.pdfViewer.spreadMode)) === 1);
  await page.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchspreadmode", { source: null, mode: 0 }));

  // Narrow editors: the viewer hides its least needed buttons instead of overflowing.
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(300);
  t.check("the toolbar fits at 600 px", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector("#pdfToolbar [data-group=insert]").offsetWidth > 0));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(300);

  // The text tool's dropdown, opened while typing a new box, saves the box and edits it.
  await useTool(page, "insert", "Add text box");
  await page.mouse.click(...at(0.6, 640));
  await page.keyboard.type("Fresh box");
  await page.locator('#pdfToolbar [data-group="insert"] + .pdf-chevron').click();
  await page.locator('.pdf-tool-dropdown select[aria-label="Font size"]').selectOption("18");
  await page.keyboard.press("Escape");
  const fresh = lastEdit(host).annotations.find((a) => a.contents === "Fresh box");
  t.check("the text dropdown edits a box still being typed", fresh?.font.size === 18, JSON.stringify(fresh?.font));
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");

  // A drawing that runs off the page can be picked up by the part outside it.
  await drawTool("Draw freehand");
  await drag(page, at(0.03, 720), [pageBox.x - 70, 720]);
  const offPage = added();
  await page.keyboard.press("Escape");
  await page.mouse.click(pageBox.x + pageBox.width * 0.5, 890);
  await page.mouse.click(pageBox.x - 50, 720);
  await page.waitForTimeout(150);
  t.check("clicking beside the page selects the drawing there", (await page.evaluate(() => document.querySelectorAll(".pdf-handle").length)) === 4 && (await page.locator(".pdf-actionbar").isVisible()), offPage.id);
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");

  // Rotated page: a rectangle drawn there round-trips.
  await page.evaluate(() => {
    PDFViewerApplication.page = 2;
  });
  await page.waitForTimeout(400);
  const rotated = await page.locator('.page[data-page-number="2"]').boundingBox();
  await drawTool("Draw rectangle");
  await drag(page, [rotated.x + rotated.width * 0.3, rotated.y + 200], [rotated.x + rotated.width * 0.5, rotated.y + 260]);
  const onRotated = added();
  t.check("rectangle drawn on the rotated page", onRotated.page === 1);
  await page.keyboard.press("Escape");

  await page.keyboard.press(`${MOD}+s`);
  await page.waitForTimeout(1000);
  const saved = (await parsePdf(new Uint8Array(fs.readFileSync(host.savePath)))).annotations;
  const savedRect = saved.find((a) => a.id === onRotated.id)?.rect;
  const { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = require(`${REPO}/node_modules/pdf-lib`);
  const savedDoc = await PDFDocument.load(fs.readFileSync(host.savePath));
  const formulaDict = savedDoc.context.enumerateIndirectObjects().map(([, o]) => o).find((o) => o instanceof PDFDict && o.lookup(PDFName.of("NM"))?.decodeText?.() === formula.id);
  const formulaStream = savedDoc.context.lookup(formulaDict.lookup(PDFName.of("AP")).get(PDFName.of("N")));
  const formulaContent = new TextDecoder().decode(decodePDFRawStream(formulaStream).decode());
  t.check("the saved text box draws the formulas as outlines", (formulaContent.match(/q 0\.012 0 0 -0\.012 /gu) ?? []).length === 2 && formulaStream instanceof PDFRawStream);
  const formulaFonts = formulaStream.dict.lookup(PDFName.of("Resources")).lookup(PDFName.of("Font"));
  const baseFonts = formulaFonts.values().map((ref) => savedDoc.context.lookup(ref).lookup(PDFName.of("BaseFont")).decodeText());
  t.check("the bundled font is embedded", baseFonts.some((name) => name.startsWith("ComicNeue")), baseFonts.join());
  const savedUnderline = saved.find((a) => a.id === underline.id);
  t.check("the underline's thickness and opacity are saved", savedUnderline.width === 2 && Math.abs(savedUnderline.opacity - faded) < 0.001, JSON.stringify(savedUnderline));
  t.check("rotated-page geometry survives saving", JSON.stringify(savedRect) === JSON.stringify(onRotated.rect), `${JSON.stringify(savedRect)} vs ${JSON.stringify(onRotated.rect)}`);
  t.check("no webview errors", h.errors.length === 0, h.errors.join(" | "));
  await h.close();

  const again = await start({ pdf: host.savePath, width: 1200 });
  const counts = await drawn(again.page);
  t.check("drawings and the image come back, drawn once", counts.images === 1 && counts.drawings >= 6 && counts.pdfjs === 0, JSON.stringify(counts));
  await again.close();
});
