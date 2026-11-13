/**
 * The annotation toolbar in pdf.js's top bar, Acrobat-style: grouped tool buttons whose dropdowns hold
 * the variants, style and "keep selected", then color, sticky note and comments; plus the style panel.
 */
import * as model from "./annotations.mjs";
import { markSelection, snapshotSelection } from "./commands.mjs";
import { ICON, h, hexToRgb, iconNode, pdfApp, recentColors, rememberColor, rgbToHex } from "./core.mjs";
import { bbox, markStrokes } from "./geometry.mjs";
import { askSignature, commitTextBox, isTyping, pickPicture, storedSignature } from "./insert.mjs";
import { LINE_HEIGHT, fontStack, preview, verticalColumns } from "./layers.mjs";
import { setupSidebar, toggleSidebar } from "./sidebar.mjs";
import { FONT_FAMILIES, FONT_SIZES, MARK_STYLES, MARK_WIDTHS, STROKE_WIDTHS, TEXT_MARKS, TOOL_GROUPS, activeTool, chooseTool, isSticky, lastInGroup, lastStyledTool, onToolChange, paletteFor, setSticky, setToolStyle, toolStyle } from "./tools.mjs";
import { closeMenu, openPopover } from "./ui.mjs";

// --- Toolbar -------------------------------------------------------------------------

const TOOL_LABELS = {
  select: "Select",
  hand: "Hand (pan)",
  note: "Add sticky note",
  freetext: "Add text box",
  image: "Add image",
  highlight: "Highlight text",
  underline: "Underline text",
  strikeout: "Strikethrough text",
  squiggly: "Squiggly underline",
  ink: "Draw freehand",
  line: "Draw line",
  arrow: "Draw arrow",
  square: "Draw rectangle",
  circle: "Draw oval",
  signature: "Sign",
  check: "Add checkmark",
  cross: "Add cross",
  dot: "Add dot",
};
const GROUP_LABELS = { cursor: "Select or pan", markup: "Text markup", draw: "Drawing tools", insert: "Text, image and signature" };
/** pdf.js's id for its grab-to-pan cursor tool (0 is its text select tool). */
const PDFJS_HAND = 1;
/** One button covers Select and Hand; it shows the hand icon only while panning is active. */
const BUTTON_GROUPS = { cursor: ["select", "hand"], ...TOOL_GROUPS };

/** Buttons whose icon and pressed state follow the active tool. */
const trackedButtons = [];
let colorButton;

/** Build the toolbar into pdf.js's right-hand toolbar area and keep it in step with tools and model. */
export function setupToolbar() {
  colorButton = barButton(`<i class="pdf-color-dot"></i>`, "Color and properties", () => {
    // A text box being typed in is saved (and selected) first, so the panel edits that box.
    if (isTyping()) {
      commitTextBox();
    }
    const box = colorButton.getBoundingClientRect();
    openStylePanel(styleTarget(), box.left - 120, box.bottom + 4);
  }, { id: "pdfProperties" });
  const commentsButton = barButton(ICON.comments, "Comments panel", () => toggleSidebar(), { id: "pdfCommentsToggle", "aria-expanded": "false", dataset: { always: "" } });
  const toolbar = h(
    "div",
    { id: "pdfToolbar", className: "toolbarHorizontalGroup", role: "toolbar", "aria-label": "Annotation tools" },
    groupButton("cursor", true),
    h("div", { className: "verticalToolbarSeparator pdf-cursor-separator" }),
    groupButton("markup"),
    groupButton("draw"),
    groupButton("insert"),
    colorButton,
    h("div", { className: "verticalToolbarSeparator" }),
    toolButton("note"),
    commentsButton,
  );
  document.getElementById("toolbarViewerRight").prepend(toolbar);
  const collapsible = [colorButton, ...toolbar.querySelectorAll(':scope > .pdf-split:has([data-group="cursor"]), .pdf-cursor-separator')];
  // Refit when the bar resizes and when pdf.js's own groups widen after load (page count, zoom names); the right
  // group, which collapsing narrows, is left out so that refitting cannot trigger itself.
  const refit = new ResizeObserver(() => collapseToFit(collapsible));
  ["toolbarContainer", "toolbarViewerLeft", "toolbarViewerMiddle"].map((id) => document.getElementById(id)).filter(Boolean).forEach((node) => refit.observe(node));
  setupSidebar(commentsButton);
  onToolChange(refresh);
  // pdf.js can also turn its hand tool on or off by itself (its secondary menu, its own H key).
  pdfApp().eventBus.on("cursortoolchanged", ({ tool: cursor }) => {
    if ((cursor === PDFJS_HAND) !== (activeTool() === "hand")) {
      chooseTool(cursor === PDFJS_HAND ? "hand" : "select");
    }
  });
  model.onChange((reason) => {
    if (reason === "load" || reason === "select" || reason === "edit" || reason === "replace") {
      refresh();
    }
  });
  refresh();
}

