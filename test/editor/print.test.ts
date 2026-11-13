import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));
vi.mock("node:child_process", () => ({ exec: vi.fn() }));

import { exec } from "node:child_process";
import { printDocument } from "../../src/editor/print";
import { configuration, openedExternally, resetMock, shownErrors } from "../__mocks__/vscode";

type ExecCallback = (error: unknown) => void;
const execMock = exec as unknown as ReturnType<typeof vi.fn>;

function stubExec(error: unknown, stdin = true) {
  execMock.mockImplementation((_command: string, callback: ExecCallback) => {
    callback(error);
    return stdin ? { stdin: { end: vi.fn() } } : {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMock();
});

describe("printDocument", () => {
  test("adds a .pdf extension when the name lacks one", async () => {
    await printDocument(new Uint8Array([1]), "scan");
    expect(openedExternally[0]!.path).toMatch(/\/scan\.pdf$/u);
  });

  test("reports command failures, including non-Error values", async () => {
    configuration.set("printCommand", "lpr");
    stubExec(new Error("printer offline"));
    await printDocument(new Uint8Array([9]), "draft.pdf");
    stubExec("boom");
    await printDocument(new Uint8Array([9]), "draft.pdf");
    expect(shownErrors.join()).toContain("printer offline");
    expect(shownErrors.join()).toContain("boom");
  });

  test("ignores temp-file cleanup failures", async () => {
    configuration.set("printCommand", "lpr");
    stubExec(null);
    const { workspace } = await import("../__mocks__/vscode");
    workspace.fs.delete.mockRejectedValueOnce(new Error("busy"));
    await printDocument(new Uint8Array([1]), "draft.pdf");
    expect(shownErrors).toHaveLength(0);
  });
});
