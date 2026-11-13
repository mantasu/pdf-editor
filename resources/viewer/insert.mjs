/**
 * Things placed onto a page rather than drawn: text boxes typed in place, pictures from a file,
 * and the user's saved signature (drawn, typed or uploaded once, then stamped with one click).
 */
import * as model from "./annotations.mjs";
import { hideObjectBar } from "./commands.mjs";
import { h, pref, setPref } from "./core.mjs";
import { bbox, roundPt } from "./geometry.mjs";
import { LINE_HEIGHT, SIGNATURE_FONTS, applyTextStyle, baseViewport, currentPage, htmlLayer, placeHtmlBox, redraw, verticalColumns } from "./layers.mjs";
import { containsMath, formatToolbar, loadMathJax, mathLoaded, plainPaste, readEditor, richNodes } from "./richtext.mjs";
import { fieldsFor } from "./tools.mjs";

// --- Text boxes ------------------------------------------------------------------------
// A contenteditable laid exactly over the rendered box, growing downwards, with a floating format bar.

const NEW_BOX_WIDTH = 180;
const CARET_KEYS = {
  Home: ["backward", "lineboundary"], End: ["forward", "lineboundary"],
  ArrowUp: ["backward", "line"], ArrowDown: ["forward", "line"],
  PageUp: ["backward", "documentboundary"], PageDown: ["forward", "documentboundary"],
};

/** The box being edited: `{ id, isNew, annotation, editor, bar, grow, follow }`, or null. */
let session = null;

export function isTyping() {
  return session !== null;
}

/** Start a new text box with its top-left corner at a PDF point; `width` defaults to what fits the page. */
export function newTextBox(page, x, y, width) {
  const boxWidth = width ?? Math.max(40, Math.min(NEW_BOX_WIDTH, (baseViewport(page)?.viewBox[2] ?? x + NEW_BOX_WIDTH) - x - 8));
  const fields = fieldsFor("freetext");
  // A vertical box hangs down from the point, one column wide.
  const rect = fields.vertical ? [x, y - Math.max(40, Math.min(width ?? NEW_BOX_WIDTH, y - 8)), x + minHeight(fields), y] : [x, y - minHeight(fields), x + boxWidth, y];
  openEditor(model.create({ ...fields, page, rect }), true);
}

export function editTextBox(id) {
  const annotation = model.find(id);
  if (annotation?.kind === "freetext" && !model.readOnlyReason()) {
    openEditor(annotation, false);
  }
}

/** Save the box being edited as one edit; an empty box is dropped (new) or deleted (existing). */
export function commitTextBox() {
  if (!session) {
    return;
  }
  const { contents, rich } = readEditor(session.editor);
  // Rendered maths rarely has the height of its source text, so size the box for the rendered form.
  if (containsMath(contents) && mathLoaded()) {
    session.editor.replaceChildren(...richNodes(contents, rich));
    session.grow();
  }
  const { id, isNew, editor, bar, follow } = session;
  // The browser spaces upright letters by each font's own metrics; the saved layout takes 1 em a letter, so a
  // vertical box gets exactly the columns that layout needs.
  const annotation = session.annotation.vertical ? { ...session.annotation, rect: fitVertical(session.annotation, contents, rich) } : session.annotation;
  session = null;
  editor.remove();
  bar.remove();
  document.getElementById("viewerContainer")?.removeEventListener("scroll", follow);
  const saved = model.find(id);
  if (isNew && contents) {
    model.add([{ ...annotation, contents, rich }], "Add Text Box");
    model.select(id);
  } else if (!isNew && !contents) {
    model.remove(id, "Delete Text Box");
  } else if (!isNew && (contents !== saved?.contents || JSON.stringify(rich) !== JSON.stringify(saved?.rich) || annotation.rect.join() !== saved?.rect.join())) {
    model.patch(id, { contents, rich, rect: annotation.rect }, "Edit Text Box");
  } else {
    redraw(annotation.page);
  }
}