/** The tool a group's button stands for: the active tool when it is in the group, else the group's last used one. */
function groupFace(group) {
  if (group === "cursor") {
    return activeTool() === "hand" ? "hand" : "select";
  }
  return BUTTON_GROUPS[group].includes(activeTool()) ? activeTool() : (lastInGroup(group) ?? BUTTON_GROUPS[group][0]);
}

/** Switch a tool on; unlike chooseTool, never toggles the active tool off. */
const turnOn = (name) => activeTool() !== name && chooseTool(name);

function barButton(svg, title, onclick, extra) {
  const node = iconNode("button", svg, { type: "button", className: "toolbarButton pdf-tool-button", title, "aria-label": title, onclick, ...extra });
  // Pressing the button must not clear the text selection: the markup tools act on it.
  node.addEventListener("mousedown", (event) => event.preventDefault());
  return node;
}

/** A group's main button (its current tool) plus the chevron that opens the group's dropdown. */
function groupButton(group, always = false) {
  const flags = always ? { always: "" } : {};
  const main = barButton("", "", () => useTool(main.dataset.tool), { "aria-pressed": "false", dataset: { tool: groupFace(group), group, ...flags } });
  trackedButtons.push(main);
  const chevron = barButton(ICON.chevron, `${GROUP_LABELS[group]} options`, () => openGroupMenu(group, main), { className: "toolbarButton pdf-tool-button pdf-chevron", "aria-haspopup": "dialog", dataset: flags });
  return h("div", { className: "pdf-split" }, main, chevron);
}

function toolButton(name) {
  const node = barButton(ICON[name], TOOL_LABELS[name], () => useTool(name), { "aria-pressed": "false", dataset: { tool: name } });
  trackedButtons.push(node);
  return node;
}

/** Markup tools mark the current text selection at once; the image and signature tools need their content first. */
async function useTool(name) {
  const selection = TEXT_MARKS.includes(name) ? snapshotSelection() : undefined;
  if (selection) {
    markSelection(name, selection);
  } else if (name === "image" || (name === "signature" && !storedSignature())) {
    if (await (name === "image" ? pickPicture() : askSignature())) {
      turnOn(name);
    }
  } else {
    chooseTool(name);
  }
}

/** A group's dropdown: its variants, the shown tool's style, and the keep-selected switch (or the key hint). */
function openGroupMenu(group, anchor) {
  // A text box being typed in is saved (and selected) first, so the dropdown can edit it.
  if (isTyping()) {
    commitTextBox();
  }
  const holder = h("div", { className: "pdf-tool-dropdown", "aria-label": GROUP_LABELS[group] });
  const render = () => {
    const shown = groupFace(group);
    const sticky = h("input", { type: "checkbox", role: "switch", className: "pdf-switch", checked: isSticky(shown), onchange: () => setSticky(shown, sticky.checked) });
    holder.replaceChildren(
      ...[
        BUTTON_GROUPS[group].length > 1 && variantRow(group, shown, render),
        toolStyle(shown) && stylePanel(selectedOf(shown) ?? { tool: shown }),
        shown === "signature" && h("button", { type: "button", className: "pdf-link-button", onclick: async () => (closeMenu(), (await askSignature()) && turnOn("signature")) }, storedSignature() ? "Change signature…" : "Create signature…"),
        group === "cursor"
          ? h("div", { className: "pdf-hint" }, "Keys: S selects, H pans.")
          : h("label", { className: "pdf-keep-tool" }, h("span", {}, "Keep tool selected"), sticky),
      ].filter(Boolean),
    );
  };
  render();
  const box = anchor.getBoundingClientRect();
  openPopover(holder, box.left - 40, box.bottom + 4);
}

