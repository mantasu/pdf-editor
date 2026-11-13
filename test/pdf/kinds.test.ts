import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { pngOf } from "../../src/pdf/image";
import { extentOf, layoutText, textStyleOf } from "../../src/pdf/kinds";
import type { Annot, Rich } from "../../src/pdf/model";
import { parsePdf } from "../../src/pdf/read";
import { mergeRuns, parseRc, toPlain } from "../../src/pdf/richtext";
import { mergeAnnotations } from "../../src/pdf/write";

const JPEG = `data:image/jpeg;base64,${readFileSync(join(__dirname, "fixtures", "tiny.jpg")).toString("base64")}`;
const png = (channels: 1 | 2 | 3 | 4) =>
  `data:image/png;base64,${Buffer.from(pngOf(2, 1, channels, new Uint8Array(2 * channels).fill(200))).toString("base64")}`;

const base = { page: 0, opacity: 1, contents: "", author: "me" } as const;

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return doc.save();
}

/** Write a model to a blank page, return the annotation dicts and their decoded appearances. */
async function written(model: Annot[]) {
  const bytes = await mergeAnnotations(await blank(), model, { now: new Date("2026-10-07T12:00:00Z") });
  const doc = await PDFDocument.load(bytes);
  const dicts = (doc.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? [])
    .map((ref) => doc.context.lookup(ref) as PDFDict)
    .filter((d) => d.get(PDFName.of("Subtype")) !== PDFName.of("Popup"));
  const appearance = (dict: PDFDict) => {
    const stream = doc.context.lookup((dict.lookup(PDFName.of("AP")) as PDFDict).get(PDFName.of("N")) as PDFRef) as PDFRawStream;
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  };
  return { bytes, doc, dicts, appearance, reread: (await parsePdf(bytes)).annotations };
}

describe("drawing kinds round-trip", () => {
  const model: Annot[] = [
    { ...base, id: "ink", kind: "ink", subtype: "Ink", rect: [0, 0, 0, 0], ink: [[10, 10, 50, 60, 90, 20], [100, 100]], width: 3, color: [0, 0, 1] },
    { ...base, id: "sq", kind: "square", subtype: "Square", rect: [20, 200, 120, 260], width: 2, color: [1, 0, 0], fill: [1, 1, 0.5] },
    { ...base, id: "ci", kind: "circle", subtype: "Circle", rect: [150, 200, 250, 260], width: 1, color: [0, 0.5, 0] },
    { ...base, id: "ln", kind: "line", subtype: "Line", rect: [0, 0, 0, 0], line: [10, 300, 200, 350], arrow: true, width: 2, color: [0, 0, 0] },
    { ...base, id: "ln2", kind: "line", subtype: "Line", rect: [0, 0, 0, 0], line: [10, 380, 100, 380], width: 1, color: [0, 0, 0] },
  ];

  test("geometry, style and appearance survive a save", async () => {
    const { reread, dicts, appearance } = await written(model);
    const byId = new Map(reread.map((a) => [a.id, a]));
    expect(byId.get("ink")).toMatchObject({ kind: "ink", ink: [[10, 10, 50, 60, 90, 20], [100, 100]], width: 3, color: [0, 0, 1], subject: "Drawing" });
    expect(byId.get("ink")!.rect).toEqual(extentOf([10, 10, 50, 60, 90, 20, 100, 100], 2.5));
    expect(byId.get("sq")).toMatchObject({ kind: "square", rect: [20, 200, 120, 260], width: 2, fill: [1, 1, 0.5], subject: "Rectangle" });
    expect(byId.get("ci")).toMatchObject({ kind: "circle", rect: [150, 200, 250, 260], subject: "Oval" });
    expect(byId.get("ci")!.fill).toBeUndefined();
    expect(byId.get("ln")).toMatchObject({ kind: "line", line: [10, 300, 200, 350], arrow: true, width: 2 });
    expect(byId.get("ln2")!.arrow).toBeUndefined();

    const ap = (nm: string) => appearance(dicts.find((d) => (d.lookup(PDFName.of("NM")) as PDFString).decodeText() === nm)!);
    expect(ap("ink")).toContain("10 10 m 50 60 l 90 20 l S");
    expect(ap("ink")).toContain("100 100 m 100 100 l S"); // a dot
    expect(ap("sq")).toMatch(/re B$/u);
    expect(ap("ci")).toMatch(/c h S$/u);
    expect(ap("ln").split(" S").length).toBe(3); // shaft + arrow head
    expect(ap("ln2").split(" S").length).toBe(2);
  });
});

