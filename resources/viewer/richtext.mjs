/**
 * Formatted comment text: paragraphs of runs (RichText in src/pdf/model.ts, the formats PDF `/RC` can
 * hold) to DOM nodes and back, the comment editor and its format bar, and `$...$` formulas, which stay
 * plain text in the PDF and are typeset here with MathJax SVG, sized in ems like src/pdf/math.ts does.
 */
import { ICON, config, h, iconNode } from "./core.mjs";

// --- Runs ---------------------------------------------------------------------------------

/** Zero-width space that gives the caret a spot inside, or just after, a `<code>`; stripped on read. */
const CARET_SLOT = "\u200b";
const FORMATS = ["bold", "italic", "underline", "strike", "sup", "sub", "code"];
const TAG_OF_FORMAT = { bold: "strong", italic: "em", underline: "u", strike: "s", sup: "sup", sub: "sub", code: "code" };
const FORMAT_OF_TAG = { B: "bold", STRONG: "bold", I: "italic", EM: "italic", U: "underline", S: "strike", STRIKE: "strike", DEL: "strike", SUP: "sup", SUB: "sub", CODE: "code", TT: "code" };

export const isFormatted = (rich) => Boolean(rich?.some((p) => p.some((r) => FORMATS.some((f) => r[f]))));
export const toPlain = (rich) => rich.map((p) => p.map((r) => r.text).join("")).join("\n");

/** One `.pdf-paragraph` per paragraph, from the runs or else the plain lines; editors pass `math: false` to keep formulas as source. */
export function richNodes(contents, rich, { math = true } = {}) {
  const paragraphs = rich ?? contents.split("\n").map((text) => [{ text }]);
  const textOf = (run) => (math && !run.code ? withFormulas(run.text) : [document.createTextNode(run.text)]);
  const runNodes = (run) => {
    const formats = FORMATS.filter((f) => run[f]);
    return formats.length ? [formats.reduce((inner, format) => h(TAG_OF_FORMAT[format], {}, inner), textOf(run))] : textOf(run);
  };
  return paragraphs.map((runs) => h("div", { className: "pdf-paragraph" }, runs.length ? runs.flatMap(runNodes) : h("br")));
}

/** `{ contents, rich? }` of an editable area; `rich` is left out unless something is formatted. */
export function readEditor(area) {
  const runs = collectRuns(area);
  const contents = toPlain(runs).trim();
  return { contents, ...(contents && isFormatted(runs) && { rich: runs }) };
}

/** Runs of an editable tree: neighbours with equal formats joined, empty paragraphs at the end dropped. */
function collectRuns(root) {
  const paragraphs = [[]];
  const breakParagraph = () => paragraphs.at(-1).length && paragraphs.push([]);
  const visit = (node, inherited) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\u00a0/gu, " ").replaceAll(CARET_SLOT, "");
      if (text) {
        paragraphs.at(-1).push({ text, ...inherited });
      }
      return;
    }
    if (node.nodeName === "BR") {
      paragraphs.push([]);
      return;
    }
    const isBlock = node !== root && /^(DIV|P|LI)$/u.test(node.nodeName);
    if (isBlock) {
      breakParagraph();
    }
    const tagFormat = FORMAT_OF_TAG[node.nodeName];
    const formats = { ...inherited, ...(tagFormat && { [tagFormat]: true }), ...formatsFromStyle(node) };
    node.childNodes.forEach((child) => visit(child, formats));
    if (isBlock) {
      breakParagraph();
    }
  };
  visit(root, {});
  const joined = paragraphs.map(joinRuns);
  while (joined.length > 1 && joined.at(-1).length === 0) {
    joined.pop();
  }
  return joined;
}

/** Formats set through inline styles (what execCommand and pasted markup may produce). */
function formatsFromStyle(node) {
  const style = node.style;
  return {
    ...(/bold|[6-9]00/u.test(style?.fontWeight ?? "") && { bold: true }),
    ...(style?.fontStyle === "italic" && { italic: true }),
    ...(style?.textDecorationLine?.includes("underline") && { underline: true }),
    ...(style?.textDecorationLine?.includes("line-through") && { strike: true }),
    ...(style?.verticalAlign === "super" && { sup: true }),
    ...(style?.verticalAlign === "sub" && { sub: true }),
    ...(/mono|courier/iu.test(style?.fontFamily ?? node.getAttribute?.("face") ?? "") && { code: true }),
  };
}

