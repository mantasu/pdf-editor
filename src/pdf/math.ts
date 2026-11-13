/**
 * Inline maths written `$...$` (LaTeX). Text boxes render formulas into their
 * appearance stream: MathJax typesets to SVG, whose glyph outlines become PDF
 * paths, so every reader shows the formula. The webview draws the same SVG with
 * MathJax's browser bundle.
 */
import { round } from "./objects";

/** `$...$`, pandoc's rule: no space just inside the dollars and no digit just after. */
export const TEX_SPAN = /\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\d)/gu;

export type TexPart = { text: string; tex?: undefined } | { tex: string; text: string };

/** Split text into plain and maths parts (`text` keeps the source, dollars included). */
export function splitTex(text: string): TexPart[] {
  const parts: TexPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TEX_SPAN)) {
    if (m.index > last) {
      parts.push({ text: text.slice(last, m.index) });
    }
    parts.push({ tex: m[1]!, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length || parts.length === 0) {
    parts.push({ text: text.slice(last) });
  }
  return parts;
}

/** Typeset formula; sizes are ems of the surrounding text, `content` draws in thousandths of an em, y down, from the baseline's left end. */
export interface Formula {
  width: number;
  ascent: number;
  descent: number;
  content: string;
}

/** An SVG element as MathJax's node adaptor produces them. */
export interface SvgEl {
  kind: string;
  attributes: Record<string, string>;
  children: SvgEl[];
}

const s = (value: number) => String(round(value));

type Matrix = [number, number, number, number, number, number];
const combine = (m: Matrix, [a, b, c, d, e, g]: Matrix): Matrix => [
  m[0] * a + m[2] * b,
  m[1] * a + m[3] * b,
  m[0] * c + m[2] * d,
  m[1] * c + m[3] * d,
  m[0] * e + m[2] * g + m[4],
  m[1] * e + m[3] * g + m[5],
];

/** SVG `transform` as PDF `cm` operands; undefined for identity. */
export function parseTransform(value: string | undefined): string | undefined {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  for (const [, op, args] of (value ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/gu)) {
    const v = args!.split(/[\s,]+/u).filter(Boolean).map(Number);
    const rad = ((v[0] ?? 0) * Math.PI) / 180;
    const step: Matrix | undefined =
      op === "translate" ? [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]
      : op === "scale" ? [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]
      : op === "matrix" && v.length === 6 ? (v as Matrix)
      : op === "rotate" ? [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0]
      : undefined;
    if (step) {
      matrix = combine(matrix, step);
    }
  }
  return matrix.join() === "1,0,0,1,0,0" ? undefined : matrix.map(s).join(" ");
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff",
  magenta: "#ff00ff", gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080", brown: "#a52a2a",
};

/** A CSS color as a PDF fill operator; undefined keeps the text color. */
export function fillOf(color: string | undefined): string | undefined {
  const value = NAMED[color?.toLowerCase() ?? ""] ?? color ?? "";
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value)?.[1];
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/iu.exec(value)?.slice(1).map(Number);
  const channels = hex ? (hex.length === 3 ? [...hex].map((c) => c + c) : hex.match(/../gu)!).map((h) => Number.parseInt(h, 16)) : rgb;
  return channels ? `${channels.map((c) => s(c / 255)).join(" ")} rg` : undefined;
}