function variantRow(group, shown, rerender) {
  return h(
    "div",
    { className: "pdf-variants", role: "group", "aria-label": GROUP_LABELS[group] },
    BUTTON_GROUPS[group].map((name) =>
      iconNode("button", ICON[name], {
        type: "button",
        className: `pdf-icon-button${name === shown ? " selected" : ""}`,
        title: TOOL_LABELS[name],
        "aria-label": TOOL_LABELS[name],
        "aria-pressed": String(name === activeTool()),
        onmousedown: (event) => event.preventDefault(),
        onclick: async () => {
          // Clicking the active variant does nothing, except Image, which asks for another file.
          if (name !== activeTool() || name === "image") {
            await useTool(name);
          }
          rerender();
        },
      }),
    ),
  );
}

/** The tool an annotation is made with: its kind, an arrow for an arrowed line, a Fill & Sign mark by its subject. */
const toolNameOf = (a) => (a.kind === "line" && a.arrow ? "arrow" : (a.kind !== "image" && TOOL_OF_SUBJECT[a.subject]) || a.kind);

/**
 * The selected annotation, as a style target, when it is editable and made with `tool` and Select is on: a tool's
 * dropdown then edits it, as in Acrobat. Once the tool itself is picked, the dropdown edits the tool's style again.
 */
function selectedOf(tool) {
  const selected = activeTool() === "select" && model.find(model.selectedId());
  return selected && !model.readOnlyReason() && toolNameOf(selected) === tool ? { id: selected.id } : undefined;
}

/** What the color button edits: an editable selected annotation, else the active tool's style (or that of the tool used last). */
function styleTarget() {
  const selected = model.find(model.selectedId());
  if (selected && selected.kind !== "other" && !model.readOnlyReason()) {
    return { id: selected.id };
  }
  const current = activeTool();
  return { tool: toolStyle(current) ? current : lastStyledTool() };
}

/** Bring buttons, the color dot, the viewer's tool classes and pdf.js's cursor tool in line with the active tool. */
function refresh() {
  const readOnly = Boolean(model.readOnlyReason());
  const current = activeTool();
  for (const node of trackedButtons) {
    const { group } = node.dataset;
    if (group) {
      node.dataset.tool = groupFace(group);
      node.innerHTML = ICON[node.dataset.tool];
      node.title = TOOL_LABELS[node.dataset.tool];
      node.setAttribute("aria-label", node.title);
    }
    const pressed = node.dataset.tool === current;
    node.classList.toggle("toggled", pressed);
    node.setAttribute("aria-pressed", String(pressed));
  }
  document.querySelectorAll("#pdfToolbar .pdf-tool-button:not([data-always])").forEach((node) => {
    node.disabled = readOnly;
  });
  const target = styleTarget();
  const color = target.id ? (rgbToHex(model.find(target.id).color) ?? "transparent") : toolStyle(target.tool).color;
  colorButton.style.setProperty("--pdf-swatch", color);
  const viewerContainer = document.getElementById("viewerContainer");
  for (const name of Object.keys(TOOL_LABELS)) {
    viewerContainer?.classList.toggle(`pdf-tool-${name}`, current === name);
  }
  const { pdfCursorTools, eventBus } = pdfApp();
  if ((current === "hand") !== (pdfCursorTools?.activeTool === PDFJS_HAND)) {
    eventBus.dispatch("switchcursortool", { source: null, tool: current === "hand" ? PDFJS_HAND : 0 });
  }
}

/** On a narrow editor, hide optional controls until the top bar fits: first the color button (its panel is also in every dropdown and the object bar), then Select/Hand (the S and H keys remain). */
function collapseToFit(collapsible) {
  const bar = document.getElementById("toolbarContainer");
  collapsible.forEach((node) => node.classList.remove("pdf-collapsed"));
  for (const node of collapsible) {
    if (bar.scrollWidth <= bar.clientWidth) {
      break;
    }
    node.classList.add("pdf-collapsed");
  }
}