const minHeight = (annotation) => (annotation.font?.size ?? 12) * LINE_HEIGHT + 4;

/** A vertical box's rect, as wide as its columns of text (at least one). */
function fitVertical(annotation, contents, rich) {
  const [x1, y1, , y2] = annotation.rect;
  const columns = Math.max(1, verticalColumns(annotation, contents, rich).length);
  return [x1, y1, x1 + columns * (annotation.font?.size ?? 12) * LINE_HEIGHT + 4, y2].map(roundPt);
}
const preloadMath = () => loadMathJax().catch(() => undefined);

function openEditor(annotation, isNew) {
  commitTextBox();
  hideObjectBar();
  const layer = htmlLayer(annotation.page);
  const viewport = baseViewport(annotation.page);
  if (!layer || !viewport) {
    return;
  }
  const editor = h("div", { className: "pdf-textbox pdf-textbox-editor", contentEditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Text box", dataset: { id: annotation.id }, spellcheck: true }, richNodes(annotation.contents, annotation.rich, { math: false }));
  // Commit measures typeset formulas, so get MathJax loading as soon as a formula may be present.
  if (containsMath(annotation.contents)) {
    preloadMath();
  }
  editor.addEventListener("input", () => editor.textContent.includes("$") && preloadMath());
  plainPaste(editor);
  // A format change can rewrap lines (code runs are wider), so it refits the box as well.
  const bar = h("div", { className: "pdf-textbox-format" }, formatToolbar(editor, () => grow()));
  const placeBar = () => {
    const box = editor.getBoundingClientRect();
    const { height } = bar.getBoundingClientRect();
    const above = box.top - height - 6;
    Object.assign(bar.style, { left: `${Math.max(4, box.left)}px`, top: `${above >= 4 ? above : box.bottom + 6}px` });
  };
  // Fit the box to the content as its lines (columns, for vertical text) fill up: downwards, or rightwards for vertical text.
  const grow = () => {
    const [x1, y1, x2, y2] = session.annotation.rect;
    const pointsPerPixel = viewport.width / layer.getBoundingClientRect().width;
    editor.style[annotation.vertical ? "width" : "height"] = "auto";
    const depth = Math.max(minHeight(annotation), (annotation.vertical ? editor.scrollWidth : editor.scrollHeight) * pointsPerPixel);
    const rect = annotation.vertical ? [x1, y1, x1 + depth, y2] : [x1, y2 - depth, x2, y2];
    session.annotation = { ...session.annotation, rect: rect.map(roundPt) };
    placeHtmlBox(editor, session.annotation.rect, viewport);
    placeBar();
  };
  const follow = () => session && placeBar();
  session = { id: annotation.id, isNew, annotation, editor, bar, grow, follow };
  layer.append(editor);
  document.body.append(bar);
  applyTextStyle(editor, annotation, placeHtmlBox(editor, annotation.rect, viewport));
  grow();
  editor.addEventListener("input", grow);
  editor.addEventListener("keydown", onEditorKey);
  editor.addEventListener("blur", () => commitTextBox());
  document.getElementById("viewerContainer")?.addEventListener("scroll", follow, { passive: true });
  redraw(annotation.page);
  // A plain focus() scrolls the viewer to the editor, making the box jump.
  editor.focus({ preventScroll: true });
  getSelection()?.selectAllChildren(editor);
  getSelection()?.collapseToEnd();
}

function onEditorKey(event) {
  event.stopPropagation();
  if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
    event.preventDefault();
    commitTextBox();
  } else if (event.key in CARET_KEYS) {
    // Chrome scrolls the document when the caret is already at an edge; do the caret move by hand.
    event.preventDefault();
    const [direction, unit] = CARET_KEYS[event.key];
    getSelection()?.modify(event.shiftKey ? "extend" : "move", direction, event.ctrlKey || event.metaKey ? "documentboundary" : unit);
  }
}

// --- Pictures --------------------------------------------------------------------------

const MAX_PICTURE_SIDE = 2400;
/** The file the Image tool will place next: `{ url, width, height }`. */
let chosenPicture = null;

/** Let the user choose a picture file; resolves `true` once one is loaded and ready to place. */
export function pickPicture() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/bmp" });
    input.addEventListener("cancel", () => resolve(false));
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      chosenPicture = file ? await readPicture(file) : chosenPicture;
      resolve(Boolean(file));
    });
    input.click();
  });
}