const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/gu;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** SVG path data as PDF operators (quadratics to cubics, arcs to lines). */
export function pathToPdf(d: string): string {
  const tokens = d.match(TOKEN) ?? [];
  const out: string[] = [];
  let [x, y, startX, startY, ctrlX, ctrlY] = [0, 0, 0, 0, 0, 0];
  let command = "";
  let previous = "";
  let i = 0;
  while (i < tokens.length) {
    if (/^[a-z]$/iu.test(tokens[i]!)) {
      command = tokens[i++]!;
    }
    const upper = command.toUpperCase();
    const count = ARITY[upper] ?? -1;
    const v = tokens.slice(i, i + count).map(Number);
    // A bare number or truncated command ends the path.
    if (count < 0 || v.length < count || v.some((n) => !Number.isFinite(n))) {
      break;
    }
    i += count;
    const relative = command !== upper;
    const [ox, oy] = relative ? [x, y] : [0, 0];
    const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
      out.push(`${[x1, y1, x2, y2, ex, ey].map(s).join(" ")} c`);
      [ctrlX, ctrlY, x, y] = [x2, y2, ex, ey];
    };
    const quad = (qx: number, qy: number, ex: number, ey: number) => {
      cubic(x + ((qx - x) * 2) / 3, y + ((qy - y) * 2) / 3, ex + ((qx - ex) * 2) / 3, ey + ((qy - ey) * 2) / 3, ex, ey);
      [ctrlX, ctrlY] = [qx, qy];
    };
    switch (upper) {
      case "M":
        [x, y, startX, startY] = [ox + v[0]!, oy + v[1]!, ox + v[0]!, oy + v[1]!];
        out.push(`${s(x)} ${s(y)} m`);
        command = relative ? "l" : "L"; // further pairs are lines
        break;
      case "L":
      case "H":
      case "V":
      case "A":
        x = upper === "V" ? x : upper === "A" ? ox + v[5]! : ox + v[0]!;
        y = upper === "H" ? y : upper === "V" ? oy + v[0]! : upper === "A" ? oy + v[6]! : oy + v[1]!;
        out.push(`${s(x)} ${s(y)} l`);
        break;
      case "C":
        cubic(ox + v[0]!, oy + v[1]!, ox + v[2]!, oy + v[3]!, ox + v[4]!, oy + v[5]!);
        break;
      case "S": {
        const smooth = previous === "C" || previous === "S";
        cubic(smooth ? 2 * x - ctrlX : x, smooth ? 2 * y - ctrlY : y, ox + v[0]!, oy + v[1]!, ox + v[2]!, oy + v[3]!);
        break;
      }
      case "Q":
        quad(ox + v[0]!, oy + v[1]!, ox + v[2]!, oy + v[3]!);
        break;
      case "T": {
        const smooth = previous === "Q" || previous === "T";
        quad(smooth ? 2 * x - ctrlX : x, smooth ? 2 * y - ctrlY : y, ox + v[0]!, oy + v[1]!);
        break;
      }
      default:
        out.push("h");
        [x, y] = [startX, startY];
        command = ""; // numbers after Z carry no command
    }
    previous = upper;
  }
  return out.join(" ");
}

/** SVG that cannot be drawn faithfully (characters outside MathJax's fonts). */
export class UnsupportedMath extends Error {}

const attr = (node: SvgEl, name: string) => Number(node.attributes[name] ?? 0);

/** Draw an SVG element and its children as PDF operators. */
export function drawSvg(node: SvgEl): string {
  const children = () => node.children.map(drawSvg).filter(Boolean).join(" ");
  let body: string;
  switch (node.kind) {
    case "svg":
    case "g":
      body = children();
      break;
    case "path":
      body = `${pathToPdf(node.attributes.d ?? "")} f`;
      break;
    case "rect":
      body = `${[attr(node, "x"), attr(node, "y"), attr(node, "width"), attr(node, "height")].map(s).join(" ")} re f`;
      break;
    case "line":
      body = `${s(attr(node, "stroke-width") || 1)} w ${s(attr(node, "x1"))} ${s(attr(node, "y1"))} m ${s(attr(node, "x2"))} ${s(attr(node, "y2"))} l S`;
      break;
    case "text":
      throw new UnsupportedMath("text outside the math fonts");
    default:
      return "";
  }
  const place = node.kind === "svg" && (node.attributes.x || node.attributes.y) ? `translate(${attr(node, "x")},${attr(node, "y")})` : "";
  const transform = parseTransform(`${place} ${node.attributes.transform ?? ""}`);
  const fill = fillOf(node.attributes.fill);
  const stroke = fill?.replace(/rg$/u, "RG");
  return transform || fill ? `q ${transform ? `${transform} cm ` : ""}${fill ? `${fill} ${stroke} ` : ""}${body} Q` : body;
}

/** A formula from MathJax's SVG root (viewBox in thousandths of an em). */
export function formulaOf(svg: SvgEl): Formula {
  const [minX = 0, minY = 0, width = 0, height = 0] = (svg.attributes.viewBox ?? "").split(/[\s,]+/u).map(Number);
  const content = svg.children.map(drawSvg).filter(Boolean).join(" ");
  return { width: width / 1000, ascent: -minY / 1000, descent: (minY + height) / 1000, content: minX ? `q 1 0 0 1 ${s(-minX)} 0 cm ${content} Q` : content };
}

type Typeset = (tex: string) => SvgEl;
let typesetter: Typeset | undefined;

/**
 * The TeX packages MathJax 3's AllPackages had, so formulas keep their meaning; resources/viewer/richtext.mjs loads the
 * same ones. Each is imported below by name, as a bundler needs literal paths.
 */
