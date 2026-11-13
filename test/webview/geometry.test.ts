import { describe, expect, test } from "vitest";
import {
  MARK_STYLES,
  bbox,
  fitBox,
  fromFrac,
  inQuads,
  mapPoints,
  markStrokes,
  mergeLines,
  moveBy,
  outlinePoints,
  polylineDistance,
  roundedQuad,
  segmentDistance,
  stackColumns,
  toFrac,
  toQuads,
} from "../../resources/viewer/geometry.mjs";

/** Stands in for a pdf.js PageViewport: 100x200 page, rotation optional. */
function pageBox(rotation = 0) {
  const [width, height] = rotation % 180 === 0 ? [100, 200] : [200, 100];
  // Both directions swap the same way at 90 degrees, so one closure serves.
  const flip = (x: number, y: number) => (rotation === 0 ? [x, 200 - y] : [y, x]);
  return { width, height, convertToViewportPoint: flip, convertToPdfPoint: flip };
}

describe("coordinates", () => {
  test("page box and fractions are inverse conversions", () => {
    expect(toFrac(pageBox(), 50, 150)).toEqual([0.5, 0.25]);
    expect(fromFrac(pageBox(), 0.5, 0.25)).toEqual([50, 150]);
  });

  test("mergeLines joins same-line rects; toQuads emits Acrobat order", () => {
    const merged = mergeLines([
      { left: 0, top: 10, width: 20, height: 10 },
      { left: 21, top: 11, width: 30, height: 9 },
      { left: 0, top: 30, width: 40, height: 10 },
      { left: 0, top: 50, width: 0.2, height: 10 },
      { left: 60, top: 30, width: 5, height: 10 },
    ]);
    expect(merged).toEqual([
      { left: 0, top: 10, right: 51, bottom: 20 },
      { left: 0, top: 30, right: 40, bottom: 40 },
      { left: 60, top: 30, right: 65, bottom: 40 },
    ]);
    expect(toQuads([{ left: 10, top: 20, right: 60, bottom: 30 }], { left: 0, top: 0, width: 100, height: 200 }, pageBox())).toEqual([10, 180, 60, 180, 10, 170, 60, 170]);
    // Rotation must not flip the quad axes: they still track the text direction.
    expect(toQuads([{ left: 20, top: 10, right: 30, bottom: 60 }], { left: 0, top: 0, width: 200, height: 100 }, pageBox(90))).toEqual([10, 30, 60, 30, 10, 20, 60, 20]);
  });

  test("segmentDistance and polylineDistance", () => {
    expect(segmentDistance(5, 5, 0, 0, 10, 0)).toBe(5); // above the middle
    expect(segmentDistance(-3, 4, 0, 0, 10, 0)).toBe(5); // past the start cap
    expect(segmentDistance(3, 4, 0, 0, 0, 0)).toBe(5); // degenerate segment
    expect(polylineDistance(10, 5, [0, 0, 10, 0, 10, 10])).toBe(0);
    expect(polylineDistance(3, 4, [0, 0])).toBe(5);
  });

  test("inQuads respects a tolerance", () => {
    const quads = [10, 30, 110, 30, 10, 18, 110, 18];
    expect(inQuads(50, 20, quads)).toBe(true);
    expect(inQuads(50, 30.5, quads, 1)).toBe(true);
    expect(inQuads(5, 20, quads)).toBe(false);
  });
});

describe("geometry transforms", () => {
  test("outlinePoints prefers quads, ink and line over the fallback rect", () => {
    expect(outlinePoints({ quads: [1, 2], rect: [0, 0, 0, 0] })).toEqual([1, 2]);
    expect(outlinePoints({ ink: [[1, 2], [3, 4]], rect: [0, 0, 0, 0] })).toEqual([1, 2, 3, 4]);
    expect(outlinePoints({ line: [1, 2, 3, 4], rect: [0, 0, 0, 0] })).toEqual([1, 2, 3, 4]);
    expect(outlinePoints({ rect: [0, 0, 5, 5] })).toEqual([0, 0, 5, 5]);
  });

  test("moveBy per kind, with sub-pixel nudges dropped", () => {
    expect(moveBy({ kind: "note", rect: [0, 0, 24, 24] }, 10, 5)).toEqual({ rect: [10, 5, 34, 29] });
    expect(moveBy({ kind: "ink", rect: [0, 0, 1, 1], ink: [[0, 0, 1, 1]] }, 1, 1)).toEqual({ ink: [[1, 1, 2, 2]], rect: [1, 1, 2, 2] });
    expect(moveBy({ kind: "line", rect: [0, 0, 1, 1], line: [0, 0, 1, 1] }, 1, 0)).toEqual({ line: [1, 0, 2, 1], rect: [1, 0, 2, 1] });
    expect(moveBy({ kind: "highlight", rect: [0, 0, 1, 1], quads: [0, 1, 1, 1, 0, 0, 1, 0] }, 0, 2)).toEqual({ quads: [0, 3, 1, 3, 0, 2, 1, 2], rect: [0, 2, 1, 3] });
    expect(moveBy({ kind: "square", rect: [0, 0, 10, 10] }, 0.0004, 1)).toEqual({ rect: [0, 1, 10, 11] });
  });

  test("fitBox and mapPoints remap shapes", () => {
    expect(fitBox({ kind: "square", rect: [0, 0, 10, 10] }, [0, 0, 10, 10], [0, 0, 20, 5])).toEqual({ rect: [0, 0, 20, 5] });
    expect(fitBox({ kind: "ink", rect: [0, 0, 0, 0], ink: [[0, 0, 0, 0]] }, [0, 0, 0, 0], [1, 1, 2, 2])).toEqual({ ink: [[1, 1, 1, 1]], rect: [1, 1, 1, 1] });
    expect(mapPoints({ kind: "image", rect: [0, 0, 1, 1] }, (x: number, y: number) => [y, x])).toEqual({ rect: [0, 0, 1, 1] });
  });
});