// --- Style panel -----------------------------------------------------------------------
// The same controls edit a tool's defaults (`{ tool }`) and an existing annotation (`{ id }`).

const HAS_WIDTH = new Set(["ink", "line", "arrow", "square", "circle", "signature", "check", "cross", "underline", "strikeout", "squiggly"]);
const HAS_OPACITY = new Set(["ink", "highlight", "underline", "strikeout", "squiggly", "image", "square", "circle", "line", "arrow", "freetext"]);
const HAS_FILL = new Set(["square", "circle"]);
const STYLE_NAMES = { swoosh: "Hand-drawn", classic: "Classic", boxed: "In a box", solid: "Solid", ring: "Ring" };

/** The style panel for `{ tool }` or `{ id }`; it rebuilds itself after every change. */
export function stylePanel(target) {
  const holder = h("div", { className: "pdf-properties-holder" });
  // What stays open across rebuilds of this panel.
  const view = { fontList: false };
  const render = () => {
    // The annotation may be gone by now (deleted, undone).
    if (target.id && !model.find(target.id)) {
      holder.replaceChildren();
      return;
    }
    const source = styleSource(target);
    const apply = (change) => {
      source.set(change);
      render();
    };
    holder.replaceChildren(h("div", { className: "pdf-properties", role: "group", "aria-label": "Properties" }, styleSections(source, apply, view)));
    requestAnimationFrame(() => alignSwatches(holder));
  };
  render();
  return holder;
}

/** Show the style panel as a popover at a screen point (not for a missing annotation or a read-only file). */
export function openStylePanel(target, x, y) {
  if (target.id && (!model.find(target.id) || model.readOnlyReason())) {
    return;
  }
  openPopover(stylePanel(target), x, y);
}

/** The values to show and a writer for them, for a tool's style or an annotation. */
function styleSource(target) {
  if (target.tool) {
    const style = toolStyle(target.tool);
    return {
      name: target.tool,
      ...style,
      opacity: style.opacity ?? 1,
      // Only tools have a mark style: it shapes a check, cross or dot when it is placed.
      markStyle: style.style,
      // Tool styles store colors as hex, annotations as RGB fractions.
      set: (change) => setToolStyle(target.tool, Object.fromEntries(Object.entries(change).map(([key, value]) => [key, key === "color" ? rgbToHex(value) : value]))),
    };
  }
  const annotation = model.find(target.id);
  const name = toolNameOf(annotation);
  return {
    name,
    color: rgbToHex(annotation.color) ?? "#000000",
    width: annotation.width,
    opacity: annotation.opacity ?? 1,
    font: annotation.font,
    align: annotation.align,
    vertical: annotation.vertical,
    fill: name === "dot" ? undefined : annotation.fill,
    // A dot's style shows in its fill; a placed check or cross keeps no record of its style.
    markStyle: name === "dot" ? (annotation.fill ? "solid" : "ring") : undefined,
    // Shown on the page while a slider is dragged, saved when it is let go.
    preview: (change) => preview(annotation.id, change),
    set: (change) => {
      preview(annotation.id, null);
      model.patch(annotation.id, annotationChange(annotation, name, change), "Change Properties");
    },
  };
}

/** Fill & Sign marks are drawings with Acrobat's subjects; their panel is their tool's. */
const TOOL_OF_SUBJECT = { Checkmark: "check", Cross: "cross", Dot: "dot", Signature: "signature" };