const TEX_PACKAGES = [
  "base", "action", "ams", "amscd", "bbox", "boldsymbol", "braket", "bussproofs", "cancel", "cases", "centernot", "color", "colortbl", "configmacros",
  "empheq", "enclose", "extpfeil", "gensymb", "html", "mathtools", "mhchem", "newcommand", "noerrors", "noundefined", "tagformat", "textcomp",
  "textmacros", "unicode", "upgreek", "verb",
];

/** MathJax 4 (TeX -> SVG in the MathJax TeX font, the packages above), loaded on first use. */
async function loadMathJax(): Promise<Typeset> {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { MathJaxTexFont }, { MathJaxMhchemFontExtension }] = await Promise.all([
    import("@mathjax/src/js/mathjax.js"),
    import("@mathjax/src/js/input/tex.js"),
    import("@mathjax/src/js/output/svg.js"),
    import("@mathjax/src/js/adaptors/liteAdaptor.js"),
    import("@mathjax/src/js/handlers/html.js"),
    import("@mathjax/mathjax-tex-font/js/svg.js"),
    // mhchem draws its reaction arrows from this font extension.
    import("@mathjax/mathjax-mhchem-font-extension/js/svg.js"),
    // Each package registers itself when loaded.
    import("@mathjax/src/js/input/tex/base/BaseConfiguration.js"),
    import("@mathjax/src/js/input/tex/action/ActionConfiguration.js"),
    import("@mathjax/src/js/input/tex/ams/AmsConfiguration.js"),
    import("@mathjax/src/js/input/tex/amscd/AmsCdConfiguration.js"),
    import("@mathjax/src/js/input/tex/bbox/BboxConfiguration.js"),
    import("@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js"),
    import("@mathjax/src/js/input/tex/braket/BraketConfiguration.js"),
    import("@mathjax/src/js/input/tex/bussproofs/BussproofsConfiguration.js"),
    import("@mathjax/src/js/input/tex/cancel/CancelConfiguration.js"),
    import("@mathjax/src/js/input/tex/cases/CasesConfiguration.js"),
    import("@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js"),
    import("@mathjax/src/js/input/tex/color/ColorConfiguration.js"),
    import("@mathjax/src/js/input/tex/colortbl/ColortblConfiguration.js"),
    import("@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js"),
    import("@mathjax/src/js/input/tex/empheq/EmpheqConfiguration.js"),
    import("@mathjax/src/js/input/tex/enclose/EncloseConfiguration.js"),
    import("@mathjax/src/js/input/tex/extpfeil/ExtpfeilConfiguration.js"),
    import("@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js"),
    import("@mathjax/src/js/input/tex/html/HtmlConfiguration.js"),
    import("@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js"),
    import("@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js"),
    import("@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js"),
    import("@mathjax/src/js/input/tex/noerrors/NoErrorsConfiguration.js"),
    import("@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js"),
    import("@mathjax/src/js/input/tex/tagformat/TagFormatConfiguration.js"),
    import("@mathjax/src/js/input/tex/textcomp/TextcompConfiguration.js"),
    import("@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js"),
    import("@mathjax/src/js/input/tex/unicode/UnicodeConfiguration.js"),
    import("@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js"),
    import("@mathjax/src/js/input/tex/verb/VerbConfiguration.js"),
  ]);
  MathJaxTexFont.addExtension(MathJaxMhchemFontExtension);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    packages: TEX_PACKAGES,
    formatError: (_jax: unknown, error: Error) => {
      throw error;
    },
  });
  const document = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: "none" }) });
  type Element = Parameters<typeof adaptor.allAttributes>[0];
  // <text> nodes (characters outside the fonts) carry no drawing and are skipped.
  const toTree = (node: Element): SvgEl => ({
    kind: adaptor.kind(node),
    attributes: Object.fromEntries(adaptor.allAttributes(node).map(({ name, value }) => [name, value])),
    children: adaptor.childNodes(node).flatMap((child) => (adaptor.kind(child) === "#text" ? [] : [toTree(child as Element)])),
  });
  return (source) => toTree(adaptor.firstChild(document.convert(source, { display: false })) as Element);
}

const cache = new Map<string, Formula | undefined>();

/** Typeset formulas; ones MathJax rejects (or cannot draw) are undefined and stay text. */
export async function typesetFormulas(sources: Iterable<string>): Promise<Map<string, Formula | undefined>> {
  const result = new Map<string, Formula | undefined>();
  for (const source of sources) {
    if (!cache.has(source)) {
      typesetter ??= await loadMathJax();
      try {
        cache.set(source, formulaOf(typesetter(source)));
      } catch {
        cache.set(source, undefined);
      }
    }
    result.set(source, cache.get(source));
  }
  return result;
}