describe("shapes", () => {
  test("roundedQuad rounds a highlight's corners and reaches past both ends by 8% of its height", () => {
    const path = roundedQuad([0, 10], [100, 10], [100, 0], [0, 0]);
    expect(path.map(([op]) => op).join("")).toBe("MCLCLCLC");
    const rounded = (p: unknown) => (p as number[]).map((v) => Math.round(v * 1000) / 1000);
    expect(rounded(path[0]![1])).toEqual([-0.8, 7.8]);
    expect(rounded(path[1]![3])).toEqual([1.4, 10]); // the top edge starts one radius (22% of the height) in
    const xs = path.flatMap(([, ...points]) => points.map((p) => rounded(p)[0]!));
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-0.8, 100.8]);
    // A sliver narrower than two radii gets half its width as the radius.
    expect(rounded(roundedQuad([0, 10], [1, 10], [1, 0], [0, 0])[1]![3])).toEqual([0.5, 10]);
    // A degenerate quad stays where it is.
    expect(roundedQuad([5, 5], [5, 5], [5, 5], [5, 5]).every(([, ...points]) => points.every((p) => (p as number[]).join() === "5,5"))).toBe(true);
  });

  test("markStrokes draws each style of check and cross around a point; dots have none", () => {
    expect(MARK_STYLES).toEqual({ check: ["swoosh", "classic", "boxed"], cross: ["swoosh", "classic", "boxed"], dot: ["solid", "ring"] });
    const strokeCounts = (name: string) => MARK_STYLES[name as "check"].map((style) => markStrokes(name, style, 0, 0, 1).length);
    expect(strokeCounts("check")).toEqual([1, 1, 2]);
    expect(strokeCounts("cross")).toEqual([2, 2, 3]);
    expect(markStrokes("check", "classic", 10, 20, 3)).toEqual([[7, 20, 9, 17.9, 13, 22.4]]);
    // Every point stays inside the mark's square.
    for (const name of ["check", "cross"]) {
      for (const style of MARK_STYLES[name as "check"]) {
        const [x1, y1, x2, y2] = bbox(markStrokes(name, style, 50, 50, 7).flat());
        expect(Math.min(x1, y1) >= 43 - 1e-9 && Math.max(x2, y2) <= 57 + 1e-9).toBe(true);
      }
    }
    expect(markStrokes("check", "unknown", 0, 0, 1)).toEqual(markStrokes("check", "swoosh", 0, 0, 1));
    expect(markStrokes("dot", "solid", 0, 0, 1)).toEqual([]);
  });
});

describe("vertical text", () => {
  test("stackColumns matches the PDF writer's: words whole, long ones broken, spaces at breaks dropped", async () => {
    const { stackColumns: writer } = await import("../../src/pdf/kinds");
    const cases: Array<[string, number]> = [["ab cd", 5], ["ab cd", 4], ["abcdefg h", 3], ["ab   cd", 2], ["a\n\nb", 3], ["  a", 3]];
    for (const [text, capacity] of cases) {
      const paragraphs = text.split("\n").map((line) => [{ text: line }]);
      const letters = (columns: Array<Array<{ text: string }>>) => columns.map((column) => column.map((letter) => letter.text).join(""));
      expect(letters(stackColumns(paragraphs, capacity))).toEqual(letters(writer(paragraphs, capacity)));
    }
    expect(stackColumns([[{ text: "ab", bold: true }, { text: "c" }]], 5)[0]!.map((letter: { run: { bold?: boolean } }) => Boolean(letter.run.bold))).toEqual([true, true, false]);
  });
});