/** A stamp annotation for the picked picture, centred on the given PDF point (none until a picture is picked). */
export function pictureAt(page, x, y) {
  if (!chosenPicture) {
    return undefined;
  }
  const [, , pageWidth] = baseViewport(page).viewBox;
  // Its size at 96 dpi (0.75 pt per pixel), but at least 48 pt wide and at most 40% of the page width.
  const width = Math.max(48, Math.min(chosenPicture.width * 0.75, pageWidth * 0.4));
  const height = (width * chosenPicture.height) / chosenPicture.width;
  return model.create({ kind: "image", subtype: "Stamp", page, rect: [x - width / 2, y - height / 2, x + width / 2, y + height / 2].map(roundPt), image: chosenPicture.url });
}

/** Choose a picture and add it, selected, at a point or else in the middle of the current page. */
export async function insertPicture(point) {
  if (model.readOnlyReason() || !(await pickPicture())) {
    return;
  }
  const page = point?.page ?? currentPage();
  const [, , pageWidth, pageHeight] = baseViewport(page).viewBox;
  const picture = pictureAt(page, point?.x ?? pageWidth / 2, point?.y ?? pageHeight / 2);
  model.add([picture], "Add Image");
  model.select(picture.id);
}

/** PNGs and JPEGs that fit MAX_PICTURE_SIDE are kept as they are; anything else is redrawn (and shrunk) on a canvas. */
async function readPicture(file) {
  const url = await readDataUrl(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && /^data:image\/(png|jpeg);/u.test(url)) {
    return { url, width: img.naturalWidth, height: img.naturalHeight };
  }
  const canvas = scaledCanvas(img, scale);
  return { url: canvas.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9), width: canvas.width, height: canvas.height };
}

// --- Signatures ------------------------------------------------------------------------
// Kept in the `signature` preference, across documents: drawn ones as strokes (placed as ink), the rest as images.

const scriptFont = (family, size) => `${size}px "${family}", cursive`;
let measurer = null;

/**
 * Whether a loaded signature font has every letter of `text`: the browser would fill gaps from the fallback, and the
 * width only stays the same across two different fallbacks when it needs none. Fonts still loading count as fitting.
 */
function fitsName(family, text) {
  if (!document.fonts.check(scriptFont(family, 40))) {
    return true;
  }
  measurer ??= document.createElement("canvas").getContext("2d");
  const width = (fallback) => ((measurer.font = `40px "${family}", ${fallback}`), measurer.measureText(text).width);
  return width("monospace") === width("serif");
}

export function storedSignature() {
  return pref("signature", null);
}

/** The stored signature as a new 150 pt wide annotation centered on a PDF point, if there is one. */
export function signatureAt(page, x, y) {
  const signature = storedSignature();
  if (!signature) {
    return undefined;
  }
  const width = 150;
  const height = width * signature.aspect;
  const [left, top] = [x - width / 2, y + height / 2];
  const rect = [left, top - height, left + width, top].map(roundPt);
  if (signature.type === "ink") {
    // Stroke coordinates are fractions of the signature's width on both axes, y pointing down.
    const ink = signature.strokes.map((stroke) => stroke.map((v, i) => roundPt(i % 2 ? top - v * width : left + v * width)));
    return model.create({ ...fieldsFor("signature"), page, ink, rect });
  }
  return model.create({ kind: "image", subtype: "Stamp", subject: "Signature", page, rect, image: signature.image });
}

