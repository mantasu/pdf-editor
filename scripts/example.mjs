// Builds resources/example.pdf: a one-page "paper" explaining the tools, a rotated page and a form,
// with sample annotations saved through the extension's own writer (run `npm run compile` first).
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const { mergeAnnotations } = createRequire(import.meta.url)("../out/pdf/write.js");

const doc = await PDFDocument.create();
doc.setTitle("Annotating Papers in VS Code");
const [serif, bold, italic] = await Promise.all([StandardFonts.TimesRoman, StandardFonts.HelveticaBold, StandardFonts.TimesRomanItalic].map((font) => doc.embedFont(font)));
const [SIZE, LEADING, LEFT] = [11, 16, 60];

// Page 1
const paper = doc.addPage([595, 842]);
const lines = {};
let y = 770;
const write = (text, size, font, gap, color) => {
  paper.drawText(text, { x: LEFT, y, size, font, color });
  y -= gap;
};
write("Annotating Papers in VS Code", 22, bold, 22);
write("A short example paper to try every tool on", 12, italic, 36, rgb(0.35, 0.35, 0.35));
const section = (title, key, text) => {
  write(title, 13, bold, 22);
  text.forEach((line, i) => {
    lines[`${key}.${i}`] = { line, y };
    write(line, SIZE, serif, LEADING);
  });
  y -= 10;
};
section("Abstract", "abstract", [
  "Select any text to get Acrobat's quick-action bar: Highlight, Underline, Strikethrough,",
  "Add comment and Copy. \"Add comment\" highlights the text and attaches the comment to the",
  "highlight itself, so it is not a sticky note. Right-clicking a selection offers the same actions.",
]);
section("1. Commenting", "comments", [
  "Click a mark or drawing to select it: its comment shows, with a bar for Reply, Color, type and",
  "more. As in Acrobat, the first text you post is the comment; replies follow it. Hover to preview.",
  "Comments take bold, italic, superscript, subscript, code and maths (LaTeX between dollars).",
]);
section("2. Tools", "drawing", [
  "Select (or Hand), text markup, drawing, and text boxes, images, signatures and check/cross/dot marks.",
  "Each tool's dropdown holds its colors, sizes and fonts. After one use a tool returns to Select, so",
  "what you made can be moved or resized right away, unless \"Keep tool selected\" is on.",
]);
section("3. Saving", "saving", [
  "Press Ctrl+S (Cmd+S on macOS) to save. Everything is written as standard PDF annotations, so",
  "Acrobat, Preview and browsers show the same notes, replies, highlights and drawings. Undo and",
  "redo (Ctrl+Z, Ctrl+Shift+Z) cover every change, including page rotation and form filling.",
]);

// A bar chart to circle and point at
const fig = { x: 330, y: y - 120 };
paper.drawRectangle({ ...fig, width: 200, height: 100, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.8 });
[30, 55, 42, 70, 85].forEach((height, i) => paper.drawRectangle({ x: fig.x + 20 + i * 36, y: fig.y + 10, width: 22, height, color: rgb(0.45, 0.6, 0.85) }));
paper.drawText("Figure 1. Results", { x: fig.x, y: fig.y - 16, size: 10, font: italic });

/** The box around `word` (default: the whole line) of a line of page 1, as quads and rect. */
function span(key, word) {
  const { line, y: base } = lines[key];
  const at = word ? line.indexOf(word) : 0;
  if (at < 0) {
    throw new Error(`no "${word}" in ${key}`);
  }
  const x1 = LEFT + serif.widthOfTextAtSize(line.slice(0, at), SIZE);
  const x2 = x1 + serif.widthOfTextAtSize(word ?? line, SIZE);
  // The box a selection of this serif text gives (resources/viewer/layers.mjs TEXT_LAYER_FONTS, overrides 80% and 26%):
  // 0.8 / 1.06 of the size above the baseline, the rest of 1.06 below.
  const [top, bottom] = [base + SIZE * (0.8 / 1.06), base - SIZE * (1.06 - 0.8 / 1.06)];
  return { quads: [x1, top, x2, top, x1, bottom, x2, bottom], rect: [x1, bottom, x2, top] };
}

// Page 2
const turned = doc.addPage([595, 842]);
turned.setRotation(degrees(90));
turned.drawText("Page 2 is rotated by 90 degrees.", { x: 60, y: 770, size: 20, font: bold });
turned.drawText("Right-click > Rotate Page turns it; Ctrl+Z undoes it. All tools work on rotated pages.", { x: 60, y: 740, size: 12, font: serif });

