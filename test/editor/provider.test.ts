import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));
vi.mock("../../src/editor/print", () => ({ printDocument: vi.fn(async () => undefined) }));

import {
  EventEmitter,
  Uri,
  commands,
  configuration,
  executedCommands,
  chatHandlers,
  fakeModel,
  languageModels,
  files,
  registeredCommands,
  resetMock,
  shownErrors,
  shownWarnings,
  watchers,
  window,
  workspace,
} from "../__mocks__/vscode";
import type { Annot } from "../../src/pdf/model";
import { parsePdf } from "../../src/pdf/read";
import { HtmlBuilder } from "../../src/editor/html";
import { printDocument } from "../../src/editor/print";
import { PdfProvider } from "../../src/editor/provider";
import type { PdfFile } from "../../src/editor/document";

const uri = Uri.file("/docs/draft.pdf");

async function blankPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage([300, 400]);
  }
  return doc.save();
}

const sticky = (id: string, page = 0): Annot => ({
  id,
  kind: "note",
  subtype: "Text",
  page,
  rect: [10, 10, 34, 34],
  opacity: 1,
  contents: `note ${id}`,
  author: "me",
});

type Message = { type: string; [key: string]: unknown };

function stubPanel() {
  const received = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const viewState = new EventEmitter<{ webviewPanel: { active: boolean } }>();
  const posted: Message[] = [];
  let snapshot: (() => unknown) | undefined = () => ({ annotations: [] });
  let viewerContext: unknown = { pages: ["Page one"], page: 1, marks: {} };
  const panel = {
    active: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (target: Uri) => Uri.parse(`https://webview${target.path}`),
      onDidReceiveMessage: received.event,
      postMessage: vi.fn(async (message: Message) => {
        posted.push(message);
        if (message.type === "request-snapshot" && snapshot) {
          const value = snapshot();
          queueMicrotask(() => received.fire({ type: "snapshot", requestId: message.requestId, snapshot: value }));
        }
        if (message.type === "request-context") {
          queueMicrotask(() => received.fire({ type: "context", requestId: message.requestId, context: viewerContext }));
        }
        return true;
      }),
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: viewState.event,
  };
  return {
    panel,
    posted,
    send: async (message: Message) => {
      received.fire(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    answer: (fn: (() => unknown) | undefined) => {
      snapshot = fn;
    },
    reportContext: (value: unknown) => {
      viewerContext = value;
    },
    dispose: () => disposed.fire(),
    setActive: (active: boolean) => viewState.fire({ webviewPanel: { active } }),
  };
}

const html = { render: vi.fn(() => "<html>viewer</html>") } as unknown as HtmlBuilder;

/** VS Code's global state, as a plain map. */
const stateMap = new Map<string, unknown>();
const memento = {
  get: <T>(key: string, fallback: T) => (stateMap.has(key) ? stateMap.get(key) : fallback) as T,
  update: vi.fn(async (key: string, value: unknown) => void stateMap.set(key, value)),
};

async function openViewer(bytes?: Uint8Array) {
  const provider = new PdfProvider(Uri.file("/ext") as never, html, memento as never);
  files.set(uri.toString(), bytes ?? (await blankPdf()));
  const edits: Array<{ label: string; undo(): void; redo(): void }> = [];
  provider.onDidChangeCustomDocument((event) => void edits.push(event as never));
  const document = await provider.openCustomDocument(uri as never, { backupId: undefined, untitledDocumentData: undefined });
  const fake = stubPanel();
  provider.resolveCustomEditor(document, fake.panel as never);
  return { provider, document, fake, edits };
}

const tail = (fake: ReturnType<typeof stubPanel>) => fake.posted.at(-1)!;

beforeEach(() => {
  stateMap.clear();
  resetMock();
  vi.clearAllMocks();
});

describe("PdfProvider", () => {
  test("registered commands reach the active document", async () => {
    const context = { extensionUri: Uri.file(process.cwd()), globalState: memento, subscriptions: [] as unknown[] };
    PdfProvider.register(context as never);
    await registeredCommands.get("pdf-editor.print")!();
    await registeredCommands.get("pdf-editor.rotatePage")!(1);
    await registeredCommands.get("pdf-editor.chooseCopilotModel")!();
    expect(shownWarnings).toEqual(["PDF Viewer: open a PDF first.", "PDF Viewer: open a PDF first.", expect.stringContaining("No language model")]);
  });

  test("resolves the webview and loads the document when ready", async () => {
    const { fake } = await openViewer();
    expect(fake.panel.webview.html).toBe("<html>viewer</html>");
    expect(fake.panel.webview.options).toMatchObject({ enableScripts: true });
    await fake.send({ type: "ready" });
    expect(tail(fake)).toMatchObject({ type: "load", annotations: [], page: 1 });
  });

  test("viewer preferences are kept in VS Code's global state", async () => {
    const { fake, provider, document } = await openViewer();
    expect(html.render).toHaveBeenLastCalledWith(fake.panel.webview, uri, {});
    await fake.send({ type: "preferences", preferences: { recentColors: ["#123456"] } });
    expect(memento.update).toHaveBeenCalledWith("pdf-editor.preferences", { recentColors: ["#123456"] });
    provider.resolveCustomEditor(document, stubPanel().panel as never);
    expect(html.render).toHaveBeenLastCalledWith(expect.anything(), uri, { recentColors: ["#123456"] });
  });

  test("saves a drawing or signature the viewer sends as PNG where the user picks", async () => {
    const { fake } = await openViewer();
    const png = new Uint8Array([137, 80, 78, 71]);
    const target = Uri.file("/docs/sig.png");
    vi.mocked(window.showSaveDialog).mockResolvedValueOnce(target);
    await fake.send({ type: "save-image", name: "Signature", data: png.buffer });
    expect(window.showSaveDialog).toHaveBeenCalledWith({ defaultUri: Uri.file("/docs/draft-signature.png"), filters: { "PNG Image": ["png"] } });
    expect(files.get(target.toString())).toEqual(png);
    // Cancelling the dialog, malformed data, then a failed write.
    await fake.send({ type: "save-image", name: "Drawing", data: png });
    await fake.send({ type: "save-image", name: "Image", data: "not bytes" });
    expect(window.showSaveDialog).toHaveBeenCalledTimes(2);
    vi.mocked(window.showSaveDialog).mockResolvedValueOnce(target);
    vi.mocked(workspace.fs.writeFile).mockRejectedValueOnce(new Error("read-only"));
    await fake.send({ type: "save-image", name: "Drawing", data: png });
    expect(shownErrors).toEqual(["PDF Viewer: read-only"]);
  });

  test("restores a hot-exit backup", async () => {
    const provider = new PdfProvider(Uri.file("/ext") as never, html, memento as never);
    const backup = Uri.file("/backups/1");
    const document = await (async () => {
      const source = await blankPdf();
      const { mergeAnnotations } = await import("../../src/pdf/write");
      files.set(backup.toString(), await mergeAnnotations(source, [sticky("restored")]));
      return provider.openCustomDocument(uri as never, { backupId: backup.toString(), untitledDocumentData: undefined });
    })();
    expect(document.state.annotations.map((a) => a.id)).toEqual(["restored"]);
  });

  test("edits become undoable VS Code edits", async () => {
    const { document, fake, edits } = await openViewer();
    await fake.send({ type: "edit", label: "Add Sticky Note", annotations: [sticky("a")] });
    expect(edits.map((e) => e.label)).toEqual(["Add Sticky Note"]);
    expect(document.dirty).toBe(true);
    expect(document.state.annotations.map((a) => a.id)).toEqual(["a"]);

    edits[0]!.undo();
    expect(document.state.annotations).toEqual([]);
    expect(tail(fake)).toEqual({ type: "annotations", annotations: [] });
    expect(document.dirty).toBe(false);

    edits[0]!.redo();
    expect(tail(fake)).toMatchObject({ type: "annotations", annotations: [{ id: "a" }] });
  });

  test("form edits are undoable states holding pdf.js's form output", async () => {
    const { document, fake, edits } = await openViewer();
    const formData = await blankPdf(1);
    fake.answer(() => ({ annotations: [], formData }));
    await fake.send({ type: "form-edit" });
    await vi.waitFor(() => expect(edits).toHaveLength(1));
    expect(edits[0]!.label).toBe("Fill In Form Field");
    expect(document.state.formData).toBe(formData);
    expect(document.dirty).toBe(true);
    expect(fake.posted.at(-1)!.type).toBe("request-snapshot"); // the viewer already shows the values

    edits[0]!.undo();
    expect(document.dirty).toBe(false);
    expect(tail(fake)).toMatchObject({ type: "load" });
    expect((tail(fake).data as Uint8Array)).not.toBe(formData);
    edits[0]!.redo();
    expect(tail(fake).data).toBe(formData);

    // A snapshot without form data (nothing changed after all) records nothing.
    fake.answer(() => ({ annotations: [] }));
    await fake.send({ type: "form-edit" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(edits).toHaveLength(1);
  });

  test("messages from a replaced panel are ignored", async () => {
    const { provider, document, fake } = await openViewer();
    const replacement = stubPanel();
    provider.resolveCustomEditor(document, replacement.panel as never);
    await fake.send({ type: "edit", label: "stale", annotations: [sticky("old")] });
    expect(document.state.annotations).toEqual([]);
  });

  test("a page operation is abandoned when the document changed meanwhile", async () => {
    const { provider, document, fake, edits } = await openViewer();
    fake.answer(() => ({ annotations: [] }));
    // An edit arrives after the snapshot, while the operation is still running.
    const build = document.build.bind(document);
    vi.spyOn(document, "build").mockImplementationOnce(async (snapshot) => {
      await fake.send({ type: "edit", label: "Add", annotations: [sticky("late")] });
      return build(snapshot);
    });
    await provider.runPage("rotate", 1);
    expect(shownWarnings.join()).toContain("changed while running");
    expect(document.state.annotations.map((a) => a.id)).toEqual(["late"]);
    expect(edits.map((e) => e.label)).toEqual(["Add"]);
  });

  test("runs allowlisted commands only, and reports webview errors", async () => {
    const { fake } = await openViewer();
    await fake.send({ type: "command", command: "undo" });
    await fake.send({ type: "command", command: "pdf-editor.print", args: [] });
    await fake.send({ type: "command", command: "workbench.action.terminal.new" });
    expect(executedCommands.map((c) => c.command)).toEqual(["undo", "pdf-editor.print"]);
    await fake.send({ type: "error", message: "boom" });
    expect(shownErrors).toEqual(["PDF Viewer: boom"]);
  });

  test("opens relative links next to the PDF", async () => {
    const { fake } = await openViewer();
    await fake.send({ type: "open", url: "https://webview/docs/notes/a%20b.md#L3" });
    await fake.send({ type: "open", url: "https://webview/elsewhere/x.md" });
    await fake.send({ type: "open", url: "https://webview/docs/" });
    await fake.send({ type: "open", url: "https://webview/docs/%E0%A4%A" });
    expect(executedCommands).toHaveLength(1);
    const target = executedCommands[0]!.args[0] as Uri;
    expect(target.path).toBe("/docs/notes/a b.md");
    expect(target.fragment).toBe("L3");
  });

  test("save without a webview uses the document's own state", async () => {
    const { provider, document, fake } = await openViewer();
    await fake.send({ type: "edit", label: "Add", annotations: [sticky("a")] });
    fake.dispose();
    await provider.saveCustomDocument(document);
    expect((await parsePdf(files.get(uri.toString())!)).annotations.map((a) => a.id)).toEqual(["a"]);
  });

  test("save as writes elsewhere", async () => {
    const { provider, document, fake } = await openViewer();
    fake.answer(() => ({ annotations: [sticky("b")] }));
    const target = Uri.file("/docs/copy.pdf");
    await provider.saveCustomDocumentAs(document, target as never);
    expect((await parsePdf(files.get(target.toString())!)).annotations.map((a) => a.id)).toEqual(["b"]);
  });

  test("revert reloads the file from disk", async () => {
    const { provider, document, fake } = await openViewer();
    await fake.send({ type: "edit", label: "Add", annotations: [sticky("a")] });
    await provider.revertCustomDocument(document);
    expect(document.state.annotations).toEqual([]);
    expect(document.dirty).toBe(false);
    expect(tail(fake)).toMatchObject({ type: "load", annotations: [] });
  });

  test("external changes reload clean documents and warn about dirty ones", async () => {
    const { document, fake } = await openViewer();
    const { mergeAnnotations } = await import("../../src/pdf/write");
    const changed = await mergeAnnotations(await blankPdf(), [sticky("disk")]);
    files.set(uri.toString(), changed);
    watchers[0]!.fireChange(uri);
    await vi.waitFor(() => expect(document.state.annotations.map((a) => a.id)).toEqual(["disk"]));
    expect(tail(fake)).toMatchObject({ type: "load" });

    await fake.send({ type: "edit", label: "Add", annotations: [sticky("mine")] });
    files.set(uri.toString(), await blankPdf(3));
    watchers[0]!.fireChange(uri);
    await vi.waitFor(() => expect(shownWarnings.join()).toContain("changed on disk"));
    expect(document.state.annotations.map((a) => a.id)).toEqual(["mine"]);
  });

  test("page operations are in-memory, undoable and keep comments", async () => {
    const { provider, document, fake, edits } = await openViewer();
    await fake.send({ type: "page", page: 1 });
    fake.answer(() => ({ annotations: [sticky("a", 0)] }));
    await provider.runPage("move-down");
    expect(edits.at(-1)!.label).toBe("Move Page Down");
    expect(document.state.annotations.map((a) => [a.contents, a.page])).toEqual([["note a", 1]]);
    expect(tail(fake)).toMatchObject({ type: "load", page: 2 });
    expect(files.get(uri.toString())!.length).toBeGreaterThan(0);
    expect(document.dirty).toBe(true);

    edits.at(-1)!.undo();
    expect(document.state.annotations.map((a) => a.page)).toEqual([0]);
    expect(tail(fake)).toMatchObject({ type: "load" });
    edits.at(-1)!.redo();
    expect(document.state.annotations.map((a) => a.page)).toEqual([1]);
  });

  test("no-op and failing page operations", async () => {
    const { provider, fake, edits } = await openViewer(await blankPdf(1));
    fake.answer(() => ({ annotations: [] }));
    await provider.runPage("move-up", 1);
    expect(edits).toHaveLength(0);
    await provider.runPage("delete", 1);
    expect(shownErrors.join()).toContain("only page");
    fake.answer(undefined);
    vi.useFakeTimers();
    const pending = provider.runPage("rotate", 1);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    vi.useRealTimers();
    expect(shownErrors.join()).toContain("did not respond");
  });

  test("page operations are refused for read-only files", async () => {
    const { provider } = await openViewer(new TextEncoder().encode("garbage"));
    await provider.runPage("rotate", 1);
    expect(shownErrors.join()).toContain("pages cannot be changed");
  });

  test("print sends the merged PDF to the printer", async () => {
    const { provider, fake } = await openViewer();
    fake.answer(() => ({ annotations: [sticky("p")] }));
    await provider.print();
    expect(printDocument).toHaveBeenCalledWith(expect.any(Uint8Array), "draft.pdf");
    vi.mocked(printDocument).mockRejectedValueOnce("printer on fire");
    await provider.print();
    expect(shownErrors.join()).toContain("printer on fire");
  });

  test("tracks the active editor and forgets disposed panels", async () => {
    const { provider, fake } = await openViewer();
    fake.setActive(false);
    fake.setActive(true);
    fake.dispose();
    await provider.print();
    await provider.runPage("rotate");
    expect(shownWarnings).toEqual(["PDF Viewer: open a PDF first.", "PDF Viewer: open a PDF first."]);
  });

  test("undo after the panel closed does not post anywhere", async () => {
    const { fake, edits } = await openViewer();
    await fake.send({ type: "edit", label: "Add", annotations: [sticky("a")] });
    const count = fake.posted.length;
    fake.dispose();
    edits[0]!.undo();
    expect(fake.posted.length).toBe(count);
  });

  test("a second panel keeps the first one active until it closes", async () => {
    const { provider, document, fake } = await openViewer();
    const other = stubPanel();
    provider.resolveCustomEditor(document as PdfFile, other.panel as never);
    fake.dispose();
    other.answer(() => ({ annotations: [] }));
    await provider.print();
    expect(printDocument).toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  test("page operations default to the first page before the viewer reports one", async () => {
    const { provider, document, fake } = await openViewer();
    fake.answer(() => ({ annotations: [] }));
    await provider.runPage("rotate", "not a page");
    expect((await PDFDocument.load(document.state.working)).getPage(0).getRotation().angle).toBe(90);
  });

  test("closing a background document keeps the active one", async () => {
    const { provider, fake } = await openViewer();
    const otherUri = Uri.file("/docs/other.pdf");
    files.set(otherUri.toString(), await blankPdf());
    const other = await provider.openCustomDocument(otherUri as never, { backupId: undefined, untitledDocumentData: undefined });
    const otherPanel = stubPanel();
    provider.resolveCustomEditor(other, otherPanel.panel as never);
    otherPanel.answer(() => ({ annotations: [] }));
    fake.dispose();
    await provider.print();
    expect(printDocument).toHaveBeenCalledWith(expect.any(Uint8Array), "other.pdf");
  });

  test("backup deletion ignores missing files", async () => {
    const { provider, document, fake } = await openViewer();
    fake.answer(() => ({ annotations: [] }));
    const { workspace } = await import("../__mocks__/vscode");
    const backup = await provider.backupCustomDocument(document, { destination: Uri.file("/b/3") } as never, {} as never);
    workspace.fs.delete.mockRejectedValueOnce(new Error("gone"));
    expect(() => backup.delete()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("Ask Copilot uses the model named in pdf-editor.copilot.model", async () => {
    const { fake } = await openViewer();
    languageModels.push(fakeModel(["from Copilot"]), fakeModel(["from Claude"], 64_000, { id: "claude-x", name: "Claude X", family: "claude", vendor: "anthropic" }));
    configuration.set("copilot.model", "claude-x");
    await fake.send({ type: "copilot", requestId: 8, action: "explain", selection: "x", pageText: "", page: 1 });
    await vi.waitFor(() => expect(tail(fake)).toEqual({ type: "copilot-done", requestId: 8 }));
    expect(fake.posted.filter((m) => m.type === "copilot-text").map((m) => m.text)).toEqual(["from Claude"]);
  });

  test("Ask Copilot reports errors, and stopping is not one", async () => {
    const { fake } = await openViewer();
    await fake.send({ type: "copilot", requestId: 1, action: "summarize", selection: "x", pageText: "", page: 1 });
    await vi.waitFor(() => expect(tail(fake)).toMatchObject({ type: "copilot-done", requestId: 1, error: expect.stringContaining("No language model") }));

    // A request stopped by the viewer ends quietly.
    let release: () => void = () => undefined;
    const model = fakeModel(["partial"]);
    model.sendRequest.mockImplementationOnce(async (_m, _o, token) => {
      await new Promise<void>((resolve) => (release = resolve));
      if ((token as { isCancellationRequested: boolean }).isCancellationRequested) {
        throw new Error("Cancelled");
      }
      return { text: (async function* () {})() };
    });
    languageModels.push(model);
    void fake.send({ type: "copilot", requestId: 2, action: "ask", question: "Why?", selection: "x", pageText: "", page: 1 });
    await vi.waitFor(() => expect(model.sendRequest).toHaveBeenCalled());
    await fake.send({ type: "copilot-cancel", requestId: 2 });
    await fake.send({ type: "copilot-cancel", requestId: 99 });
    release();
    await vi.waitFor(() => expect(tail(fake)).toEqual({ type: "copilot-done", requestId: 2 }));
  });

  test("closing the panel stops Copilot requests", async () => {
    const { fake } = await openViewer();
    let token: { isCancellationRequested: boolean } | undefined;
    const model = fakeModel([]);
    model.sendRequest.mockImplementationOnce(async (_m, _o, t) => {
      token = t as typeof token;
      return new Promise(() => undefined);
    });
    languageModels.push(model);
    void fake.send({ type: "copilot", requestId: 3, action: "define", selection: "x", pageText: "", page: 1 });
    await vi.waitFor(() => expect(token).toBeDefined());
    fake.dispose();
    expect(token!.isCancellationRequested).toBe(true);
  });

  test("@pdf gets the active PDF's text, selection and comments", async () => {
    const context = { extensionUri: Uri.file(process.cwd()), globalState: memento, subscriptions: [] as unknown[] };
    const provider = PdfProvider.register(context as never);
    expect(await provider.currentDoc()).toBeUndefined();
    files.set(uri.toString(), await blankPdf());
    const document = await provider.openCustomDocument(uri as never, { backupId: undefined, untitledDocumentData: undefined });
    const fake = stubPanel();
    provider.resolveCustomEditor(document, fake.panel as never);
    fake.reportContext({ pages: ["One", 2], page: 1 });
    await expect(provider.currentDoc()).rejects.toThrow("invalid response");
    fake.reportContext({ pages: ["One"], page: 1, selection: { text: "One", page: 1 }, marks: { a: "One", b: 3 } });
    expect(await provider.currentDoc()).toEqual({ fileName: "draft.pdf", context: { pages: ["One"], page: 1, selection: { text: "One", page: 1 }, marks: { a: "One" } }, annotations: [] });
    fake.reportContext({ pages: [], page: 1, selection: { text: 5 } });
    expect((await provider.currentDoc())!.context).toEqual({ pages: [], page: 1, marks: {} });
    fake.reportContext(null);
    await expect(provider.currentDoc()).rejects.toThrow("invalid response");

    // The registered @pdf participant answers from it.
    fake.reportContext({ pages: ["Registered text"], page: 1, marks: {} });
    const model = fakeModel(["ok"]);
    const markdown = vi.fn();
    await chatHandlers.get("pdf.assistant")!({ prompt: "What?", model }, { history: [] }, { markdown, progress: vi.fn() }, {});
    expect(markdown).toHaveBeenCalledWith("ok");
    expect((model.sendRequest.mock.calls[0]![0] as unknown as Array<{ content: string }>)[0]!.content).toContain("Registered text");
  });

  test("Continue in Chat opens Copilot Chat with @pdf", async () => {
    const context = { extensionUri: Uri.file(process.cwd()), globalState: memento, subscriptions: [] as unknown[] };
    PdfProvider.register(context as never);
    await registeredCommands.get("pdf-editor.askInChat")!("@pdf /explain ", true);
    await registeredCommands.get("pdf-editor.askInChat")!();
    expect(executedCommands).toEqual([
      { command: "workbench.action.chat.open", args: [{ query: "@pdf /explain ", isPartialQuery: true }] },
      { command: "workbench.action.chat.open", args: [{ query: "@pdf ", isPartialQuery: false }] },
    ]);
  });
});