function joinRuns(runs) {
  return runs.reduce((out, run) => {
    const previous = out.at(-1);
    if (previous && FORMATS.every((f) => previous[f] === run[f])) {
      out[out.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      out.push(run);
    }
    return out;
  }, []);
}

// --- Editing ------------------------------------------------------------------------------

/** `command` is the execCommand name (also used to query its state). Code is handled by hand; Math just types `$…$`. */
const FORMAT_BUTTONS = [
  { name: "bold", title: "Bold (Ctrl+B)", command: "bold" },
  { name: "italic", title: "Italic (Ctrl+I)", command: "italic" },
  { name: "underline", title: "Underline (Ctrl+U)", command: "underline" },
  { name: "strikeout", title: "Strikethrough", command: "strikeThrough" },
  { name: "sup", title: "Superscript", command: "superscript" },
  { name: "sub", title: "Subscript", command: "subscript" },
  { name: "code", title: "Code", run: toggleCode },
  { name: "math", title: "Math: $…$ (LaTeX)", run: insertDollars },
];

const isToggle = (spec) => spec.name !== "math";

/** Format buttons for a contentEditable `area` that never take the focus; a toggle shows pressed while the caret's text (or the next typed text) has its format. */
export function formatToolbar(area, onInput) {
  const buttons = FORMAT_BUTTONS.map((spec) => {
    const button = iconNode("button", ICON[spec.name], {
      type: "button",
      className: "pdf-icon-button",
      title: spec.title,
      "aria-label": spec.title,
      tabIndex: -1,
      onmousedown: (event) => event.preventDefault(),
      onclick: () => {
        area.focus({ preventScroll: true });
        if (spec.command) {
          document.execCommand(spec.command);
        } else {
          spec.run(area);
        }
        onInput?.();
        refresh();
      },
    });
    if (isToggle(spec)) {
      button.setAttribute("aria-pressed", "false");
    }
    return { spec, button };
  });
  const bar = h("div", { className: "pdf-format-bar", role: "toolbar", "aria-label": "Formatting" }, buttons.map(({ button }) => button));
  // The listener goes once the editor has been in the page and left it, not before it is inserted.
  let mounted = false;
  function refresh() {
    if (!area.isConnected) {
      if (mounted) {
        document.removeEventListener("selectionchange", refresh);
      }
      return;
    }
    mounted = true;
    for (const { spec, button } of buttons) {
      if (isToggle(spec)) {
        const pressed = isPressed(spec, area);
        button.classList.toggle("active", pressed);
        button.setAttribute("aria-pressed", String(pressed));
      }
    }
  }
  document.addEventListener("selectionchange", refresh);
  // Ctrl+B and friends change the pending format without moving the caret, so no selectionchange fires.
  area.addEventListener("keyup", refresh);
  area.addEventListener("input", refresh);
  area.addEventListener("focus", refresh);
  return bar;
}

function isPressed(spec, area) {
  const node = getSelection()?.anchorNode;
  if (!node || !area.contains(node)) {
    return false;
  }
  return Boolean(spec.name === "code" ? enclosingCode(node, area) : document.queryCommandState(spec.command));
}

/** Paste only the clipboard's plain text, keeping outside markup out of comments. */
export function plainPaste(area) {
  area.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
  });
}

/** The comment editor with its format bar: Ctrl/Cmd+Enter calls `onSubmit`, Escape `onCancel`; `value()` gives `{ contents, rich? }`. */
export function commentEditor({ contents = "", rich, placeholder, label, onSubmit, onCancel, onInput }) {
  // Only with a placeholder: `data-placeholder="undefined"` would show as text in an emptied editor.
  const area = h("div", { className: "pdf-editor-area", contentEditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": label, dataset: placeholder === undefined ? undefined : { placeholder } });
  area.append(...(contents || rich ? richNodes(contents, rich, { math: false }) : []));
  const bar = formatToolbar(area, onInput);
  area.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit?.();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  });
  plainPaste(area);
  area.addEventListener("input", () => {
    area.classList.toggle("empty", !area.textContent);
    onInput?.();
  });
  area.classList.toggle("empty", !area.textContent);
  return {
    root: h("div", { className: "pdf-editor" }, area, bar),
    area,
    value: () => readEditor(area),
    focus() {
      area.focus({ preventScroll: true });
      placeCaret(area, area.childNodes.length);
    },
  };
}

function placeCaret(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}

/** The `<code>` around `node`, if that `<code>` is inside `area`. */
function enclosingCode(node, area) {
  const code = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest("code");
  return code && area.contains(code) ? code : null;
}

const hasRealText = (node) => Boolean(node?.textContent.replaceAll(CARET_SLOT, ""));

/** Code works like Bold: a selection is wrapped in or freed from `<code>`; a bare caret turns code on for what comes next, or off there (splitting the `<code>`). */
function toggleCode(area) {
  const selection = getSelection();
  if (!selection?.rangeCount || !area.contains(selection.anchorNode)) {
    return;
  }
  const range = selection.getRangeAt(0);
  const code = enclosingCode(selection.anchorNode, area);
  if (code && !range.collapsed) {
    code.replaceWith(...code.childNodes);
  } else if (code) {
    leaveCode(code, range);
  } else if (!range.collapsed) {
    const wrapper = document.createElement("code");
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    selection.selectAllChildren(wrapper);
  } else {
    const slot = document.createTextNode(CARET_SLOT);
    range.insertNode(h("code", {}, slot));
    placeCaret(slot, slot.length);
  }
}

/** Put the caret outside `code` at the caret's spot: what followed it moves into a second `<code>`. */
function leaveCode(code, caret) {
  const tail = document.createRange();
  tail.setStart(caret.startContainer, caret.startOffset);
  tail.setEndAfter(code);
  const rest = tail.extractContents().querySelector("code");
  const slot = document.createTextNode(CARET_SLOT);
  code.after(slot, ...(hasRealText(rest) ? [rest] : []));
  if (!hasRealText(code)) {
    code.remove();
  }
  placeCaret(slot, slot.length);
}

