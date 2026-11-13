/**
 * Commands on annotations and on selected text (marking up, sticky notes, the thread menu,
 * copying), plus the two floating bars offering them: over selected text and over a selected annotation.
 */
import * as model from "./annotations.mjs";
import { closeCard, cardId, composeCard, openCard } from "./card.mjs";
import { copilotMenu } from "./copilot.mjs";
import { ICON, KIND_NAMES, STATUSES, h, hexToRgb, iconNode, nameOf, pdfApp, reportError, rgbToHex, toHost } from "./core.mjs";
import { bbox, mergeLines, roundPt, toQuads } from "./geometry.mjs";
import { editTextBox, isTyping } from "./insert.mjs";
import { NOTE_SIZE, annotationPng, baseViewport, canExport, centreOnLetters, htmlLayer, screenBox } from "./layers.mjs";
import { openStylePanel, stylePanel } from "./toolbar.mjs";
import { TEXT_MARKS, activeTool, fieldsFor, paletteFor } from "./tools.mjs";
import { closeMenu, openMenu, openPopover } from "./ui.mjs";

/** PDF subtype for each text-mark kind; also the set of kinds "Change To" can switch between. */
const MARK_SUBTYPES = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly" };

// --- Text selection ---------------------------------------------------------------
// Menus and the selection bar act on a snapshot taken when they open: the browser can drop the
// live selection before the click arrives (a right-click after a triple-click, Ctrl+click on macOS).

/** The selection's range and common container, if non-empty and within a pdf.js text layer. */
function liveTextRange() {
  const live = getSelection();
  if (!live || live.isCollapsed || live.rangeCount === 0) {
    return undefined;
  }
  const range = live.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const container = common.nodeType === Node.TEXT_NODE ? common.parentElement : common;
  return container?.closest?.(".textLayer") || container?.querySelector?.(".textLayer") ? { range, container } : undefined;
}

export function hasSelection() {
  return liveTextRange() !== undefined;
}

/** Freeze the selection as `{ parts, text, bounds }`, `parts` holding `{ page, quads, rect }` per page in page order. */
export function snapshotSelection() {
  const live = liveTextRange();
  if (!live) {
    return undefined;
  }
  const { range, container } = live;
  const pageRects = new Map();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (text) =>
      text.parentElement?.closest(".textLayer") && range.intersectsNode(text) && text.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const page = Number(text.parentElement.closest(".page")?.dataset.pageNumber) - 1;
    const slice = document.createRange();
    slice.selectNodeContents(text);
    if (text === range.startContainer) {
      slice.setStart(text, range.startOffset);
    }
    if (text === range.endContainer) {
      slice.setEnd(text, range.endOffset);
    }
    pageRects.set(page, [...(pageRects.get(page) ?? []), ...slice.getClientRects()]);
  }
  const parts = [...pageRects]
    .map(([page, rects]) => {
      const viewport = baseViewport(page);
      const layerBox = htmlLayer(page)?.getBoundingClientRect();
      const quads = viewport && layerBox?.width ? toQuads(mergeLines(rects), layerBox, viewport) : [];
      return { page, quads, rect: quads.length ? bbox(quads) : undefined };
    })
    .filter((part) => part.quads.length > 0)
    .sort((a, b) => a.page - b.page);
  return parts.length ? { parts, text: range.toString(), bounds: range.getBoundingClientRect() } : undefined;
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    document.execCommand("copy");
  }
}

// --- Commands -------------------------------------------------------------------------

/** Mark the selection with `kind`, one mark per page; with `comment`, draft them and open the card instead. */
export function markSelection(kind, selection, { comment = false } = {}) {
  if (model.readOnlyReason() || !selection) {
    return;
  }
  const fields = fieldsFor(kind);
  const marks = selection.parts.map((part) => {
    // A strikethrough goes through the middle of the letters actually there.
    const quads = kind === "strikeout" ? centreOnLetters(part.page, part.quads) : part.quads;
    return model.create({ ...fields, page: part.page, rect: bbox(quads), quads });
  });
  getSelection()?.removeAllRanges();
  if (comment) {
    model.setDraft(marks);
    composeCard("Add Comment");
  } else {
    model.add(marks, `Add ${KIND_NAMES[kind]}`);
  }
}