/** A panel change as an annotation patch: turning a text box resizes it for its new direction, a new style redraws a check or cross in its square or fills or empties a dot, and recoloring a solid dot refills it. */
function annotationChange(annotation, name, { style, ...change }) {
  // Changing a text box's direction keeps its top-left corner: its lines' length becomes the columns' length, and a
  // vertical box gets as many columns as its text needs (a horizontal one regrows when next edited).
  if ("vertical" in change && Boolean(change.vertical) !== Boolean(annotation.vertical)) {
    const [x1, y1, x2, y2] = annotation.rect;
    if (!change.vertical) {
      return { ...change, rect: [x1, y2 - (x2 - x1), x1 + (y2 - y1), y2] };
    }
    const tall = { ...annotation, rect: [x1, y2 - (x2 - x1), x2, y2] };
    const columns = Math.max(1, verticalColumns(tall).length);
    return { ...change, rect: [x1, y2 - (x2 - x1), x1 + columns * (annotation.font?.size ?? 12) * LINE_HEIGHT + 4, y2] };
  }
  if (style && name === "dot") {
    return { ...change, fill: style === "solid" ? annotation.color : undefined };
  }
  if (style) {
    const [x1, y1, x2, y2] = bbox(annotation.ink.flat());
    const ink = markStrokes(name, style, (x1 + x2) / 2, (y1 + y2) / 2, Math.max(x2 - x1, y2 - y1) / 2);
    return { ...change, ink, rect: bbox(ink.flat()) };
  }
  return name === "dot" && annotation.fill && change.color ? { ...change, fill: change.color } : change;
}

/** The panel's sections for what the kind supports; a picture has no color, only an opacity. */
function styleSections(source, apply, view) {
  const { name, color } = source;
  const palette = paletteFor(name);
  const presets = new Set(palette.map((p) => p.color));
  const recent = recentColors().filter((c) => !presets.has(c));
  const colored = name !== "image";
  return [
    colored && colorSection(source, palette, presets, recent, apply),
    colored && recent.length > 0 && propSection("Recent", ...recent.map((c) => swatch(c, c === color, () => apply({ color: hexToRgb(c) }), c))),
    HAS_FILL.has(name) &&
      propSection(
        "Fill",
        swatch("none", !source.fill, () => apply({ fill: undefined }), "No fill"),
        ...palette.map((p) => swatch(p.color, rgbToHex(source.fill) === p.color, () => apply({ fill: hexToRgb(p.color) }), p.name)),
      ),
    MARK_STYLES[name] && markStyleSection(name, source, apply),
    HAS_WIDTH.has(name) && widthSection(source, apply),
    HAS_OPACITY.has(name) && opacitySection(source, apply),
    name === "freetext" && fontSection(source.font, apply, view),
    name === "freetext" && textLayoutSection(source, apply),
  ];
}

/**
 * How a text box sets its text, in one row: alignment along the lines (left, centre, right; for vertical text:
 * top, middle, bottom), then horizontal or vertical text (upright letters stacked top to bottom).
 */
function textLayoutSection({ align = "left", vertical }, apply) {
  const chip = (icon, label, selected, onclick) => iconNode("button", icon, { type: "button", className: `pdf-chip pdf-align${selected ? " selected" : ""}`, title: label, "aria-label": label, "aria-pressed": String(selected), onclick });
  const alignments = vertical
    ? [["left", "Align top", ICON.alignLeft], ["center", "Middle", ICON.alignCenter], ["right", "Align bottom", ICON.alignRight]]
    : [["left", "Align left", ICON.alignLeft], ["center", "Center", ICON.alignCenter], ["right", "Align right", ICON.alignRight]];
  return propSection(
    "Text",
    ...alignments.map(([value, label, icon]) => chip(vertical ? `<span class="pdf-turned">${icon}</span>` : icon, label, align === value, () => apply({ align: value === "left" ? undefined : value }))),
    h("span", { className: "pdf-prop-divider", "aria-hidden": "true" }),
    chip(ICON.horizontal, "Horizontal text", !vertical, () => apply({ vertical: undefined })),
    chip(ICON.vertical, "Vertical text", Boolean(vertical), () => apply({ vertical: true })),
  );
}

/** Line widths as samples (text marks have finer ones, drawn twice as thick so they can be told apart). */
function widthSection({ name, width }, apply) {
  const textMark = TEXT_MARKS.includes(name);
  const chip = (w) => {
    const sample = h("span", { className: "pdf-width-sample", style: { height: `${Math.min(8, Math.max(1, Math.round(textMark ? w * 2 : w)))}px` } });
    return h("button", { type: "button", className: `pdf-chip${width === w ? " selected" : ""}`, title: `${w} pt`, "aria-label": `${w} pt`, "aria-pressed": String(width === w), onclick: () => apply({ width: w }) }, sample);
  };
  return propSection("Thickness", ...(textMark ? MARK_WIDTHS : STROKE_WIDTHS).map(chip));
}