/** Wrap the selection in `$...$`; with nothing selected, insert `$$` and step back between them. */
function insertDollars() {
  const selected = getSelection()?.toString() ?? "";
  document.execCommand("insertText", false, `$${selected}$`);
  if (!selected) {
    getSelection()?.modify("move", "backward", "character");
  }
}

// --- Maths --------------------------------------------------------------------------------

/** Must match MATH in src/pdf/math.ts, so the viewer and the saved PDF agree on what a formula is. */
const FORMULA = /\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\d)/gu;

let mathJaxLoading = null;
let mathJaxReady = false;
/** Typeset SVG per TeX source; `null` for formulas shown as source. */
const svgCache = new Map();

export const containsMath = (text) => new RegExp(FORMULA.source, "u").test(text);
export const mathLoaded = () => mathJaxReady;

/** TEX_PACKAGES in src/pdf/math.ts: the viewer and the saved PDF must read TeX alike. */
const TEX_PACKAGES = [
  "base", "action", "ams", "amscd", "bbox", "boldsymbol", "braket", "bussproofs", "cancel", "cases", "centernot", "color", "colortbl", "configmacros",
  "empheq", "enclose", "extpfeil", "gensymb", "html", "mathtools", "mhchem", "newcommand", "noerrors", "noundefined", "tagformat", "textcomp",
  "textmacros", "unicode", "upgreek", "verb",
];

/**
 * Load MathJax 4 on first call; the promise settles once formulas can be typeset. Its TeX font and packages are loaded
 * up front from the extension (not a CDN), so typesetting stays synchronous; the menu and assistive add-ons, which
 * would fetch more, stay off.
 */
export function loadMathJax() {
  mathJaxLoading ??= new Promise((resolve, reject) => {
    globalThis.MathJax = {
      loader: {
        paths: { fonts: config.mathJax.replace(/\/$/u, "") },
        load: TEX_PACKAGES.filter((name) => name !== "base").map((name) => `[tex]/${name}`),
      },
      startup: { typeset: false },
      options: { enableMenu: false, enableEnrichment: false, enableSpeech: false, enableBraille: false, enableExplorer: false, enableAssistiveMml: false, enableComplexity: false },
      tex: {
        packages: TEX_PACKAGES,
        formatError: (_jax, error) => {
          throw error;
        },
      },
      output: { font: "mathjax-tex" },
      svg: { fontCache: "none" },
    };
    const onload = () => globalThis.MathJax.startup.promise.then(resolve, reject);
    document.head.append(h("script", { src: `${config.mathJax}src/bundle/tex-svg-nofont.js`, async: true, onerror: reject, onload }));
  }).then(() => {
    mathJaxReady = true;
    for (const placeholder of document.querySelectorAll(".pdf-math-pending")) {
      placeholder.replaceWith(formulaNode(placeholder.dataset.tex, placeholder.textContent));
    }
  });
  return mathJaxLoading;
}

/** `text` as nodes, each `$...$` formula replaced by its rendering. */
function withFormulas(text) {
  const nodes = [];
  let from = 0;
  for (const match of text.matchAll(FORMULA)) {
    if (match.index > from) {
      nodes.push(document.createTextNode(text.slice(from, match.index)));
    }
    nodes.push(formulaNode(match[1], match[0]));
    from = match.index + match[0].length;
  }
  if (from < text.length || nodes.length === 0) {
    nodes.push(document.createTextNode(text.slice(from)));
  }
  return nodes;
}

/** A formula: typeset, a placeholder until MathJax is loaded, or its source when it cannot be typeset. */
function formulaNode(tex, source = `$${tex}$`) {
  if (!mathJaxReady) {
    loadMathJax().catch(() => undefined);
    return h("span", { className: "pdf-math-pending", dataset: { tex } }, source);
  }
  if (!svgCache.has(tex)) {
    svgCache.set(tex, typeset(tex));
  }
  const svg = svgCache.get(tex)?.cloneNode(true);
  return svg ? h("span", { className: "pdf-math", title: source }, svg) : h("span", { className: "pdf-math-error", title: "Not valid TeX" }, source);
}

/** Inline SVG sized in ems of the surrounding text, or null when the formula should show as source. */
function typeset(tex) {
  let svg = null;
  try {
    svg = globalThis.MathJax.tex2svg(tex, { display: false }).querySelector("svg");
  } catch {
    return null;
  }
  // A `<text>` means glyphs outside MathJax's fonts; the host leaves those out of the PDF, so fall back to the source.
  if (!svg || svg.querySelector("text")) {
    return null;
  }
  const [, minY, width, height] = svg.getAttribute("viewBox").split(/[\s,]+/u).map(Number);
  ["width", "height", "style"].forEach((name) => svg.removeAttribute(name));
  Object.assign(svg.style, { width: `${width / 1000}em`, height: `${height / 1000}em`, verticalAlign: `${-(minY + height) / 1000}em` });
  return svg;
}
