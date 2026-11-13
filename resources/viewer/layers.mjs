/**
 * Annotation overlays on the pdf.js pages: how each kind is drawn and picked, and the three layers
 * on every page div (SVG text marks, which the stylesheet multiplies onto the page as Acrobat does;
 * SVG drawings; HTML text boxes, images, note icons and frames). Picking is geometric, so the
 * layers take no pointer events and text selection passes straight through them.
 */
import * as model from "./annotations.mjs";
import { ICON, badgeHtml, config, h, iconNode, isClosed, noteSvg, pdfViewer, rgbToHex } from "./core.mjs";
import { bbox, contains, fromFrac, inQuads, inflate, outlinePoints, polylineDistance, roundedQuad, segmentDistance, stackColumns, toFrac } from "./geometry.mjs";
import { richNodes } from "./richtext.mjs";

/** Sticky-note icon size, in PDF points. */
export const NOTE_SIZE = 24;
export const LINE_HEIGHT = 1.2;

const FONT_STACKS = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
  Roboto: "Roboto, sans-serif",
  Lora: "Lora, serif",
  "Comic Neue": '"Comic Neue", "Comic Sans MS", cursive',
};
/** CSS for a text-box font family. */
export const fontStack = (family) => FONT_STACKS[family] ?? FONT_STACKS.Helvetica;

/**
 * In upright vertical text a browser gives each letter the font's line height (ascent plus descent), which varies by
 * font and system. These faces fix it at 1 em, baseline 0.8 em down, as src/pdf/kinds.ts stacks vertical text.
 */
const VERTICAL_FACE = "pdf-vertical-";
const VERTICAL_SOURCES = {
  Helvetica: 'local("Helvetica"), local("Arial"), local("Liberation Sans"), local("DejaVu Sans"), url("${fonts}Roboto-Regular.ttf")',
  Times: 'local("Times New Roman"), local("Times"), local("Liberation Serif"), local("DejaVu Serif"), url("${fonts}Lora-Regular.ttf")',
  Courier: 'local("Courier New"), local("Courier"), local("Liberation Mono"), local("DejaVu Sans Mono")',
  Roboto: 'url("${fonts}Roboto-Regular.ttf")',
  Lora: 'url("${fonts}Lora-Regular.ttf")',
  "Comic Neue": 'url("${fonts}ComicNeue-Regular.ttf")',
};

/** Font files in resources/fonts (scripts/pdfjs.mjs), by family. */
const FONT_FILES = { Roboto: "Roboto", Lora: "Lora", "Comic Neue": "ComicNeue" };

/**
 * Handwriting for typed signatures, from simple to fancy, as [style, family]: one Regular face each in resources/fonts
 * (the family without spaces). All four write the accented letters of Latin-1 and Latin Extended-A (French, Polish,
 * Lithuanian...), Great Vibes also Cyrillic; insert.mjs offers a style only for names its font can write whole.
 */
export const SIGNATURE_FONTS = [
  ["Simple", "Birthstone"],
  ["Natural", "Allison"],
  ["Bold", "Yellowtail"],
  ["Fancy", "Great Vibes"],
];

/**
 * Fonts for pdf.js's invisible text layer, which selection and new marks are measured from. pdf.js places each
 * line by its font's ascent, and the system fallbacks differ (Arial on Windows has far more room above the
 * letters than Helvetica on macOS), so these pin the metrics with ascent and descent overrides (TEXT_LAYER_METRICS).
 * pdf.js puts the baseline ascent / (ascent + descent) of the size below the line's top, and a selection covers
 * ascent + descent from there. 80% and 26% give a box 0.755 of the size above the baseline and 0.305 below, whose
 * middle (0.225 up) is the middle of the lowercase letters in both serif body text and sans-serif headings (measured),
 * with room for ascenders and descenders: a selection looks even and a strikethrough goes through the middle of the box.
 */
const TEXT_LAYER_METRICS = "ascent-override: 80%; descent-override: 26%; line-gap-override: 0%";
export const TEXT_LAYER_FONTS = {
  "sans-serif": ["pdf-text-sans", 'local("Helvetica"), local("Arial"), local("Liberation Sans"), local("DejaVu Sans")', "Roboto-Regular"],
  serif: ["pdf-text-serif", 'local("Times New Roman"), local("Times"), local("Liberation Serif"), local("DejaVu Serif")', "Lora-Regular"],
  monospace: ["pdf-text-mono", 'local("Courier New"), local("Courier"), local("Liberation Mono"), local("DejaVu Sans Mono")', "Roboto-Regular"],
};