export function selectionMenu(selection) {
  const disabled = Boolean(model.readOnlyReason());
  return [
    { label: "Highlight", action: () => markSelection("highlight", selection), disabled },
    { label: "Underline", action: () => markSelection("underline", selection), disabled },
    { label: "Strikethrough", action: () => markSelection("strikeout", selection), disabled },
    { label: "Add Comment", action: () => markSelection("highlight", selection, { comment: true }), disabled },
    { separator: true },
    { label: "Ask Copilot", icon: ICON.copilot, submenu: copilotMenu(selection) },
    { label: "Copy", action: () => copyToClipboard(selection.text) },
  ];
}

/** Draft a sticky note with its icon's top-left corner at PDF point (x, y) and open its card. */
export function startNote(page, x, y) {
  if (model.readOnlyReason()) {
    return;
  }
  model.setDraft([model.create({ ...fieldsFor("note"), page, rect: [x, y - NOTE_SIZE, x + NOTE_SIZE, y].map(roundPt) })]);
  composeCard("Add Sticky Note");
}

function convertMenu(annotation) {
  return Object.entries(MARK_SUBTYPES).map(([kind, subtype]) => ({
    label: KIND_NAMES[kind],
    icon: ICON[kind],
    checked: kind === annotation.kind,
    action: () => {
      const quads = kind === "strikeout" && annotation.quads ? centreOnLetters(annotation.page, annotation.quads) : annotation.quads;
      model.patch(annotation.id, { kind, subtype, subject: KIND_NAMES[kind], ...(quads && { quads, rect: bbox(quads) }) }, `Change to ${KIND_NAMES[kind]}`);
    },
  }));
}

/** Delete a thread (closing its card unsaved first); foreign "other" annotations are left alone. */
export function deleteThread(id) {
  const target = model.find(id);
  if (!target || model.readOnlyReason() || target.kind === "other") {
    return;
  }
  if (cardId() === id) {
    closeCard({ discard: true });
  }
  model.remove(id, `Delete ${nameOf(target)}`);
}

/** Render a drawing, picture or signature as PNG; the host asks where to save it. */
async function savePng(annotation) {
  try {
    toHost({ type: "save-image", name: nameOf(annotation), data: await annotationPng(annotation) });
  } catch (error) {
    reportError(error);
  }
}

/** Status choices: the PDF review states, "Completed" shown as Resolved; Cancelled (like Rejected) only on a thread that has it. */
export function statusMenu(annotation) {
  const status = model.reviewStatus(annotation.id) ?? "None";
  const values = ["None", "Accepted", "Rejected", "Completed", ...(status === "Cancelled" ? ["Cancelled"] : [])];
  return values.map((value) => ({
    label: value === "None" ? "No Status" : STATUSES[value].label,
    icon: value === "None" ? undefined : ICON[STATUSES[value].icon],
    checked: value === status,
    action: () => model.setReviewStatus(annotation.id, value),
  }));
}

/** The full menu for one thread; (x, y) is where a Properties… popover should open. Reply and Status need something to discuss. */
function threadMenu(annotation, x, y) {
  const readOnly = Boolean(model.readOnlyReason());
  const editable = !readOnly && annotation.kind !== "other";
  const replyable = model.canReply(annotation);
  const commented = annotation.contents.trim() !== "";
  const items = [
    annotation.kind === "freetext"
      ? { label: "Edit Text", action: () => editTextBox(annotation.id), disabled: !editable }
      : {
          label: annotation.kind === "note" ? "Open Pop-up Note" : commented ? "Open Comment" : "Add Comment",
          action: () => openCard(annotation.id, { focus: commented || annotation.kind === "note" ? undefined : "edit" }),
          disabled: readOnly && !commented,
        },
  ];
  if (model.hasDiscussion(annotation)) {
    items.push(
      { label: "Reply", action: () => openCard(annotation.id, { focus: "reply" }), disabled: !replyable },
      { label: "Status", disabled: !replyable, submenu: statusMenu(annotation) },
    );
  }
  // Acrobat's private checkmarks are no longer offered, but one already set can still be taken off.
  if (model.checkedByMe(annotation.id)) {
    items.push({ label: "Remove Checkmark", action: () => model.toggleCheck(annotation.id), disabled: !replyable });
  }
  // Saving a copy changes nothing, so read-only documents offer it too.
  if (canExport(annotation)) {
    items.push({ label: "Save as PNG…", action: () => savePng(annotation) });
  }
  if (!editable) {
    return items;
  }
  const currentHex = rgbToHex(annotation.color);
  items.push({ separator: true });
  if (annotation.kind in MARK_SUBTYPES || annotation.kind === "note") {
    items.push({ label: "Color", submenu: paletteFor(annotation.kind).map(({ name, color }) => ({ label: name, swatch: color, checked: color === currentHex, action: () => model.patch(annotation.id, { color: hexToRgb(color) }, "Change Color") })) });
  } else {
    items.push({ label: "Properties…", action: () => openStylePanel({ id: annotation.id }, x, y) });
  }
  if (annotation.kind in MARK_SUBTYPES) {
    items.push({ label: "Change To", submenu: convertMenu(annotation) });
  }
  items.push({ separator: true }, { label: "Delete", action: () => deleteThread(annotation.id) });
  return items;
}