describe("defaults and text-markup appearances", () => {
  test("every markup kind draws its appearance with Acrobat's default colors", async () => {
    const quads = [10, 30, 110, 30, 10, 18, 110, 18, 10, 50, 60, 50, 10, 50, 60, 50];
    const kinds = [["highlight", "Highlight"], ["underline", "Underline"], ["strikeout", "StrikeOut"], ["squiggly", "Squiggly"]] as const;
    const { dicts, appearance, reread } = await written(kinds.map(([kind, subtype]) => ({ ...base, id: kind, kind, subtype, rect: [0, 0, 0, 0], quads })));
    const content = Object.fromEntries(dicts.map((d) => [(d.lookup(PDFName.of("NM")) as PDFString).decodeText(), appearance(d)]));
    expect(content.highlight).toContain("1 1 0 rg");
    expect(content.highlight!.match(/ f/gu)).toHaveLength(2);
    expect(content.underline).toContain("0 0.6 0.3 RG");
    expect(content.strikeout).toContain("0.9 0.1 0.1 RG");
    expect(content.squiggly!.match(/ l/gu)!.length).toBeGreaterThan(4);
    expect(reread.map((a) => a.color)).toEqual([[1, 1, 0], [0, 0.6, 0.3], [0.9, 0.1, 0.1], [0.2, 0.4, 1]]);
  });

  test("highlights get rounded ends; underlines keep a chosen width in /BS and their appearance", async () => {
    const quads = [10, 30, 110, 30, 10, 18, 110, 18];
    const mark = (id: string, kind: "highlight" | "underline" | "strikeout", subtype: string, extra: Partial<Annot> = {}): Annot => ({ ...base, id, kind, subtype, rect: [0, 0, 0, 0], quads, ...extra });
    const { dicts, appearance, reread } = await written([mark("h", "highlight", "Highlight", { width: 3 }), mark("u", "underline", "Underline", { width: 2 }), mark("s", "strikeout", "StrikeOut")]);
    const byId = (id: string) => dicts.find((d) => (d.lookup(PDFName.of("NM")) as PDFString).decodeText() === id)!;
    expect(appearance(byId("h"))).toMatch(/m (?:[\d. -]+ c [\d. -]+ l ){3}[\d. -]+ c h f/u); // four rounded corners
    expect(appearance(byId("u"))).toContain("2 w");
    expect(appearance(byId("s"))).toContain("0.857 w"); // automatic: a fourteenth of the 12 pt line
    expect(byId("s").has(PDFName.of("BS"))).toBe(false);
    expect(Object.fromEntries(reread.map((a) => [a.id, a.width]))).toEqual({ h: undefined, u: 2, s: undefined }); // a highlight has no line to widen
  });

  test("centred and right-aligned text boxes keep /Q and place their lines by it", async () => {
    const box = (id: string, align?: "center" | "right"): Annot => ({ ...base, id, kind: "freetext", subtype: "FreeText", rect: [0, 0, 200, 40], contents: "Hi there", ...(align && { align }) });
    const { dicts, appearance, reread } = await written([box("l"), box("c", "center"), box("r", "right")]);
    const byId = (id: string) => dicts.find((d) => (d.lookup(PDFName.of("NM")) as PDFString).decodeText() === id)!;
    const lineX = (id: string) => Number(/1 0 0 1 ([\d.]+) /u.exec(appearance(byId(id)))![1]);
    const width = 200 - 4;
    expect(lineX("l")).toBe(2);
    const textWidth = width - (lineX("r") - 2); // right-aligned: the line ends at the inset
    expect(textWidth).toBeGreaterThan(20);
    expect(lineX("c")).toBeCloseTo(2 + (width - textWidth) / 2, 1);
    expect(byId("l").has(PDFName.of("Q"))).toBe(false);
    expect(byId("c").lookup(PDFName.of("Q"))!.toString()).toBe("1");
    expect((byId("r").lookup(PDFName.of("DS")) as PDFString).decodeText()).toContain("text-align:right");
    expect(Object.fromEntries(reread.map((a) => [a.id, a.align]))).toEqual({ l: undefined, c: "center", r: "right" });
  });

  test("vertical text stacks upright letters, 1 em apart, in columns 1.2 em wide", async () => {
    // Courier 10 pt: 6 pt wide letters, centred in 12 pt columns; 5 letters fit down 54 pt of room.
    const { dicts, appearance, reread } = await written([{ ...base, id: "v", kind: "freetext", subtype: "FreeText", rect: [100, 50, 130, 108], contents: "Up page", vertical: true, font: { family: "Courier", size: 10 } }]);
    const placed = [...appearance(dicts[0]!).matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm <([\dA-F]+)> Tj/gu)].map(([, x, y, hex]) => [Number(x), Number(y), Buffer.from(hex!, "hex").toString("latin1")]);
    expect(placed.map(([, , letter]) => letter).join("")).toBe("Uppage"); // the space at the break is dropped
    expect(placed.slice(0, 2)).toEqual([[105, 98, "U"], [105, 88, "p"]]); // x: 102 + (12 - 6) / 2; y: 106 - 8, then 1 em down
    expect(placed[2]).toEqual([117, 98, "p"]); // "page" starts the next column
    expect((dicts[0]!.lookup(PDFName.of("DS")) as PDFString).decodeText()).toContain("writing-mode:vertical-lr; text-orientation:upright");
    expect(reread[0]).toMatchObject({ vertical: true, rect: [100, 50, 130, 108] });
    // Middle and bottom alignment move each column down by half or all of its spare room.
    const tops = await Promise.all((["center", "right"] as const).map(async (align) => {
      const { dicts: aligned, appearance: drawn } = await written([{ ...base, id: "v", kind: "freetext", subtype: "FreeText", rect: [100, 50, 130, 108], contents: "ab", vertical: true, align, font: { family: "Courier", size: 10 } }]);
      return Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/u.exec(drawn(aligned[0]!))![1]);
    }));
    expect(tops).toEqual([98 - 17, 98 - 34]); // 54 pt of room, 20 used
  });

  test("a text box in a bundled font embeds it and reads back by name", async () => {
    const { doc, reread } = await written([{ ...base, id: "t", kind: "freetext", subtype: "FreeText", rect: [0, 0, 160, 30], contents: "Hello there", font: { family: "Comic Neue", size: 10, bold: true } }]);
    expect(reread[0]!.font).toEqual({ family: "Comic Neue", size: 10, bold: true }); // a quoted name in /DS
    const names = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Font") ? [o.lookup(PDFName.of("BaseFont"))!.toString()] : []));
    expect(names.some((name) => name.startsWith("/ComicNeue-Bold"))).toBe(true);
  });

  test("foreign drawings without /BS or /DA read with defaults", async () => {
    const doc = await PDFDocument.load(await blank());
    const ctx = doc.context;
    const annots = [
      { Subtype: "Square", Rect: [0, 0, 10, 10] },
      { Subtype: "Line", Rect: [0, 0, 10, 10], L: [0, 0, 10, 10], LE: ["None", "None"] },
      { Subtype: "FreeText", Rect: [0, 0, 10, 10], Contents: PDFString.of("t") },
    ].map((dict) => ctx.register(ctx.obj({ Type: "Annot", ...dict })));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj(annots));
    const { annotations } = await parsePdf(await doc.save());
    expect(annotations.map((a) => [a.kind, a.width ?? a.color])).toEqual([["square", 1], ["line", 1], ["freetext", [0, 0, 0]]]);
    expect(annotations[1]!.arrow).toBeUndefined();
  });

  test("drawings without a width or color use defaults; empty strokes are dropped", async () => {
    const { reread } = await written([
      { ...base, id: "ink", kind: "ink", subtype: "Ink", rect: [0, 0, 0, 0], ink: [[10, 10, 20, 20], [5]] },
      { ...base, id: "sq", kind: "square", subtype: "Square", rect: [0, 0, 50, 50] },
      { ...base, id: "ln", kind: "line", subtype: "Line", rect: [0, 0, 0, 0], line: [0, 0, 50, 50] },
      { ...base, id: "im", kind: "image", subtype: "Stamp", rect: [0, 0, 50, 50] },
      { ...base, id: "empty", kind: "ink", subtype: "Ink", rect: [0, 0, 1, 1] },
    ]);
    const byId = new Map(reread.map((a) => [a.id, a]));
    expect(byId.get("ink")).toMatchObject({ ink: [[10, 10, 20, 20]], width: 1, color: [0.9, 0.13, 0.13] });
    expect(byId.get("sq")).toMatchObject({ width: 1, color: [0.9, 0.13, 0.13] });
    expect(byId.get("ln")).toMatchObject({ width: 1, color: [0.9, 0.13, 0.13] });
    expect(byId.get("im")).toMatchObject({ kind: "other" });
  });
});