/** Declare the bundled fonts and the text layer's; the browser fetches a face the first time something uses it. */
export function installFonts() {
  const styles = [["Regular", 400, "normal"], ["Bold", 700, "normal"], ["Italic", 400, "italic"], ["BoldItalic", 700, "italic"]];
  const rules = Object.entries(FONT_FILES).flatMap(([family, file]) =>
    styles.map(([style, weight, slope]) => `@font-face { font-family: "${family}"; src: url("${config.fonts}${file}-${style}.ttf") format("truetype"); font-weight: ${weight}; font-style: ${slope}; font-display: swap; }`),
  );
  for (const [, family] of SIGNATURE_FONTS) {
    rules.push(`@font-face { font-family: "${family}"; src: url("${config.fonts}${family.replaceAll(" ", "")}-Regular.ttf") format("truetype"); }`);
  }
  for (const [family, sources] of Object.entries(VERTICAL_SOURCES)) {
    rules.push(`@font-face { font-family: "${VERTICAL_FACE}${family}"; src: ${sources.replaceAll("${fonts}", config.fonts)}; ascent-override: 80%; descent-override: 20%; line-gap-override: 0%; }`);
  }
  for (const [name, local, fallback] of Object.values(TEXT_LAYER_FONTS)) {
    rules.push(`@font-face { font-family: "${name}"; src: ${local}, url("${config.fonts}${fallback}.ttf") format("truetype"); ${TEXT_LAYER_METRICS}; }`);
  }
  document.head.append(h("style", { id: "pdf-fonts" }, rules.join("\n")));
}

export function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

// --- Drawing each kind -----------------------------------------------------------------

const hexColor = (a, fallback) => rgbToHex(a.color) ?? fallback;
const toView = (viewport, x, y) => viewport.convertToViewportPoint(x, y);
const mix = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** Text marks, one shape per quad: highlights fill it (with rounded corners), the others stroke across it. */
function drawTextMark(a, viewport) {
  const color = hexColor(a, "#FFFF00");
  const group = svg("g", { "data-id": a.id, opacity: a.opacity ?? 1 });
  const quads = a.quads ?? [];
  for (let i = 0; i + 8 <= quads.length; i += 8) {
    const [tl, tr, bl, br] = [0, 2, 4, 6].map((j) => toView(viewport, quads[i + j], quads[i + j + 1]));
    if (a.kind === "highlight") {
      const d = roundedQuad(tl, tr, br, bl).map(([op, ...points]) => `${op}${points.map((p) => p.join(" ")).join(" ")}`).join(" ");
      group.append(svg("path", { d: `${d} Z`, fill: color }));
    } else {
      group.append(textStroke(a.kind, tl, tr, bl, br, color, a.width));
    }
  }
  return group;
}

/** An underline near the bottom of the quad, a strikethrough a little below its middle, or a zigzag; `chosen` is the line width, if one was picked. */
function textStroke(kind, tl, tr, bl, br, color, chosen) {
  const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
  const width = chosen ?? Math.max(0.6, height / 14);
  // The quads come from the text layer (TEXT_LAYER_FONTS), whose middle is mid-way up the lowercase letters.
  const depth = kind === "strikeout" ? 0.5 : 0.94;
  const [start, end] = [mix(tl, bl, depth), mix(tr, br, depth)];
  if (kind !== "squiggly") {
    return svg("line", { x1: start[0], y1: start[1], x2: end[0], y2: end[1], stroke: color, "stroke-width": width, "stroke-linecap": "round" });
  }
  const steps = Math.max(2, Math.round(Math.hypot(end[0] - start[0], end[1] - start[1]) / Math.max(1.5, height / 6, width * 2)));
  // Lift towards the top of the quad, so the zigzag follows rotated text.
  const up = [(tl[0] - bl[0]) / (height || 1), (tl[1] - bl[1]) / (height || 1)];
  const amplitude = Math.max(0.6, height / 12, width);
  const points = Array.from({ length: steps + 1 }, (_, step) => {
    const at = mix(start, end, step / steps);
    const lift = step % 2 ? amplitude : 0;
    return `${at[0] + up[0] * lift},${at[1] + up[1] * lift}`;
  });
  return svg("polyline", { points: points.join(" "), fill: "none", stroke: color, "stroke-width": width });
}