/** Show the signature dialog; resolves `true` once a signature was saved, `false` when dismissed. */
export function askSignature() {
  return new Promise((resolve) => {
    const pad = signaturePad();
    let family = SIGNATURE_FONTS[0][1];
    // The image Save stores, scaled into the box: every style shows at about the same size, and long names whole.
    const sample = h("img", { className: "pdf-signature-preview", alt: "" });
    const styleRow = h("div", { className: "pdf-prop-row", role: "group", "aria-label": "Style" });
    let samples = 0;
    // The fonts that can write the name, else (a script none of them has) all of them.
    const usableFonts = () => {
      const fitting = SIGNATURE_FONTS.map(([, font]) => font).filter((font) => fitsName(font, nameInput.value));
      return fitting.length ? fitting : SIGNATURE_FONTS.map(([, font]) => font);
    };
    const showSample = async () => {
      const usable = usableFonts();
      family = usable.includes(family) ? family : usable[0];
      styleRow.replaceChildren(
        ...SIGNATURE_FONTS.map(([style, font]) =>
          h("button", {
            type: "button",
            className: `pdf-chip${font === family ? " selected" : ""}`,
            "aria-pressed": String(font === family),
            disabled: !usable.includes(font),
            title: usable.includes(font) ? font : `${font} has no letters for this name`,
            onclick: () => ((family = font), showSample()),
          }, style),
        ),
      );
      const text = nameInput.value.trim() || "Your name";
      const ticket = ++samples;
      const { image } = await typedSignature(text, family);
      // Drawing can fall behind typing: only the latest name is shown.
      if (ticket === samples) {
        Object.assign(sample, { src: image, alt: `${text} in ${family}` });
        sample.classList.toggle("placeholder", !nameInput.value.trim());
      }
    };
    const nameInput = h("input", { type: "text", className: "pdf-signature-text", placeholder: "Type your name", "aria-label": "Your name", oninput: showSample });
    showSample();
    // Until a font is in, any name fits it: check again once they all are.
    Promise.all(SIGNATURE_FONTS.map(([, font]) => document.fonts.load(scriptFont(font, 40)))).then(showSample, () => undefined);
    let uploaded = null;
    const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", "aria-label": "Signature image" });
    const uploadPreview = h("img", { className: "pdf-signature-image", alt: "" });
    fileInput.addEventListener("change", async () => {
      if (fileInput.files?.[0]) {
        uploaded = await readSignatureImage(fileInput.files[0]);
        uploadPreview.src = uploaded.image;
      }
    });
    const panes = {
      Draw: h("div", { className: "pdf-signature-pane" }, pad.canvas, h("button", { type: "button", className: "pdf-link-button", onclick: () => pad.clear() }, "Clear")),
      Type: h("div", { className: "pdf-signature-pane" }, nameInput, sample, styleRow),
      Image: h("div", { className: "pdf-signature-pane" }, fileInput, uploadPreview),
    };
    // What each tab saves, or undefined while it has nothing usable (a drawing needs a stroke of two or more points).
    const readers = {
      Draw: () => (pad.strokes.some((s) => s.length >= 4) ? { type: "ink", ...fitStrokes(pad.strokes.filter((s) => s.length >= 2)) } : undefined),
      Type: async () => (nameInput.value.trim() ? { type: "image", ...(await typedSignature(nameInput.value.trim(), family)) } : undefined),
      Image: () => (uploaded ? { type: "image", ...uploaded } : undefined),
    };
    let mode = "Draw";
    const tabs = h("div", { className: "pdf-tabs", role: "tablist" });
    const body = h("div", {});
    const showTab = (name) => {
      mode = name;
      tabs.replaceChildren(...Object.keys(panes).map((tab) => h("button", { type: "button", role: "tab", className: `pdf-tab${tab === name ? " selected" : ""}`, "aria-selected": String(tab === name), onclick: () => showTab(tab) }, tab)));
      body.replaceChildren(panes[name]);
    };
    const close = (saved) => {
      backdrop.remove();
      resolve(saved);
    };
    const save = async () => {
      const signature = await readers[mode]();
      if (signature) {
        setPref("signature", signature);
        close(true);
      }
    };
    const dialog = h(
      "div",
      { className: "pdf-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Signature" },
      h("h2", {}, "Add your signature"),
      tabs,
      body,
      h("div", { className: "pdf-edit-buttons" }, h("button", { type: "button", className: "pdf-button", onclick: () => close(false) }, "Cancel"), h("button", { type: "button", className: "pdf-button primary", onclick: save }, "Save")),
    );
    const backdrop = h("div", { className: "pdf-dialog-backdrop" }, dialog);
    backdrop.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        close(false);
      }
    });
    backdrop.addEventListener("pointerdown", (event) => event.target === backdrop && close(false));
    showTab("Draw");
    document.body.append(backdrop);
    dialog.querySelector("button")?.focus();
  });
}

