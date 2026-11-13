import { describe, expect, test } from "vitest";
import { type SvgEl, drawSvg, formulaOf, parseTransform, pathToPdf, splitTex, typesetFormulas } from "../../src/pdf/math";

const el = (kind: string, attributes: Record<string, string> = {}, children: SvgEl[] = []): SvgEl => ({ kind, attributes, children });

describe("splitting TeX out of text", () => {
  test("dollar spans follow pandoc's spacing rule", () => {
    // Prices ($5 ... $6) must not turn into maths; escaped dollars may.
    expect(splitTex("Cost $5 and $6, but $x^2$ and $a \\$ b$ and $$")).toEqual([
      { text: "Cost $5 and $6, but " },
      { tex: "x^2", text: "$x^2$" },
      { text: " and " },
      { tex: "a \\$ b", text: "$a \\$ b$" },
      { text: " and $$" },
    ]);
    expect(splitTex("$a$")).toEqual([{ tex: "a", text: "$a$" }]);
    expect(splitTex("")).toEqual([{ text: "" }]);
    // Inner padding or digits on both sides disqualify a span.
    expect(splitTex("$ a$ $a $ $1$2")).toEqual([{ text: "$ a$ $a $ $1$2" }]);
  });
});

describe("converting SVG to PDF content", () => {
  test("parseTransform folds transforms into a single matrix", () => {
    expect(parseTransform(undefined)).toBeUndefined();
    expect(parseTransform("translate(0,0) scale(1) skewX(5)")).toBeUndefined(); // skew is unsupported
    expect(parseTransform("translate(10)")).toBe("1 0 0 1 10 0");
    expect(parseTransform("translate(10, 20) scale(2)")).toBe("2 0 0 2 10 20");
    expect(parseTransform("scale(1,-1)")).toBe("1 0 0 -1 0 0");
    expect(parseTransform("scale() translate()")).toBeUndefined();
    expect(parseTransform("matrix(1 2 3 4 5 6) matrix(1 2)")).toBe("1 2 3 4 5 6");
    expect(parseTransform("rotate(90)")).toBe("0 1 -1 0 0 0");
    expect(parseTransform("rotate()")).toBeUndefined();
  });

  test("pathToPdf handles every command, absolute and relative", () => {
    expect(pathToPdf("M1 2 3 4 L5 6 H7 V8 Z")).toBe("1 2 m 3 4 l 5 6 l 7 6 l 7 8 l h");
    expect(pathToPdf("m1 2 3 4 l1 1 h2 v2 z")).toBe("1 2 m 4 6 l 5 7 l 7 7 l 7 9 l h");
    expect(pathToPdf("M0 0 C1 1 2 2 3 3 S5 5 6 6")).toBe("0 0 m 1 1 2 2 3 3 c 4 4 5 5 6 6 c");
    expect(pathToPdf("M0 0 c1 1 2 2 3 3 s2 2 3 3")).toBe("0 0 m 1 1 2 2 3 3 c 4 4 5 5 6 6 c");
    expect(pathToPdf("M0 0 S3 3 6 0")).toBe("0 0 m 0 0 3 3 6 0 c"); // reflected control point
    // Quadratics are lifted to cubics with controls 2/3 along the way.
    expect(pathToPdf("M0 0 Q3 3 6 0 T12 0")).toBe("0 0 m 2 2 4 2 6 0 c 8 -2 10 -2 12 0 c");
    expect(pathToPdf("M0 0 q3 3 6 0 t6 0")).toBe("0 0 m 2 2 4 2 6 0 c 8 -2 10 -2 12 0 c");
    expect(pathToPdf("M0 0 T6 0")).toBe("0 0 m 0 0 2 0 6 0 c");
    // Arcs degenerate to a straight line to their endpoint.
    expect(pathToPdf("M0 0 A5 5 0 0 1 10 0 a5 5 0 0 1 10 0")).toBe("0 0 m 10 0 l 20 0 l");
    expect(pathToPdf("M.5-.5 1e1 2")).toBe("0.5 -0.5 m 10 2 l");
  });

  test("pathToPdf gives up at the first malformed token", () => {
    expect(pathToPdf("")).toBe("");
    expect(pathToPdf("1 2 M3 4")).toBe(""); // data before any command
    expect(pathToPdf("M1 2 Z 3 4")).toBe("1 2 m h"); // trailing data is ignored
    expect(pathToPdf("M1 2 L3")).toBe("1 2 m"); // half a line
    expect(pathToPdf("M1 2 L3 1e999")).toBe("1 2 m"); // non-finite number
  });

  test("drawSvg walks groups/shapes and refuses real text", () => {
    expect(drawSvg(el("g", { transform: "translate(1,2)", fill: "red" }, [el("path", { d: "M0 0 L1 1" }), el("defs")]))).toBe("q 1 0 0 1 1 2 cm 1 0 0 rg 1 0 0 RG 0 0 m 1 1 l f Q");
    expect(drawSvg(el("path"))).toBe(" f"); // empty path still closes the fill
    expect(drawSvg(el("rect", { x: "1", y: "2", width: "3", height: "4" }))).toBe("1 2 3 4 re f");
    expect(drawSvg(el("rect"))).toBe("0 0 0 0 re f");
    expect(drawSvg(el("line", { x1: "0", y1: "1", x2: "2", y2: "3", "stroke-width": "40" }))).toBe("40 w 0 1 m 2 3 l S");
    expect(drawSvg(el("line"))).toBe("1 w 0 0 m 0 0 l S");
    expect(drawSvg(el("svg", { x: "5" }, [el("rect")]))).toBe("q 1 0 0 1 5 0 cm 0 0 0 0 re f Q");
    expect(drawSvg(el("svg", {}, [el("rect")]))).toBe("0 0 0 0 re f");
    expect(drawSvg(el("g", { fill: "#000" }, [el("rect")]))).toBe("q 0 0 0 rg 0 0 0 RG 0 0 0 0 re f Q");
    expect(() => drawSvg(el("g", {}, [el("text")]))).toThrow("text outside the math fonts");
  });

  test("formulaOf scales the viewBox (thousandths of an em) to em units", () => {
    expect(formulaOf(el("svg", { viewBox: "0 -800 2000 1000" }, [el("rect")]))).toEqual({ width: 2, ascent: 0.8, descent: 0.2, content: "0 0 0 0 re f" });
    expect(formulaOf(el("svg", { viewBox: "-50 0 100 100" })).content).toBe("q 1 0 0 1 50 0 cm  Q");
    expect(formulaOf(el("svg"))).toEqual({ width: 0, ascent: -0, descent: 0, content: "" });
  });
});

describe("MathJax typesetting", () => {
  test("good TeX outlines, bad TeX and non-ASCII stay text, repeats are cached", async () => {
    const boxes = await typesetFormulas(["x^2", "\\frac{a}{b}", "\\frac{", "\\text{é}", "x^2"]);
    const square = boxes.get("x^2")!;
    expect(square.width).toBeGreaterThan(0.9);
    expect(square.ascent).toBeGreaterThan(0.7);
    expect(square.content).toMatch(/ c .* f/u);
    // The fraction is taller than x² and its bar is a rectangle.
    expect(boxes.get("\\frac{a}{b}")!.descent).toBeGreaterThan(square.descent);
    expect(boxes.get("\\frac{a}{b}")!.content).toContain(" re f");
    expect(boxes.get("\\frac{")).toBeUndefined(); // broken TeX produces nothing
    expect(boxes.get("\\text{é}")).toBeUndefined(); // glyphs outside the math fonts
    expect((await typesetFormulas(["x^2"])).get("x^2")).toBe(square); // same cached object
  });
});