function strokeAttrs(a) {
  return { stroke: hexColor(a, "#E53935"), "stroke-width": a.width ?? 1, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round", opacity: a.opacity ?? 1, "data-id": a.id };
}

function drawInk(a, viewport) {
  const d = (a.ink ?? [])
    .filter((stroke) => stroke.length >= 2)
    .map((stroke) => {
      const points = [];
      for (let i = 0; i + 1 < stroke.length; i += 2) {
        points.push(toView(viewport, stroke[i], stroke[i + 1]).join(" "));
      }
      // A one-point stroke gets a zero-length segment so its round cap shows as a dot.
      return `M${points[0]} ${(points.length > 1 ? points.slice(1) : points).map((p) => `L${p}`).join(" ")}`;
    })
    .join(" ");
  return svg("path", { d, ...strokeAttrs(a) });
}

function drawLine(a, viewport) {
  const [from, to] = [toView(viewport, a.line[0], a.line[1]), toView(viewport, a.line[2], a.line[3])];
  let d = `M${from.join(" ")} L${to.join(" ")}`;
  if (a.arrow) {
    const size = Math.max(6, (a.width ?? 1) * 4);
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const barb = (turn) => [to[0] - size * Math.cos(angle + turn), to[1] - size * Math.sin(angle + turn)].join(" ");
    d += ` M${barb(Math.PI / 6)} L${to.join(" ")} L${barb(-Math.PI / 6)}`;
  }
  return svg("path", { d, ...strokeAttrs(a) });
}

/** Rectangles and ovals, inset by half the stroke so the outline stays inside the rect. */
function drawShape(a, viewport) {
  const w = a.width ?? 1;
  // Pages only turn in quarter steps, so the rect stays axis-aligned in the viewport.
  const [x1, y1, x2, y2] = bbox([...toView(viewport, a.rect[0], a.rect[1]), ...toView(viewport, a.rect[2], a.rect[3])]);
  const attrs = { ...strokeAttrs(a), fill: rgbToHex(a.fill) ?? "none" };
  return a.kind === "square"
    ? svg("rect", { ...attrs, x: x1 + w / 2, y: y1 + w / 2, width: Math.max(0, x2 - x1 - w), height: Math.max(0, y2 - y1 - w) })
    : svg("ellipse", { ...attrs, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rx: Math.max(0, (x2 - x1 - w) / 2), ry: Math.max(0, (y2 - y1 - w) / 2) });
}

/** Centre an HTML box on a PDF rect, turned with the page. Sizes in `cqw` follow the zoom without a redraw; returns one PDF point in `cqw`. */
export function placeHtmlBox(node, rect, viewport) {
  const [fx1, fy1, fx2, fy2] = bbox([...toFrac(viewport, rect[0], rect[1]), ...toFrac(viewport, rect[2], rect[3])]);
  const unit = 100 / viewport.width;
  Object.assign(node.style, {
    left: `${((fx1 + fx2) / 2) * 100}%`,
    top: `${((fy1 + fy2) / 2) * 100}%`,
    width: `${(rect[2] - rect[0]) * unit}cqw`,
    height: `${(rect[3] - rect[1]) * unit}cqw`,
    transform: `translate(-50%, -50%) rotate(${viewport.rotation}deg)`,
  });
  return unit;
}

/** Text-box styling, shared with the inline editor so editing looks identical. */
export function applyTextStyle(node, a, unit) {
  const font = a.font ?? { family: "Helvetica", size: 12 };
  Object.assign(node.style, {
    // Vertical text uses faces whose letters each take exactly 1 em down the column, as the PDF writer stacks them.
    fontFamily: a.vertical ? `"${VERTICAL_FACE}${font.family}", ${fontStack(font.family)}` : fontStack(font.family),
    writingMode: a.vertical ? "vertical-lr" : "horizontal-tb",
    textOrientation: a.vertical ? "upright" : "mixed",
    fontSize: `${font.size * unit}cqw`,
    fontWeight: font.bold ? "bold" : "normal",
    fontStyle: font.italic ? "italic" : "normal",
    color: hexColor(a, "#000000"),
    padding: `${2 * unit}cqw`,
    lineHeight: String(LINE_HEIGHT),
    textAlign: a.align ?? "left",
    opacity: String(a.opacity ?? 1),
  });
}

function drawTextBox(a, viewport) {
  const node = h("div", { className: "pdf-textbox", dataset: { id: a.id } });
  const unit = placeHtmlBox(node, a.rect, viewport);
  applyTextStyle(node, a, unit);
  if (a.vertical) {
    node.style.writingMode = "horizontal-tb";
    node.append(...verticalLetters(a, unit));
  } else {
    node.append(...richNodes(a.contents, a.rich));
  }
  return node;
}

/** Text-box padding, in PDF points, as the writer insets its text. */
const TEXT_INSET = 2;

/** Columns a vertical text box needs for its text, laid out as the PDF writer lays it out. */
export function verticalColumns(a, contents = a.contents, rich = a.rich) {
  const size = (a.font ?? { size: 12 }).size;
  const room = a.rect[3] - a.rect[1] - 2 * TEXT_INSET;
  return stackColumns(rich ?? contents.split("\n").map((text) => [{ text }]), Math.max(1, Math.floor(room / size)));
}

/**
 * Vertical text placed letter by letter exactly as src/pdf/kinds.ts writes it: 1 em down each column (the vertical
 * faces put the baseline 0.8 em down), columns 1.2 em wide left to right, each letter centred across its column.
 */
function verticalLetters(a, unit) {
  const font = a.font ?? { family: "Helvetica", size: 12 };
  const room = a.rect[3] - a.rect[1] - 2 * TEXT_INSET;
  const column = font.size * LINE_HEIGHT;
  const cqw = (points) => `${points * unit}cqw`;
  return verticalColumns(a).flatMap((letters, index) => {
    const slack = room - letters.length * font.size;
    const start = TEXT_INSET + (a.align === "center" ? slack / 2 : a.align === "right" ? slack : 0);
    return letters.map(({ text, run }, i) => {
      const family = run.code ? "Courier" : font.family;
      return h("span", {
        className: "pdf-vertical-letter",
        style: {
          left: cqw(TEXT_INSET + index * column),
          top: cqw(start + i * font.size),
          width: cqw(column),
          height: cqw(font.size),
          lineHeight: cqw(font.size),
          fontFamily: `"${VERTICAL_FACE}${family}", ${fontStack(family)}`,
          fontWeight: font.bold || run.bold ? "bold" : "normal",
          fontStyle: font.italic || run.italic ? "italic" : "normal",
        },
      }, text);
    });
  });
}

function drawImage(a, viewport) {
  const node = h("img", { className: "pdf-image", src: a.image ?? "", alt: "", draggable: false, dataset: { id: a.id } });
  placeHtmlBox(node, a.rect, viewport);
  node.style.opacity = String(a.opacity ?? 1);
  return node;
}

/** Note icons are pinned by their top-left corner and keep a fixed screen size. */
function drawNote(a, viewport) {
  const [fx, fy] = toFrac(viewport, a.rect[0], a.rect[3]);
  const node = iconNode("div", noteSvg(hexColor(a, "#FFD100")), {
    className: "pdf-note",
    dataset: { id: a.id },
    role: "button",
    "aria-label": `Comment by ${a.author || "unknown"}`,
  });
  Object.assign(node.style, { left: `${fx * 100}%`, top: `${fy * 100}%` });
  return node;
}

/** kind -> [layer key, draw function]. Kinds missing here ("other") are left to pdf.js. */
const DRAWERS = {
  highlight: ["markup", drawTextMark],
  underline: ["markup", drawTextMark],
  strikeout: ["markup", drawTextMark],
  squiggly: ["markup", drawTextMark],
  ink: ["draw", drawInk],
  line: ["draw", drawLine],
  square: ["draw", drawShape],
  circle: ["draw", drawShape],
  freetext: ["ui", drawTextBox],
  image: ["ui", drawImage],
  note: ["ui", drawNote],
};

// --- Hit testing -----------------------------------------------------------------------

/** Which hit wins where several overlap (ties: the newest). Text boxes are see-through, so drawings beat them. */
const STACK_RANKS = { image: 4, ink: 3, line: 3, square: 3, circle: 3, freetext: 2, other: 1 };
export const stackRank = (a) => STACK_RANKS[a.kind] ?? 0;

/** Whether the PDF point (x, y) picks an annotation, with `tolerance` PDF units of slack. */
export function hitTest(a, x, y, tolerance) {
  const reach = (a.width ?? 1) / 2 + tolerance;
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return inQuads(x, y, a.quads ?? [], 1);
    case "ink":
      return (a.ink ?? []).some((stroke) => polylineDistance(x, y, stroke) <= reach);
    case "line":
      return segmentDistance(x, y, ...a.line) <= reach;
    case "square":
    case "circle":
      return a.fill ? contains(x, y, inflate(a.rect, tolerance)) : onOutline(a, x, y, reach);
    case "note":
      // The icon is a real element and gets its own pointer events.
      return false;
    default:
      return contains(x, y, a.rect);
  }
}

