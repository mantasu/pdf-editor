import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";

let threePages: Uint8Array;

async function pagesOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${i}`, { x: 50, y: 350, size: 24, font });
  }
  threePages = await doc.save();
});

describe("page-ops", () => {
  test("rotatePage rotates clockwise and wraps at 360", async () => {
    const { rotatePage } = await import("../../src/pdf/pages");
    const once = await rotatePage(threePages, 2);
    const doc1 = await PDFDocument.load(once);
    expect(doc1.getPage(1).getRotation().angle).toBe(90);
    expect(doc1.getPage(0).getRotation().angle).toBe(0);

    const twice = await rotatePage(once, 2, false);
    const doc2 = await PDFDocument.load(twice);
    expect(doc2.getPage(1).getRotation().angle).toBe(0);

    let bytes = threePages;
    for (let i = 0; i < 5; i++) {
      bytes = await rotatePage(bytes, 1);
    }
    const doc3 = await PDFDocument.load(bytes);
    expect(doc3.getPage(0).getRotation().angle).toBe(90);
  });

  test("rotatePage rejects out-of-range pages", async () => {
    const { rotatePage } = await import("../../src/pdf/pages");
    await expect(rotatePage(threePages, 0)).rejects.toThrow(/out of range/u);
    await expect(rotatePage(threePages, 4)).rejects.toThrow(/out of range/u);
    await expect(rotatePage(threePages, 1.5)).rejects.toThrow(/out of range/u);
  });

  test("perform dispatches every operation", async () => {
    const { perform } = await import("../../src/pdf/pages");
    expect(await pagesOf((await perform("rotate", threePages, 1))!)).toBe(3);
    expect(await pagesOf((await perform("delete", threePages, 1))!)).toBe(2);
    expect(await perform("move-up", threePages, 1)).toBeUndefined();
    expect(await pagesOf((await perform("move-up", threePages, 2))!)).toBe(3);
    expect(await pagesOf((await perform("move-down", threePages, 1))!)).toBe(3);
    expect(await pagesOf((await perform("insert-before", threePages, 1))!)).toBe(4);
    expect(await pagesOf((await perform("insert-after", threePages, 1))!)).toBe(4);
  });

  test("pageAfter follows the page that was acted on", async () => {
    const { pageAfter } = await import("../../src/pdf/pages");
    expect(pageAfter("move-up", 1)).toBe(1);
    expect(pageAfter("move-up", 3)).toBe(2);
    expect(pageAfter("move-down", 2)).toBe(3);
    expect(pageAfter("insert-after", 2)).toBe(3);
    expect(pageAfter("rotate", 2)).toBe(2);
  });
});