/** A check, cross or dot drawn as an icon from the same strokes the tool places (SVG y runs down). */
function markIcon(name, style) {
  if (name === "dot") {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${style === "ring" ? 4.5 : 4}" fill="${style === "ring" ? "none" : "currentColor"}" stroke="currentColor" stroke-width="1.6"/></svg>`;
  }
  const paths = markStrokes(name, style, 8, 8, 5.5).map((flat) => `M${flat.map((v, i) => (i % 2 ? 16 - v : v)).join(" ")}`);
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${paths.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function markStyleSection(name, { markStyle }, apply) {
  return propSection(
    "Style",
    ...MARK_STYLES[name].map((style) =>
      iconNode("button", markIcon(name, style), { type: "button", className: `pdf-chip pdf-mark-style${markStyle === style ? " selected" : ""}`, title: STYLE_NAMES[style], "aria-label": STYLE_NAMES[style], "aria-pressed": String(markStyle === style), onclick: () => apply({ style }) }),
    ),
  );
}

function colorSection({ name, color }, palette, presets, recent, apply) {
  const picker = h("input", { type: "color", className: "pdf-custom-color", value: color.toLowerCase(), title: "Custom color", "aria-label": "Custom color" });
  picker.addEventListener("change", () => {
    const hex = picker.value.toUpperCase();
    rememberColor(hex);
    apply({ color: hexToRgb(hex) });
  });
  const isCustom = !presets.has(color) && !recent.includes(color);
  return propSection(
    name === "freetext" ? "Text color" : "Color",
    ...palette.map((p) => swatch(p.color, p.color === color, () => apply({ color: hexToRgb(p.color) }), p.name)),
    (() => {
      const label = h("label", { className: "pdf-swatch custom", title: "Custom color", dataset: { fill: isCustom ? color : "rainbow" }, style: { background: swatchBackground(isCustom ? color : "rainbow", isCustom) } }, picker);
      return label;
    })(),
  );
}

/** The opacity slider: the page follows it while dragging (`preview`) and the change is saved on release. */
function opacitySection({ opacity, preview: show }, apply) {
  const value = h("span", { className: "pdf-prop-value" });
  const slider = h("input", { type: "range", className: "pdf-range", min: "10", max: "100", step: "5", value: String(Math.round(opacity * 100)), "aria-label": "Opacity" });
  const paint = () => {
    value.textContent = `${slider.value}%`;
    slider.style.setProperty("--pdf-fill", `${((Number(slider.value) - 10) / 90) * 100}%`);
  };
  slider.addEventListener("input", () => {
    paint();
    show?.({ opacity: Number(slider.value) / 100 });
  });
  slider.addEventListener("change", () => apply({ opacity: Number(slider.value) / 100 }));
  paint();
  return propSection("Opacity", slider, value);
}

/**
 * Family (a list showing each font in itself) and size; bold and italic are in the text box's format bar. The list
 * stays open while other settings change (`view.fontList`), and closes once a font is picked.
 */
function fontSection(current, apply, view) {
  const font = current ?? { family: "Helvetica", size: 12 };
  const setFont = (change) => apply({ font: { ...font, ...change } });
  const pick = (family) => {
    view.fontList = false;
    setFont({ family });
  };
  const list = h(
    "div",
    { className: "pdf-font-list", role: "listbox", "aria-label": "Font family", hidden: !view.fontList },
    FONT_FAMILIES.map((family) =>
      h("button", { type: "button", role: "option", className: `pdf-font-option${family === font.family ? " selected" : ""}`, "aria-selected": String(family === font.family), style: { fontFamily: fontStack(family) }, onclick: () => pick(family) }, family),
    ),
  );
  const show = () => {
    list.hidden = !view.fontList;
    picker.setAttribute("aria-expanded", String(view.fontList));
    if (view.fontList) {
      requestAnimationFrame(() => list.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
    }
  };
  const toggle = () => {
    view.fontList = !view.fontList;
    show();
  };
  const picker = iconNode("button", ICON.chevron, { type: "button", className: "pdf-font-picker", title: "Font family", "aria-haspopup": "listbox", "aria-expanded": "false", style: { fontFamily: fontStack(font.family) }, onclick: toggle });
  show();
  picker.prepend(h("span", {}, font.family));
  return propSection("Font", picker, choiceList(FONT_SIZES, font.size, (size) => setFont({ size: Number(size) }), "Font size"), list);
}

const swatch = (color, selected, onclick, title) =>
  h("button", { type: "button", className: `pdf-swatch${selected ? " selected" : ""}`, title, "aria-label": title, "aria-pressed": String(selected), onclick, dataset: { fill: color }, style: { background: swatchBackground(color, selected) } });

/**
 * Put every swatch's box on whole screen pixels. Laid out at a fractional zoom (say 31 CSS px apart at 150%, 46.5
 * screen pixels) every other swatch would start half a pixel off the grid and be drawn a pixel narrower on one side,
 * so its ring looked off-centre while its neighbours' did not. Sizes are rounded to whole pixels and each box is
 * shifted by the fraction it is off (a layout offset, not a transform, so nothing is resampled).
 */
function alignSwatches(root) {
  const ratio = devicePixelRatio;
  const whole = (css) => `${Math.round(css * ratio) / ratio}px`;
  const offGrid = (v) => (Math.round(v * ratio) - v * ratio) / ratio;
  const swatches = [...root.querySelectorAll(".pdf-swatch")];
  // All sizes first: a size change can move the row, and with it swatches already placed.
  for (const swatch of swatches) {
    Object.assign(swatch.style, { width: whole(28), height: whole(28), left: "0px", top: "0px" });
  }
  // Layout rounds to 1/64 px, so a second pass takes up what the first left over.
  for (let pass = 0; pass < 2; pass++) {
    for (const swatch of swatches) {
      const box = swatch.getBoundingClientRect();
      Object.assign(swatch.style, { left: `${parseFloat(swatch.style.left) + offGrid(box.left)}px`, top: `${parseFloat(swatch.style.top) + offGrid(box.top)}px` });
    }
  }
}

/**
 * A swatch as three flat colors in one radial gradient around the element's own centre: the color (radius 8.75 px),
 * a gap in the panel's background color, and, when chosen, a ring (10.25 to 11.75 px), then background again. Each
 * boundary fades over half a pixel (the anti-aliasing). The box is larger than the drawing (see the stylesheet). The
 * wheel (custom color) and the slash ("No fill") take the color's place.
 *
 * The ring has the swatch's own color (the text color for "No fill"). A light-blue ring around a red or purple dot
 * looked unevenly spaced although the pixels were exactly concentric: screens light red and blue from different
 * sub-pixels and the eye focuses them differently, so the two seem shifted against each other. With the dot and the
 * ring in one color, whatever happens to that color happens to both.
 */
function swatchBackground(fill, selected) {
  const ground = "var(--pdf-surface)";
  const ring = fill === "none" || fill === "rainbow" ? "var(--pdf-text)" : fill;
  const around = selected ? `${ground} 9px, ${ground} 10px, ${ring} 10.5px, ${ring} 11.5px, ${ground} 12px` : `${ground} 9px`;
  if (fill === "rainbow" || fill === "none") {
    const inside = fill === "rainbow" ? "conic-gradient(hsl(0 95% 55%), hsl(60 95% 55%), hsl(120 95% 55%), hsl(180 95% 55%), hsl(240 95% 55%), hsl(300 95% 55%), hsl(360 95% 55%))" : `linear-gradient(135deg, ${ground} 46%, #d33 46% 54%, ${ground} 54%)`;
    return `radial-gradient(circle 12px, transparent 8.5px, ${around}), ${inside} center / 18px 18px no-repeat ${ground}`;
  }
  return `radial-gradient(circle 12px, ${fill} 8.5px, ${around}) ${ground}`;
}

const propSection = (label, ...controls) => h("div", { className: "pdf-prop-section" }, h("div", { className: "pdf-prop-label" }, label), h("div", { className: "pdf-prop-row" }, ...controls));

function choiceList(options, value, onPick, label) {
  const node = h("select", { "aria-label": label, onchange: () => onPick(node.value) }, options.map((option) => h("option", { value: String(option), selected: String(option) === String(value) }, String(option))));
  return node;
}
