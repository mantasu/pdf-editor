import { describe, expect, test } from "vitest";
import { fromMarkdown, unifyMath } from "../../resources/viewer/markdown.mjs";

describe("rendering Copilot answers", () => {
  test("all LaTeX delimiters normalize to $...$", () => {
    expect(unifyMath("a \\(x^2\\) b \\[\n y \n\\] $$z\n+1$$\r")).toBe("a $x^2$ b $y$ $z +1$");
  });

  test("inline markup converts, maths survives untouched", () => {
    const { contents, rich } = fromMarkdown("**bold** and *it* and _it2_ and `code` and $a_1 * b_2$ and [link](https://x.y) snake_case 2*3*4");
    expect(contents).toBe("bold and it and it2 and code and $a_1 * b_2$ and link (https://x.y) snake_case 2*3*4");
    expect(rich).toEqual([
      [
        { text: "bold", bold: true },
        { text: " and " },
        { text: "it", italic: true },
        { text: " and " },
        { text: "it2", italic: true },
        { text: " and " },
        { text: "code", code: true },
        { text: " and $a_1 * b_2$ and link (https://x.y) snake_case 2*3*4" },
      ],
    ]);
  });

  test("__double underscores__ mean bold", () => {
    expect(fromMarkdown("__under__")).toEqual({ contents: "under", rich: [[{ text: "under", bold: true }]] });
  });

  test("block elements: headings, lists, quotes, fences, rules", () => {
    const { contents, rich } = fromMarkdown("\n\n## Title\n\n\n- one\n  * nested\n1. first\n> quoted\n---\n```js\nconst x = 1;\n\n```\nplain\n\n");
    expect(contents).toBe("Title\n\n• one\n  • nested\n1. first\nquoted\nconst x = 1;\n\nplain");
    expect(rich![0]).toEqual([{ text: "Title", bold: true }]);
    expect(rich![5]).toEqual([{ text: "quoted", italic: true }]);
    expect(rich![6]).toEqual([{ text: "const x = 1;", code: true }]);
  });
});