/** A canvas to sign on with the pointer; `strokes` holds flat [x, y, ...] lists in canvas pixels. */
function signaturePad() {
  const canvas = h("canvas", { className: "pdf-signature-pad", width: 520, height: 170, "aria-label": "Draw your signature" });
  const strokes = [];
  const context = canvas.getContext("2d");
  const canvasPoint = (event) => {
    const box = canvas.getBoundingClientRect();
    return [((event.clientX - box.left) * canvas.width) / box.width, ((event.clientY - box.top) * canvas.height) / box.height];
  };
  const repaint = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    Object.assign(context, { lineWidth: 2.5, lineCap: "round", lineJoin: "round", strokeStyle: "#000" });
    for (const stroke of strokes) {
      context.beginPath();
      for (let i = 0; i + 1 < stroke.length; i += 2) {
        context[i ? "lineTo" : "moveTo"](stroke[i], stroke[i + 1]);
      }
      context.stroke();
    }
  };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    strokes.push(canvasPoint(event));
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons) {
      strokes.at(-1)?.push(...canvasPoint(event));
      repaint();
    }
  });
  return { canvas, strokes, clear: () => (strokes.splice(0), repaint()) };
}

/** Scale pixel strokes so the drawing spans 0..1 across its width; `aspect` is height over width. */
function fitStrokes(strokes) {
  const [x1, y1, x2, y2] = bbox(strokes.flat());
  const size = Math.max(x2 - x1, 1);
  return { strokes: strokes.map((stroke) => stroke.map((v, i) => roundPt((v - (i % 2 ? y1 : x1)) / size))), aspect: roundPt(Math.max(y2 - y1, 1) / size) };
}

/** A typed name drawn in a signature font on a canvas cropped to the ink, as a PNG data URL. */
async function typedSignature(text, family) {
  const font = scriptFont(family, 96);
  // A font that failed to load leaves its fallback, which still makes a signature.
  await document.fonts.load(font, text).catch(() => undefined);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = font;
  // Swashes and leading loops reach past the letters' advance, so the ink box sets the size, not the width.
  const metrics = context.measureText(text);
  const [left, right] = [Math.max(0, metrics.actualBoundingBoxLeft), Math.max(metrics.width, metrics.actualBoundingBoxRight)];
  Object.assign(canvas, { width: Math.ceil(left + right) + 20, height: Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) + 20 });
  // Resizing the canvas reset the context, font included.
  Object.assign(context, { font, fillStyle: "#000" });
  context.fillText(text, 10 + left, 10 + metrics.actualBoundingBoxAscent);
  return { image: canvas.toDataURL("image/png"), aspect: roundPt(canvas.height / canvas.width) };
}

/** An uploaded signature as a PNG data URL, at most 1200 pixels wide. */
async function readSignatureImage(file) {
  const url = await readDataUrl(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = scaledCanvas(img, Math.min(1, 1200 / img.naturalWidth));
      resolve({ image: canvas.toDataURL("image/png"), aspect: roundPt(canvas.height / canvas.width) });
    };
    img.onerror = reject;
    img.src = url;
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function scaledCanvas(img, scale) {
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