describe("text boxes", () => {
  test("font, color and wrapped text are written and read back", async () => {
    const box: Annot = {
      ...base,
      id: "tb",
      kind: "freetext",
      subtype: "FreeText",
      rect: [20, 300, 120, 380],
      contents: "Hello wonderful world\nsecond ✓",
      color: [0, 0, 1],
      font: { family: "Times", size: 14, bold: true, italic: true },
    };
    const { reread, dicts, appearance } = await written([box]);
    expect(reread[0]).toMatchObject({ kind: "freetext", contents: "Hello wonderful world\nsecond ✓", color: [0, 0, 1], font: box.font, subject: "Text Box" });
    const [dict] = dicts;
    expect(dict!.has(PDFName.of("Popup"))).toBe(false);
    expect((dict!.lookup(PDFName.of("DA")) as PDFString).decodeText()).toBe("0 0 1 rg /TiRo 14 Tf");
    const content = appearance(dict!);
    expect(content.match(/ Tj/gu)?.length).toBe(3); // wrapped into three lines
    expect(content).toContain("/F0 14 Tf");
  });

  test("style parsing from /DS and /DA", async () => {
    const doc = await PDFDocument.create();
    const style = (entries: Record<string, string>) =>
      textStyleOf(doc.context.obj(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, PDFString.of(v)]))) as PDFDict);
    expect(style({ DS: "font: bold italic 9pt Courier New; color:#FF0000" })).toEqual({ font: { family: "Courier", size: 9, bold: true, italic: true }, color: [1, 0, 0] });
    expect(style({ DS: "font-family: Times New Roman; font-size: 11pt" }).font).toEqual({ family: "Times", size: 11 });
    expect(style({ DA: "/Helv 10 Tf 0 0.5 1 rg" })).toEqual({ font: { family: "Helvetica", size: 10 }, color: [0, 0.5, 1] });
    expect(style({ DA: "0.25 g /TiRo 8 Tf" })).toEqual({ font: { family: "Times", size: 8 }, color: [0.25, 0.25, 0.25] });
    expect(style({})).toEqual({ font: { family: "Helvetica", size: 12 } });
    expect(style({ DS: "font: 0pt Helvetica" }).font.size).toBe(12);
    expect(style({ DS: `font: ${"9".repeat(400)}pt Times` }).font).toEqual({ family: "Times", size: 12 });
    expect(style({ DA: "/Helv 1e999 Tf NaN g" })).toEqual({ font: { family: "Helvetica", size: 12 } });
    expect(style({ DS: "garbage; color: red", DA: "1 0 0 rg" })).toEqual({ font: { family: "Helvetica", size: 12 }, color: [1, 0, 0] });
    const started = performance.now();
    style({ DS: `font:${"a".repeat(50_000)}!`, DA: `${"1 ".repeat(50_000)}rg` });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("layout wraps words, splits overlong ones and keeps each run's style", () => {
    // One unit per character, so widths are easy to follow.
    const font = { widthOfTextAtSize: (text: string, size: number) => (text.length * size) / 10 } as never;
    const style = (run: { bold?: true }) => ({ font, size: run.bold ? 20 : 10, rise: 0 });
    const texts = (lines: ReturnType<typeof layoutText>) => lines.map((line) => line.map((segment) => segment.text).join("|"));
    expect(texts(layoutText([[{ text: "aa bb cc" }]], 5, style))).toEqual(["aa bb ", "cc"]);
    expect(texts(layoutText([[{ text: "abcdefgh" }]], 3, style))).toEqual(["abc", "def", "gh"]);
    expect(texts(layoutText([[{ text: "a" }], [], [{ text: "b" }]], 5, style))).toEqual(["a", "", "b"]);
    // A bold run is twice as wide here, so it wraps sooner and keeps its own size.
    const lines = layoutText([[{ text: "ab " }, { text: "cd", bold: true }]], 5, style);
    expect(texts(lines)).toEqual(["ab ", "cd"]);
    expect(lines[1]![0]).toMatchObject({ size: 20, width: 4 });
    // A word whose style changes midway moves to the next line whole; empty runs add nothing.
    expect(texts(layoutText([[{ text: "abc hel" }, { text: "" }, { text: "lo", bold: true }]], 7, style))).toEqual(["abc ", "hel|lo"]);
    // A formula is one piece, never split, and never merged with text.
    const formula = { width: 0.8, ascent: 0.7, descent: 0.2, content: "" };
    const withMath = layoutText([[{ text: "a " }, { text: "$x$", formula }, { text: "b" }]], 5, style);
    expect(texts(withMath)).toEqual(["a ", "$x$|b"]);
    expect(withMath[1]![0]).toMatchObject({ width: 8, formula });
  });

  test("formatted text boxes keep their runs and draw each style", async () => {
    const rich: Rich = [
      [{ text: "E = mc" }, { text: "2", sup: true }, { text: " and H" }, { text: "2", sub: true }, { text: "O" }],
      [{ text: "bold", bold: true }, { text: " " }, { text: "italic", italic: true }, { text: " " }, { text: "code()", code: true }],
      [{ text: "under", underline: true }, { text: " " }, { text: "gone", strike: true }, { text: " ✓" }],
    ];
    const box: Annot = { ...base, id: "rich", kind: "freetext", subtype: "FreeText", rect: [20, 200, 380, 300], contents: toPlain(rich), rich };
    const { reread, dicts, appearance } = await written([box]);
    expect(reread[0]).toMatchObject({ contents: box.contents, rich });
    const content = appearance(dicts[0]!);
    // Regular, bold, italic and Courier fonts; sup/sub at 70% size; two decoration lines.
    expect(content.match(/\/F\d+ /gu)!.length).toBeGreaterThanOrEqual(9);
    expect(new Set(content.match(/\/F\d/gu)).size).toBe(4);
    expect(content).toContain(" 8.4 Tf");
    expect(content.match(/ l S/gu)).toHaveLength(2);
    expect(content).toMatch(/203F> Tj/u); // " ✓": the check mark is outside WinAnsi
  });

  test("$...$ maths is drawn as outlines; code and bad TeX stay text; tall formulas make taller lines", async () => {
    const rich: Rich = [
      [{ text: "Area $\\pi r^2$ and $\\dfrac{a}{b}$" }],
      [{ text: "$x$", code: true }, { text: " bad $\\frac{$" }],
      [{ text: "plain" }],
    ];
    const box: Annot = { ...base, id: "math", kind: "freetext", subtype: "FreeText", rect: [20, 200, 380, 300], contents: toPlain(rich), rich };
    const { reread, dicts, appearance } = await written([box]);
    expect(reread[0]!.contents).toBe("Area $\\pi r^2$ and $\\dfrac{a}{b}$\n$x$ bad $\\frac{$\nplain");
    const content = appearance(dicts[0]!);
    // Two formulas at 12 pt: thousandths of an em, flipped to y down.
    expect(content.match(/q 0\.012 0 0 -0\.012 /gu)).toHaveLength(2);
    expect(content).toContain("<247824> Tj"); // "$x$" in code
    expect(content).toContain("<2062616420245C667261637B24> Tj"); // " bad $\\frac{$"
    // Lines advance 14.4 pt (12 pt x 1.2) unless a formula is taller: the fraction's line is.
    const baselines = [...content.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/gu)].map((m) => Number(m[1]));
    const [first, second, third] = [baselines[0]!, baselines.at(-2)!, baselines.at(-1)!];
    expect(first - second).toBeGreaterThan(14.4);
    expect(second - third).toBeCloseTo(14.4, 3);
  });
});

