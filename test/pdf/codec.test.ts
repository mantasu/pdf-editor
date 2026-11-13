import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { Annot } from "../../src/pdf/model";
import { parsePdf } from "../../src/pdf/read";
import { mergeAnnotations } from "../../src/pdf/write";

const DATE = "D:20190413223625+02'00'";

/** A one-page PDF with comments as Acrobat writes them, plus a link, an ink mark and a polygon. */
async function legacyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const reg = (value: Record<string, unknown>) => ctx.register(ctx.obj(value as never));

  const note = reg({
    Type: "Annot",
    Subtype: "Text",
    Rect: [63, 759, 87, 783],
    F: 28,
    C: [1, 0.82, 0],
    Contents: PDFString.of("A sticky note"),
    NM: PDFString.of("note-1"),
    T: PDFString.of("mirko"),
    Subj: PDFString.of("Sticky Note"),
    Name: "Comment",
    M: PDFString.of(DATE),
    CreationDate: PDFString.of(DATE),
    RC: PDFString.of("<body><p>A sticky note</p></body>"),
  });
  const notePopup = reg({ Type: "Annot", Subtype: "Popup", Rect: [408, 669, 612, 783], Open: false, F: 28, Parent: note });
  (ctx.lookup(note) as PDFDict).set(PDFName.of("Popup"), notePopup);

  const reply1 = reg({
    Type: "Annot", Subtype: "Text", Rect: [63, 759, 87, 783], F: 28, Name: "Comment",
    Contents: PDFHexString.fromText("Reply ✓ one"), T: PDFString.of("jane"), IRT: note, NM: PDFString.of("reply-1"),
  });
  // Acrobat chains replies: the second reply points at the first.
  const reply2 = reg({
    Type: "Annot", Subtype: "Text", Rect: [63, 759, 87, 783], F: 28, Name: "Comment",
    Contents: PDFString.of("Reply two"), T: PDFString.of("mirko"), IRT: reply1, NM: PDFString.of("reply-2"),
  });
  const state = reg({
    Type: "Annot", Subtype: "Text", Rect: [63, 759, 87, 783], F: 30,
    Contents: PDFString.of("Accepted set by mirko"), T: PDFString.of("mirko"), IRT: note,
    State: PDFString.of("Accepted"), StateModel: PDFString.of("Review"), NM: PDFString.of("state-1"),
  });

  const highlight = reg({
    Type: "Annot", Subtype: "Highlight", Rect: [70, 697, 345, 710], F: 4, C: [1, 1, 0], CA: 1,
    QuadPoints: [70, 710, 345, 710, 70, 697, 345, 697],
    Contents: PDFString.of("Comment on a highlight"), T: PDFString.of("jane"),
  });
  const ink = reg({
    Type: "Annot", Subtype: "Ink", Rect: [100, 100, 200, 200], F: 4, InkList: [[100, 100, 200, 200]],
    Contents: PDFString.of("Ink comment"), T: PDFString.of("jane"), NM: PDFString.of("ink-1"),
  });
  const polygon = reg({
    Type: "Annot", Subtype: "Polygon", Rect: [300, 300, 400, 400], F: 4, Vertices: [300, 300, 400, 300, 350, 400],
    Contents: PDFString.of("Polygon comment"), T: PDFString.of("jane"), NM: PDFString.of("poly-1"),
  });
  const link = reg({
    Type: "Annot", Subtype: "Link", Rect: [10, 10, 50, 30],
    A: { S: "URI", URI: PDFString.of("https://example.com") },
  });
  // A hidden root note and a grouped annotation are left to pdf.js.
  const hidden = reg({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 10, 10], F: 2, Contents: PDFString.of("hidden") });

  page.node.set(
    PDFName.of("Annots"),
    ctx.obj([note, notePopup, reply1, reply2, state, highlight, ink, polygon, link, hidden]),
  );
  return doc.save();
}

let seq = 0;
const freshIds = () => `gen-${++seq}`;

