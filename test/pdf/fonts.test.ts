import { StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { chooseFace, faceWorks } from "../../src/pdf/fonts";

describe("text-box fonts", () => {
  test("bundled families draw with their own files; standard families and standardOnly with the 14 fonts", () => {
    expect(chooseFace({ family: "Lora", bold: true, italic: true }).file).toMatch(/resources[/\\]fonts[/\\]Lora-BoldItalic\.ttf$/u);
    expect(chooseFace({ family: "Lora", italic: true }, true)).toEqual({ key: StandardFonts.TimesRomanItalic, standard: StandardFonts.TimesRomanItalic });
    expect(chooseFace({ family: "Times", bold: true })).toEqual({ key: StandardFonts.TimesRomanBold, standard: StandardFonts.TimesRomanBold });
    expect(chooseFace({ family: "Unheard Of" as never }).standard).toBe(StandardFonts.Helvetica);
  });

  test("faceWorks tries the text in a scratch document first", async () => {
    expect(await faceWorks(chooseFace({ family: "Roboto" }), "Hello → world")).toBe(true);
    expect(await faceWorks(chooseFace({ family: "Times" }), "x")).toBe(true); // standard fonts need no trial
    expect(await faceWorks({ key: "broken", file: __filename }, "x")).toBe(false); // not a font at all
  });
});