describe("images", () => {
  test.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["RGB PNG", png(3), "image/png"],
    ["RGBA PNG", png(4), "image/png"],
    ["gray PNG", png(1), "image/png"],
    ["gray+alpha PNG", png(2), "image/png"],
  ])("%s pictures are stamped and recovered", async (_label, url, mime) => {
    const { reread, appearance, dicts } = await written([{ ...base, id: "im", kind: "image", subtype: "Stamp", rect: [10, 10, 110, 60], image: url }]);
    expect(reread[0]).toMatchObject({ kind: "image", rect: [10, 10, 110, 60], subject: "Image" });
    expect(reread[0]!.image!.startsWith(`data:${mime};base64,`)).toBe(true);
    expect(appearance(dicts[0]!)).toContain("/Im0 Do");
    if (mime === "image/jpeg") {
      expect(reread[0]!.image).toBe(url);
    }
  });

  test("stamps without a single 8-bit RGB/gray/JPEG picture are not ours", async () => {
    const doc = await PDFDocument.load(await blank());
    const ctx = doc.context;
    const image = (dict: Record<string, unknown>, data = new Uint8Array(4)) =>
      ctx.register(ctx.flateStream(data, { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: "DeviceRGB", ...dict }));
    const stamp = (xobjects: Record<string, PDFRef>, extra: Record<string, unknown> = {}) => {
      const form = ctx.register(ctx.stream("q Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1], Resources: { XObject: xobjects } }));
      return ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 1, 1], AP: { N: form }, ...extra }));
    };
    const cmyk = stamp({ Im0: image({ ColorSpace: "DeviceCMYK" }) });
    const noSize = stamp({ Im0: ctx.register(ctx.flateStream(new Uint8Array(3), { Type: "XObject", Subtype: "Image", BitsPerComponent: 8, ColorSpace: "DeviceRGB" })) });
    const noSpace = stamp({ Im0: ctx.register(ctx.flateStream(new Uint8Array(3), { Type: "XObject", Subtype: "Image", BitsPerComponent: 8 })) });
    const maskWithoutSpace = stamp({ Im0: image({ SMask: ctx.register(ctx.flateStream(new Uint8Array(1), { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8 })) }) });
    const sixteenBit = stamp({ Im0: image({ BitsPerComponent: 16 }) });
    const predictor = stamp({ Im0: image({ DecodeParms: { Predictor: 15 } }) });
    const two = stamp({ Im0: image({}), Im1: image({}) });
    const vector = stamp({ Fm0: ctx.register(ctx.stream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] })) });
    const badMask = stamp({ Im0: image({ SMask: image({ ColorSpace: "DeviceRGB" }) }) });
    const noAp = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 1, 1], Name: "Approved" }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([cmyk, noSize, noSpace, maskWithoutSpace, sixteenBit, predictor, two, vector, badMask, noAp]));
    const { annotations } = await parsePdf(await doc.save());
    expect(annotations.map((a) => a.kind)).toEqual(Array(10).fill("other"));
  });
});