/** An unfilled shape only counts near its outline, leaving the text inside it selectable. */
function onOutline(a, x, y, reach) {
  const [x1, y1, x2, y2] = a.rect;
  if (a.kind === "square") {
    return contains(x, y, inflate(a.rect, reach)) && !contains(x, y, inflate(a.rect, -reach));
  }
  const [cx, cy, rx, ry] = [(x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2 || 1, (y2 - y1) / 2 || 1];
  return Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <= reach;
}

/** "ends" for lines (drag either end), "box" for corner handles, "none" when it cannot be resized. */
export const resizeMode = (a) => (a.kind === "line" ? "ends" : ["ink", "square", "circle", "freetext", "image"].includes(a.kind) ? "box" : "none");
export const canMove = (a) => a.kind === "note" || resizeMode(a) !== "none";

// --- Page layers -----------------------------------------------------------------------

/** page index -> { div, markup, draw, ui, observer } */
const pageLayers = new Map();
/** Changes shown but not yet committed (dragging, resizing, erasing, typing): id -> patch. */
const livePatches = new Map();
let hoveredId = null;

export const pageView = (index) => pdfViewer()?.getPageView(index);
/** The page in PDF units (one per point, so SVG stroke widths match the file), with its rotation. */
export const baseViewport = (index) => pageView(index)?.viewport?.clone({ scale: 1 });
export const htmlLayer = (index) => pageLayers.get(index)?.ui;
/** 0-based index of the page taking up most of the view. */
export const currentPage = () => (pdfViewer()?.currentPageNumber ?? 1) - 1;

function mount({ div, markup, draw, ui }) {
  if (div.lastElementChild !== ui || draw.nextElementSibling !== ui || markup.nextElementSibling !== draw) {
    div.append(markup, draw, ui);
  }
}

/** Give a page view its layers and draw them; pdf.js strips them whenever it resets the div, so an observer puts them back. */
export function attachLayers(view) {
  const index = view.id - 1;
  const known = pageLayers.get(index);
  if (known?.div === view.div) {
    mount(known);
    return;
  }
  known?.observer.disconnect();
  const layers = {
    div: view.div,
    markup: svg("svg", { class: "pdf-markup-layer", preserveAspectRatio: "none" }),
    draw: svg("svg", { class: "pdf-draw-layer", preserveAspectRatio: "none" }),
    ui: h("div", { className: "pdf-ui-layer", dataset: { page: String(index) } }),
    observer: new MutationObserver(() => mount(layers)),
  };
  layers.observer.observe(view.div, { childList: true });
  pageLayers.set(index, layers);
  mount(layers);
  redraw(index);
}

export function clearLayers() {
  for (const { observer, markup, draw, ui } of pageLayers.values()) {
    observer.disconnect();
    [markup, draw, ui].forEach((layer) => layer.remove());
  }
  pageLayers.clear();
  livePatches.clear();
}

export function attachAllLayers() {
  for (let i = 0; i < (pdfViewer()?.pagesCount ?? 0); i++) {
    const view = pageView(i);
    if (view?.div) {
      attachLayers(view);
    }
  }
}

// --- Redrawing -------------------------------------------------------------------------

const withPreview = (a) => (livePatches.has(a.id) ? { ...a, ...livePatches.get(a.id) } : a);

export function redrawAll() {
  for (const index of pageLayers.keys()) {
    redraw(index);
  }
}

/** Rebuild a page's overlays from the threads, drafts, live previews, selection and hover. */
export function redraw(index) {
  const layers = pageLayers.get(index);
  const viewport = baseViewport(index);
  if (!layers || !viewport) {
    return;
  }
  for (const layer of [layers.markup, layers.draw]) {
    layer.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
    layer.replaceChildren();
  }
  // Leave the inline text editor where it is: taking it out of the DOM, even briefly, would blur it.
  const editor = layers.ui.querySelector(":scope > .pdf-textbox-editor");
  for (const child of [...layers.ui.children]) {
    if (child !== editor) {
      child.remove();
    }
  }
  const addHtml = (...nodes) => nodes.forEach((node) => layers.ui.insertBefore(node, editor));
  const draftIds = new Set(model.drafts().map((a) => a.id));
  const editingId = editor?.dataset.id;
  const selected = model.selectedId();
  for (const a of [...model.threads(), ...model.drafts()].filter((item) => item.page === index).map(withPreview)) {
    const drawer = DRAWERS[a.kind];
    if (drawer && a.id !== editingId) {
      const [layerKey, paint] = drawer;
      const node = paint(a, viewport);
      node.classList.toggle("pdf-draft", draftIds.has(a.id));
      if (layerKey === "ui") {
        addHtml(node);
      } else {
        layers[layerKey].append(node);
      }
      if (a.kind === "note" && !draftIds.has(a.id)) {
        addNoteBadge(node, a, a.id === selected);
      }
    }
    if (a.id === selected || a.id === hoveredId) {
      addHtml(...frameNodes(a, viewport, a.id === selected));
    }
  }
}

/** Mark a note icon selected and badge it: review status first (a closed thread's note fades), else reply count, else the user's checkmark. */
function addNoteBadge(node, note, selected) {
  node.classList.toggle("selected", selected);
  const status = model.reviewStatus(note.id);
  node.classList.toggle("pdf-closed", isClosed(status));
  const replyCount = model.replies(note.id).length;
  if (status) {
    node.insertAdjacentHTML("beforeend", badgeHtml(status));
  } else if (replyCount) {
    node.append(h("span", { className: "pdf-reply-count" }, String(replyCount)));
  } else if (model.checkedByMe(note.id)) {
    node.insertAdjacentHTML("beforeend", `<span class="pdf-status-badge" data-status="Marked" title="Checked by you">${ICON.check}</span>`);
  }
}

/** The box around an annotation's geometry, as fractions (0..1) of its page. */
export function fracBox(a, viewport = baseViewport(a.page)) {
  if (!viewport) {
    return undefined;
  }
  const [x1, y1, x2, y2] = bbox(outlinePoints(a));
  const corners = [[x1, y1], [x2, y2], [x1, y2], [x2, y1]];
  return bbox(corners.flatMap(([x, y]) => toFrac(viewport, x, y)));
}

/** The outline of a hovered or selected annotation; selected and editable ones also get handles. */
function frameNodes(a, viewport, selected) {
  if (a.kind === "note") {
    return [];
  }
  const [x1, y1, x2, y2] = fracBox(a, viewport);
  const frame = h("div", { className: `pdf-outline${selected ? " selected" : ""}`, dataset: { id: a.id } });
  Object.assign(frame.style, { left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` });
  if (!selected || model.readOnlyReason()) {
    return [frame];
  }
  const handle = (name, fx, fy) => {
    const node = h("div", { className: "pdf-handle", dataset: { handle: name, id: a.id } });
    Object.assign(node.style, { left: `${fx * 100}%`, top: `${fy * 100}%` });
    return node;
  };
  const mode = resizeMode(a);
  if (mode === "ends") {
    const [lx1, ly1, lx2, ly2] = a.line;
    return [frame, handle("start", ...toFrac(viewport, lx1, ly1)), handle("end", ...toFrac(viewport, lx2, ly2))];
  }
  if (mode === "box") {
    frame.classList.add("movable");
    return [frame, handle("nw", x1, y1), handle("ne", x2, y1), handle("sw", x1, y2), handle("se", x2, y2)];
  }
  return [frame];
}

/** Frame the annotation under the pointer (`null` for none), redrawing the pages involved. */
export function setHovered(id) {
  if (hoveredId !== id) {
    const pages = new Set([model.find(hoveredId)?.page, model.find(id)?.page]);
    hoveredId = id;
    pages.forEach((page) => page !== undefined && redraw(page));
  }
}

/** Show a patch on an annotation without committing it; `null` drops it again. */
export function preview(id, patch) {
  if (patch) {
    livePatches.set(id, patch);
  } else {
    livePatches.delete(id);
  }
  const page = model.find(id)?.page;
  if (page !== undefined) {
    redraw(page);
  }
}

// --- Geometry queries ------------------------------------------------------------------

/** A client point as `{ page, x, y, box, perPixel }`: PDF coordinates, the page layer's client box, PDF units per CSS pixel. */
function locate(page, box, clientX, clientY) {
  const viewport = baseViewport(page);
  const [x, y] = fromFrac(viewport, (clientX - box.left) / box.width, (clientY - box.top) / box.height);
  return { page, x, y, box, perPixel: viewport.width / box.width };
}

/** The page under a client point, located as above. */
export function pageAt(clientX, clientY) {
  for (const [page, layers] of pageLayers) {
    const box = layers.ui.getBoundingClientRect();
    if (box.width > 0 && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) {
      return locate(page, box, clientX, clientY);
    }
  }
  return undefined;
}

/** Like `pageAt`, but off the pages too: the nearest page within `reach` CSS pixels (drawings can stick out past the edge). */
export function pageNear(clientX, clientY, reach = 400) {
  let nearest;
  for (const [page, layers] of pageLayers) {
    const box = layers.ui.getBoundingClientRect();
    const distance = Math.hypot(Math.max(box.left - clientX, 0, clientX - box.right), Math.max(box.top - clientY, 0, clientY - box.bottom));
    if (box.width > 0 && distance <= reach && (!nearest || distance < nearest.distance)) {
      nearest = { page, box, distance };
    }
  }
  return nearest && locate(nearest.page, nearest.box, clientX, clientY);
}

/** Like `pageAt` but for a known page, and also off the page (drags continue past its edge). */
export function toPdfPoint(page, clientX, clientY) {
  return locate(page, pageLayers.get(page)?.ui.getBoundingClientRect(), clientX, clientY);
}

/** The topmost thread root at a point from `pageAt` (never a note icon), with 4 CSS pixels of slack; the stable sort keeps the newest of equal ranks last. */
export function topmostAt(point) {
  const picked = model.threads().map(withPreview).filter((a) => a.page === point.page && hitTest(a, point.x, point.y, 4 * point.perPixel));
  return picked.sort((a, b) => stackRank(a) - stackRank(b)).at(-1);
}

export function screenBox(a) {
  const ui = pageLayers.get(a.page)?.ui;
  const icon = a.kind === "note" && ui?.querySelector(`.pdf-note[data-id="${CSS.escape(a.id)}"]`);
  if (icon) {
    return icon.getBoundingClientRect();
  }
  const box = ui && fracBox(a);
  if (!box) {
    return undefined;
  }
  const page = ui.getBoundingClientRect();
  return new DOMRect(page.left + box[0] * page.width, page.top + box[1] * page.height, (box[2] - box[0]) * page.width, (box[3] - box[1]) * page.height);
}

// --- Saving as a picture ---------------------------------------------------------------

/** Drawings, lines, shapes and pictures can be saved as PNG; signatures are drawings or pictures too. */
export const canExport = (a) => ["ink", "line", "square", "circle", "image"].includes(a.kind);

/** Drawings are saved at 4 pixels per point (288 dpi), pictures at their own resolution; either at most this many pixels a side. */
const EXPORT_SCALE = 4;
const MAX_EXPORT_SIDE = 4096;

/**
 * A drawing, shape, picture or signature as PNG bytes, drawn as on screen and turned as its page is shown, cropped to
 * it (with room for the pen and arrowheads) on a transparent background.
 */
export async function annotationPng(a) {
  const viewport = baseViewport(a.page);
  const isImage = a.kind === "image";
  // The pen reaches half its width past the points, an arrowhead's barbs half their length (drawLine) to the side.
  const pen = a.width ?? 1;
  const reach = isImage ? 0 : pen / 2 + (a.arrow ? Math.max(6, pen * 4) / 2 : 0);
  const [fx1, fy1, fx2, fy2] = fracBox(a, viewport);
  const box = [fx1 * viewport.width - reach, fy1 * viewport.height - reach, (fx2 - fx1) * viewport.width + 2 * reach, (fy2 - fy1) * viewport.height + 2 * reach];
  const fit = MAX_EXPORT_SIDE / Math.max(box[2], box[3]);
  const [rw, rh] = [a.rect[2] - a.rect[0], a.rect[3] - a.rect[1]];
  const drawingScale = Math.min(EXPORT_SCALE, fit);
  const picture = await loadImage(isImage ? a.image : drawingSvg(a, viewport, box, drawingScale));
  const scale = isImage ? Math.min(picture.naturalWidth / rw, fit) : drawingScale;
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(box[2] * scale)), height: Math.max(1, Math.round(box[3] * scale)) });
  const context = canvas.getContext("2d");
  if (isImage) {
    context.globalAlpha = a.opacity ?? 1;
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((viewport.rotation * Math.PI) / 180);
    context.drawImage(picture, (-rw * scale) / 2, (-rh * scale) / 2, rw * scale, rh * scale);
  } else {
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** A drawing alone in an SVG of `box` (viewport units), `scale` pixels per unit, as a data URL. */
function drawingSvg(a, viewport, [x, y, width, height], scale) {
  const root = svg("svg", { viewBox: `${x} ${y} ${width} ${height}`, width: width * scale, height: height * scale });
  root.append(DRAWERS[a.kind][1](a, viewport));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Scroll the viewer to an annotation, with a little room above its top edge. */
export function scrollToThread(a) {
  const [, , , top] = bbox(outlinePoints(a));
  pdfViewer()?.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: "XYZ" }, null, top + 60, null], allowNegativeOffset: true });
}

// Redraw on model changes. A draft change only touches the pages its drafts are on now or were on before.
let draftPages = new Set();
model.onChange((reason) => {
  if (reason !== "draft") {
    redrawAll();
    return;
  }
  const pages = new Set(model.drafts().map((a) => a.page));
  [...draftPages, ...pages].forEach(redraw);
  draftPages = pages;
});

/**
 * A strikethrough's quads moved so that their middle, where the line is drawn, is the middle of the lowercase letters
 * as rendered: the band of rows where the page canvas under each quad is darkest. Fonts differ too much (the small
 * letters of a LaTeX paper are much shorter than a heading's) for any fixed share of the line to fit them all.
 */
export function centreOnLetters(page, quads) {
  const canvas = pageView(page)?.canvas;
  const viewport = baseViewport(page);
  if (!canvas?.width || !viewport) {
    return quads;
  }
  const out = [...quads];
  for (let i = 0; i + 8 <= quads.length; i += 8) {
    const corners = [0, 2, 4, 6].map((j) => toFrac(viewport, quads[i + j], quads[i + j + 1]).map((f, k) => f * (k ? canvas.height : canvas.width)));
    const [x1, y1, x2, y2] = bbox(corners.flat());
    // Only text running across the canvas (a page turned a quarter has its lines running down it).
    if (Math.abs(corners[1][0] - corners[0][0]) < Math.abs(corners[1][1] - corners[0][1]) || y2 - y1 < 4) {
      continue;
    }
    let pixels;
    const [left, top] = [Math.round(x1), Math.round(y1)];
    try {
      pixels = canvas.getContext("2d").getImageData(left, top, Math.max(1, Math.round(x2) - left), Math.max(1, Math.round(y2) - top));
    } catch {
      continue;
    }
    const ink = Array.from({ length: pixels.height }, (_, row) => {
      let count = 0;
      for (let col = 0; col < pixels.width; col++) {
        const at = (row * pixels.width + col) * 4;
        count += pixels.data[at + 3] > 128 && 0.299 * pixels.data[at] + 0.587 * pixels.data[at + 1] + 0.114 * pixels.data[at + 2] < 140 ? 1 : 0;
      }
      return count;
    });
    const peak = Math.max(...ink);
    const band = ink.flatMap((count, row) => (count >= peak * 0.4 ? [row] : []));
    if (!peak || !band.length) {
      continue;
    }
    // The band's middle against the quad's own (canvas rows), at most a fifth of the line away.
    const shift = Math.max(-0.2 * (y2 - y1), Math.min(0.2 * (y2 - y1), top + (band[0] + band.at(-1) + 1) / 2 - (y1 + y2) / 2));
    const [mx, my] = [(x1 + x2) / 2 / canvas.width, (y1 + y2) / 2 / canvas.height];
    const [fromX, fromY] = fromFrac(viewport, mx, my);
    const [toX, toY] = fromFrac(viewport, mx, my + shift / canvas.height);
    for (let j = 0; j < 8; j += 2) {
      out[i + j] = Math.round((quads[i + j] + toX - fromX) * 1000) / 1000;
      out[i + j + 1] = Math.round((quads[i + j + 1] + toY - fromY) * 1000) / 1000;
    }
  }
  return out;
}
