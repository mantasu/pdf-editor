import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import { CancellationTokenSource, ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseTurn, LanguageModelError, fakeModel, resetMock } from "../__mocks__/vscode";
import { type OpenDoc, ASSISTANT, makeHandler, chatHistory } from "../../src/copilot/participant";

beforeEach(() => resetMock());

const doc: OpenDoc = { fileName: "draft.pdf", context: { pages: ["Intro text"], page: 1, marks: {} }, annotations: [] };

function collector() {
  const parts: string[] = [];
  return { parts, markdown: vi.fn((text: string) => parts.push(text)), progress: vi.fn() };
}

async function run(open: () => Promise<OpenDoc | undefined>, request: { command?: string; prompt?: string; model?: ReturnType<typeof fakeModel> }, turns: unknown[] = []) {
  const out = collector();
  const model = request.model ?? fakeModel(["An ", "answer"], 1_000);
  await makeHandler(open)({ prompt: request.prompt ?? "", command: request.command, model } as never, { history: turns } as never, out as never, new CancellationTokenSource().token as never);
  return { out, model };
}

describe("@pdf in Copilot Chat", () => {
  test("past @pdf turns feed the conversation", () => {
    const turns = [
      new ChatRequestTurn("summarize please", "summarize", ASSISTANT),
      new ChatResponseTurn([new ChatResponseMarkdownPart("A summary"), { other: true }], ASSISTANT),
      new ChatRequestTurn("and why?", undefined, ASSISTANT),
      new ChatResponseTurn([{ progress: true }], ASSISTANT),
      new ChatRequestTurn("unrelated", undefined, "someone.else"),
    ];
    expect(chatHistory({ history: turns } as never).map((m) => [(m as unknown as { role: string }).role, (m as unknown as { content: string }).content])).toEqual([
      ["user", "/summarize summarize please"],
      ["assistant", "A summary"],
      ["user", "and why?"],
    ]);
  });

  test("says so when the PDF, a selection, or Copilot is missing", async () => {
    expect((await run(async () => undefined, {})).out.parts.join("")).toMatch(/^Open a PDF first/u);
    expect((await run(() => Promise.reject(new Error("no viewer")), {})).out.parts.join("")).toMatch(/^Open a PDF first/u);
    expect((await run(async () => doc, { command: "explain" })).out.parts.join("")).toMatch(/^Select a passage in the PDF first/u);
    const selected = { ...doc, context: { ...doc.context, selection: { text: "x", page: 1 } } };
    expect((await run(async () => selected, { command: "explain", model: fakeModel(LanguageModelError.Blocked()) })).out.parts.join("")).toBe("\n\n**Copilot could not answer:** The language model declined this request.");
  });
});