async function pageAnnots(bytes: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPages()[pageIndex]!.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const dicts = (annots?.asArray() ?? []).map((ref) => doc.context.lookup(ref) as PDFDict);
  return { doc, dicts, subtypes: dicts.map((d) => (d.get(PDFName.of("Subtype")) as PDFName).decodeText()) };
}

const text = (dict: PDFDict, key: string) => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
};

describe("mergeAnnotations", () => {
  it("round-trips: once saved, files read back to the same model", async () => {
    // The first save normalizes (appearances, pop-ups, default colors); after that, saving is stable.
    const first = await parsePdf(await mergeAnnotations(await legacyPdf(), (await parsePdf(await legacyPdf(), freshIds)).annotations), freshIds);
    const source = await mergeAnnotations(await legacyPdf(), first.annotations);
    const { annotations } = await parsePdf(source, freshIds);
    const reread = await parsePdf(await mergeAnnotations(source, annotations), freshIds);
    const strip = (list: Annot[]) =>
      list.map(({ ref: _ref, id, ...rest }) => ({ ...rest, id: id.startsWith("gen-") ? "*" : id }));
    expect(strip(reread.annotations).sort((a, b) => a.contents.localeCompare(b.contents))).toEqual(
      strip(annotations).sort((a, b) => a.contents.localeCompare(b.contents)),
    );
  });

  it("creates Acrobat-style notes, highlight comments, replies and states", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const source = await doc.save();
    const model: Annot[] = [
      { id: "n", kind: "note", subtype: "Text", page: 0, rect: [100, 600, 124, 624], opacity: 1, contents: "Note", author: "me" },
      {
        id: "h", kind: "highlight", subtype: "Highlight", page: 0, rect: [70, 697, 345, 710],
        quads: [70, 710, 345, 710, 70, 697, 345, 697], color: [1, 0.9, 0], opacity: 1, contents: "Why?", author: "me",
      },
      { id: "r", kind: "note", subtype: "Text", page: 0, rect: [70, 686, 94, 710], opacity: 1, contents: "Because", author: "you", replyTo: "h" },
      {
        id: "s", kind: "note", subtype: "Text", page: 0, rect: [70, 686, 94, 710], opacity: 1, contents: "Completed set by me",
        author: "me", replyTo: "h", state: { model: "Review", value: "Completed" },
      },
    ];
    const out = await mergeAnnotations(source, model, { now: new Date("2026-10-07T12:00:00Z") });
    const { doc: written, dicts, subtypes } = await pageAnnots(out);
    expect(subtypes).toEqual(["Text", "Popup", "Highlight", "Popup", "Text", "Text"]);
    const byName = (nm: string) => dicts.find((d) => text(d, "NM") === nm)!;
    const flags = (d: PDFDict) => (d.lookup(PDFName.of("F")) as { asNumber(): number }).asNumber();

    expect(flags(byName("n"))).toBe(28);
    expect(text(byName("n"), "Subj")).toBe("Sticky Note");
    expect((byName("n").get(PDFName.of("Name")) as PDFName).decodeText()).toBe("Comment");
    expect(flags(byName("h"))).toBe(4);
    expect(text(byName("h"), "Contents")).toBe("Why?");
    expect(flags(byName("s"))).toBe(30);
    expect(text(byName("s"), "State")).toBe("Completed");
    const irt = byName("r").get(PDFName.of("IRT")) as PDFRef;
    expect(written.context.lookup(irt)).toBe(byName("h"));

    // The highlight appearance multiplies, so text stays readable under any color.
    const ap = written.context.lookup((byName("h").lookup(PDFName.of("AP")) as PDFDict).get(PDFName.of("N")) as PDFRef);
    const resources = (ap as unknown as { dict: PDFDict }).dict.lookup(PDFName.of("Resources")) as PDFDict;
    expect(resources.toString()).toContain("/BM /Multiply");

    const reread = await parsePdf(out);
    expect(reread.annotations.map((a) => [a.id, a.replyTo])).toEqual([
      ["n", undefined],
      ["h", undefined],
      ["r", "h"],
      ["s", "h"],
    ]);
  });
});