describe("rich text", () => {
  test("parses tags, styles, entities and Acrobat's markup", () => {
    const parsed = parseRc(
      '<?xml version="1.0"?><!-- c --><body xmlns="http://www.w3.org/1999/xhtml"><p><b>b</b><strong>s</strong><i>i</i><em>e</em><u>u</u>' +
        "<s>s</s><strike>k</strike><del>d</del><sup>p</sup><sub>q</sub><code>c</code><tt>t</tt></p>\n  <p><span style=\"font-weight:700;font-style:oblique;vertical-align:+3pt\">w</span>" +
        "<span style='vertical-align:-2pt;font-family:monospace'>m</span>&#65;&#x42;&quot;&apos;&nbsp;&bogus;&#0;<br/>next</p><div>x</div><xfa:span>y</xfa:span></body>",
    );
    expect(parsed).toEqual([
      [
        { text: "bs", bold: true },
        { text: "ie", italic: true },
        { text: "u", underline: true },
        { text: "skd", strike: true },
        { text: "p", sup: true },
        { text: "q", sub: true },
        { text: "ct", code: true },
      ],
      [
        { text: "w", bold: true, italic: true, sup: true },
        { text: "m", sub: true, code: true },
        { text: "AB\"'\u00a0&bogus;&#0;" },
      ],
      [{ text: "next" }],
      [{ text: "x" }],
      [{ text: "y" }],
    ]);
    expect(parseRc("<body><p>  </p></body>")).toEqual([[{ text: "  " }]]);
    expect(parseRc("<body></body>")).toBeUndefined();
    expect(parseRc("<p>a</i></p>")).toEqual([[{ text: "a" }]]);
  });

  test("tolerates unterminated markup and stays linear on hostile input", () => {
    expect(parseRc("<p>a<!-- never closed")).toEqual([[{ text: "a" }]]);
    expect(parseRc("<p>a</p><b")).toEqual([[{ text: "a" }]]);
    expect(parseRc("x < 3 > y")).toEqual([[{ text: "x  y" }]]);
    expect(parseRc("a".repeat(300_000))![0]![0]!.text).toHaveLength(200_000);
    const started = performance.now();
    parseRc("<a".repeat(100_000));
    parseRc(`<p>${" ".repeat(100_000)}x</p>`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("mergeRuns merges runs and trims empty paragraphs", () => {
    expect(mergeRuns([[{ text: "a" }, { text: "" }, { text: "b" }], [], []])).toEqual([[{ text: "ab" }]]);
  });

  test("removing formatting from a comment on an annotation the extension does not draw", async () => {
    const doc = await PDFDocument.load(await blank());
    const ctx = doc.context;
    const polygon = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Polygon", Rect: [0, 0, 9, 9], Contents: PDFString.of("hi"), RC: PDFString.of("<p><b>hi</b></p>") }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([polygon]));
    const source = await doc.save();
    const [read] = (await parsePdf(source)).annotations;
    expect(read!.rich).toEqual([[{ text: "hi", bold: true }]]);
    const out = await parsePdf(await mergeAnnotations(source, [{ ...read!, rich: undefined }]));
    expect(out.annotations[0]!.rich).toBeUndefined();
  });

  test("rich text without /Contents still yields plain text", async () => {
    const doc = await PDFDocument.load(await blank());
    const ctx = doc.context;
    const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], RC: PDFString.of("<body><p>only rich</p></body>") }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([note]));
    const { annotations } = await parsePdf(await doc.save());
    expect(annotations[0]).toMatchObject({ contents: "only rich" });
    expect(annotations[0]!.rich).toBeUndefined();
  });
});