/** Select a thread and show its menu at client point (x, y). */
export function openThreadMenu(annotation, x, y) {
  closeMenu();
  model.select(annotation.id);
  openMenu(threadMenu(annotation, x, y), x, y);
}

// --- The two bars ---------------------------------------------------------------------

/** An icon button for either bar; `text` adds a visible caption. */
function barButton(icon, label, onclick, { text, ...props } = {}) {
  const button = iconNode("button", icon, { type: "button", className: `pdf-icon-button${text ? " labeled" : ""}`, title: label, "aria-label": label, ...props, onclick });
  if (text) {
    button.append(h("span", {}, text));
  }
  return button;
}

/** A click handler passing `show` the bottom-left corner of the clicked button. */
const belowButton = (show) => (event) => {
  const { left, bottom } = event.currentTarget.getBoundingClientRect();
  show(left, bottom);
};

let selectionBar = null;

/** [icon key, label, run(snapshot, x, y)] with (x, y) the clicked button's bottom-left; the icon key also identifies the action. */
const SELECTION_ACTIONS = [
  ["highlight", "Highlight", (snap) => markSelection("highlight", snap)],
  ["underline", "Underline", (snap) => markSelection("underline", snap)],
  ["strikeout", "Strikethrough", (snap) => markSelection("strikeout", snap)],
  ["note", "Add comment", (snap) => markSelection("highlight", snap, { comment: true })],
  ["copilot", "Ask Copilot", (snap, x, y) => openMenu(copilotMenu(snap), x, y + 4)],
  ["copy", "Copy", (snap) => copyToClipboard(snap.text)],
];

export function hideSelectionBar() {
  selectionBar?.remove();
  selectionBar = null;
}

/** Pop the bar up, centred, over the selected text; the select tool only. */
export function showSelectionBar() {
  hideSelectionBar();
  const snap = activeTool() === "select" ? snapshotSelection() : undefined;
  if (!snap) {
    return;
  }
  const readOnly = Boolean(model.readOnlyReason());
  selectionBar = h(
    "div",
    { className: "pdf-quickbar", role: "toolbar", "aria-label": "Selection actions" },
    SELECTION_ACTIONS.map(([icon, label, run]) =>
      barButton(ICON[icon], label, belowButton((x, y) => (hideSelectionBar(), run(snap, x, y))), {
        disabled: readOnly && icon !== "copy" && icon !== "copilot",
        // Cancelling mousedown keeps focus, and so the text selection, where it is.
        onmousedown: (event) => event.preventDefault(),
      }),
    ),
  );
  document.body.append(selectionBar);
  const { width, height } = selectionBar.getBoundingClientRect();
  const { left, top, bottom, width: spanWidth } = snap.bounds;
  const x = Math.max(8, Math.min(left + spanWidth / 2 - width / 2, innerWidth - width - 8));
  const y = top - height - 8 >= 40 ? top - height - 8 : bottom + 8;
  Object.assign(selectionBar.style, { left: `${x}px`, top: `${y}px` });
}

let objectBar = null;
let objectBarFor = null;
let objectBarFrame = 0;