// Page 3
const page3 = doc.addPage([595, 842]);
page3.drawText("Page 3 - fillable form", { x: 60, y: 770, size: 20, font: bold });
page3.drawText("Fill in the fields, then sign with the Fill & Sign tool (or right-click > Sign Here).", { x: 60, y: 744, size: 11, font: serif });
const form = doc.getForm();
const field = (box, input) => input.addToPage(page3, { x: 160, ...box });
const name = form.createTextField("form.name");
name.setText("John Doe");
field({ y: 680, width: 300, height: 24 }, name);
field({ y: 640, width: 300, height: 24 }, form.createTextField("form.email"));
field({ y: 600, width: 20, height: 20 }, form.createCheckBox("form.agree"));
const role = form.createDropdown("form.role");
role.setOptions(["Editor", "Reviewer", "Viewer"]);
field({ y: 560, width: 200, height: 24 }, role);
Object.entries({ "Name:": 686, "Email:": 646, "I agree:": 604, "Role:": 566, "Signature:": 506 }).forEach(([label, ly]) => page3.drawText(label, { x: 60, y: ly, size: 12, font: serif }));
page3.drawLine({ start: { x: 160, y: 502 }, end: { x: 400, y: 502 }, thickness: 0.8, color: rgb(0.5, 0.5, 0.5) });

// Annotations (colors are the extension's default presets)
const color = (hex) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000);
const [YELLOW, RED, GREEN, BLUE] = ["#FFD60A", "#FF453A", "#30D158", "#409CFF"].map(color);
const [MORNING, AFTERNOON] = ["2026-10-01T12:00:00.000Z", "2026-10-01T15:30:00.000Z"];
const SUBTYPE = { note: "Text", highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", freetext: "FreeText", circle: "Circle", line: "Line", ink: "Ink" };
const annot = (kind, id, author, fields) => ({ page: 0, opacity: 1, created: MORNING, modified: MORNING, rect: [0, 0, 0, 0], contents: "", kind, subtype: SUBTYPE[kind], id: `example-${id}`, author, ...fields });
const note = (id, author, contents, rect, fields) => annot("note", id, author, { icon: "Comment", color: YELLOW, contents, rect, ...fields });
const reply = (to) => ({ replyTo: `example-${to}`, created: AFTERNOON, modified: AFTERNOON });
/** Rich text showing off every format, between `before` and `after`. */
const formatted = (before, after) => {
  const runs = [{ text: before }, { text: "bold", bold: true }, { text: ", " }, { text: "italic", italic: true }, { text: ", E = mc" }, { text: "2", sup: true }, { text: ", H" }, { text: "2", sub: true }, { text: "O, " }, { text: "code()", code: true }, { text: after }];
  return { contents: runs.map((run) => run.text).join(""), rich: [runs] };
};

const quickBar = span("abstract.0", "quick-action bar");
const pin = [535, 640, 559, 664];
const annotations = [
  annot("highlight", "highlight", "John", { color: YELLOW, ...quickBar, contents: "This is a comment on the highlight itself. Hover to preview, click to open." }),
  note("highlight-reply", "Ben", "Agreed. Replies are threaded under the comment (/IRT).", [quickBar.rect[0], quickBar.rect[3] - 24, quickBar.rect[0] + 24, quickBar.rect[3]], reply("highlight")),
  annot("underline", "underline", "John", { color: GREEN, ...span("comments.1", "first text you post") }),
  annot("strikeout", "strikeout", "Ben", { color: RED, ...span("saving.1", "and browsers"), contents: "Most browsers do, at least." }),
  annot("highlight", "rich", "Ben", { color: BLUE, ...span("comments.2", "bold, italic"), ...formatted("Formatting: ", " and maths: $e^{i\\pi} + 1 = 0$") }),
  note("note", "Ben", "A sticky note with two replies and a status. Drag me to move me.", pin),
  note("note-reply-1", "John", "First reply.", pin, reply("note")),
  note("note-reply-2", "Ben", "Acrobat chains replies; the viewer shows them as one thread.", pin, reply("note-reply-1")),
  note("note-status", "John", "Accepted set by John", pin, { replyTo: "example-note", state: { model: "Review", value: "Accepted" } }),
  annot("freetext", "textbox", "John", {
    rect: [LEFT, fig.y + 30, LEFT + 230, fig.y + 110],
    ...formatted("A text box: double-click to edit. It takes formatting too: ", ", and maths: $\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$"),
    color: [0.12, 0.4, 0.96],
    font: { family: "Helvetica", size: 11 },
  }),
  annot("circle", "oval", "Ben", { rect: [fig.x + 150, fig.y + 70, fig.x + 196, fig.y + 100], width: 2, color: RED, contents: "The best result." }),
  annot("line", "arrow", "Ben", { line: [LEFT + 235, fig.y + 70, fig.x - 6, fig.y + 55], arrow: true, width: 2, color: RED }),
  annot("ink", "ink", "John", { ink: [[LEFT, fig.y + 20, LEFT + 6, fig.y + 12, LEFT + 18, fig.y + 32]], width: 2.5, color: GREEN, contents: "Checked." }),
  annot("ink", "check", "John", { subject: "Checkmark", ink: [[fig.x + 100, fig.y - 12, fig.x + 104.7, fig.y - 16.9, fig.x + 114, fig.y - 6.4]], width: 2, color: [0, 0, 0] }),
];

const out = join(import.meta.dirname, "..", "resources", "example.pdf");
writeFileSync(out, await mergeAnnotations(await doc.save({ useObjectStreams: false }), annotations, { now: new Date(MORNING) }));
console.log("resources/example.pdf written");