export function hideObjectBar() {
  objectBar?.remove();
  objectBar = null;
  objectBarFor = null;
}

/** Build the object bar for a thread root; notes never get one, their card serves instead. */
export function showObjectBar(id) {
  const target = model.find(id);
  hideObjectBar();
  if (!target || target.kind === "note") {
    return;
  }
  const readOnly = Boolean(model.readOnlyReason());
  const commented = target.contents.trim() !== "" && target.kind !== "freetext";
  const buttons = [];
  if (target.kind === "freetext" && !readOnly) {
    buttons.push(barButton(ICON.freetext, "Edit text", () => (hideObjectBar(), editTextBox(id)), { text: "Edit" }));
  }
  if (model.canReply(target) || commented) {
    const label = commented ? "Reply" : "Comment";
    buttons.push(barButton(ICON.note, label, () => openCard(id, { focus: commented ? "reply" : "edit" }), { text: label }));
  }
  if (!readOnly && target.kind !== "other") {
    const isImage = target.kind === "image";
    const swatch = `<i class="pdf-color-dot" style="--pdf-swatch: ${rgbToHex(target.color) ?? "transparent"}"></i>`;
    buttons.push(barButton(isImage ? ICON.image : swatch, isImage ? "Properties" : "Color and properties", belowButton((x, y) => openPopover(stylePanel({ id }), x, y + 4))));
    if (TEXT_MARKS.includes(target.kind)) {
      buttons.push(barButton(ICON[target.kind], "Change type", belowButton((x, y) => openMenu(convertMenu(target), x, y + 4))));
    }
    buttons.push(barButton(ICON.trash, "Delete", () => (hideObjectBar(), deleteThread(id))));
  }
  buttons.push(barButton(ICON.more, "More actions", belowButton((x, y) => openMenu(threadMenu(model.find(id), x, y), x, y + 4))));
  objectBar = h("div", { className: "pdf-actionbar", role: "toolbar", "aria-label": "Annotation actions" }, buttons);
  objectBarFor = id;
  document.body.append(objectBar);
  placeObjectBar();
}

/** Put the bar above its annotation (below when the top is cramped), hidden while the annotation is out of view. */
function placeObjectBar() {
  objectBarFrame = 0;
  const target = objectBarFor && model.find(objectBarFor);
  const anchor = target && screenBox(target);
  const viewport = document.getElementById("viewerContainer")?.getBoundingClientRect();
  if (!objectBar || !anchor || !viewport) {
    return;
  }
  const { width, height } = objectBar.getBoundingClientRect();
  const onScreen = anchor.bottom > viewport.top && anchor.top < viewport.bottom;
  objectBar.style.visibility = onScreen ? "" : "hidden";
  const left = Math.max(viewport.left + 6, Math.min(anchor.left, viewport.right - width - 6));
  const top = anchor.top - height - 8 >= viewport.top + 4 ? anchor.top - height - 8 : anchor.bottom + 8;
  Object.assign(objectBar.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

function queueObjectBar() {
  if (objectBar && !objectBarFrame) {
    objectBarFrame = requestAnimationFrame(placeObjectBar);
  }
}

export function setupBars() {
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (selectionBar && !selectionBar.contains(event.target)) {
        hideSelectionBar();
      }
    },
    true,
  );
  document.getElementById("viewerContainer")?.addEventListener("scroll", hideSelectionBar, { passive: true });
  document.addEventListener("selectionchange", () => {
    if (selectionBar && getSelection()?.isCollapsed) {
      hideSelectionBar();
    }
  });

  // The object bar follows the selected annotation and steps aside while a text box is being typed in.
  model.onChange((reason) => {
    const selectedId = model.selectedId();
    if (!selectedId || !model.find(selectedId) || isTyping()) {
      hideObjectBar();
    } else if (selectedId !== objectBarFor || reason === "edit" || reason === "replace") {
      showObjectBar(selectedId);
    }
  });
  document.getElementById("viewerContainer")?.addEventListener("scroll", queueObjectBar, { passive: true });
  window.addEventListener("resize", queueObjectBar);
  for (const name of ["scalechanging", "rotationchanging", "pagerendered"]) {
    pdfApp().eventBus.on(name, queueObjectBar);
  }
}
