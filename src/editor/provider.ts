import { basename } from "node:path";
import {
  CancellationToken,
  CancellationTokenSource,
  CustomDocumentBackup,
  CustomDocumentBackupContext,
  CustomDocumentEditEvent,
  CustomDocumentOpenContext,
  CustomEditorProvider,
  EventEmitter,
  ExtensionContext,
  Memento,
  Uri,
  WebviewPanel,
  commands,
  window,
  workspace,
} from "vscode";
import type { Annot } from "../pdf/model";
import { DocState, PdfFile, loadPdf, sameRender } from "./document";
import { HtmlBuilder } from "./html";
import { ACTION_LABELS, PageAction, pageAfter, perform } from "../pdf/pages";
import { printDocument } from "./print";
import type { Prefs, ToHost, ViewerState } from "../protocol";
import { HOST_COMMANDS } from "../protocol";
import { ViewLink, asBytes } from "./session";
import { MODEL_SETTING, askChat, pickModel } from "../copilot/model";
import { type OpenDoc, registerChat } from "../copilot/participant";
import { passagePrompt } from "../copilot/prompts";

export const COMMAND_OPS: ReadonlyArray<[string, PageAction]> = [
  ["pdf-editor.rotatePage", "rotate"],
  ["pdf-editor.deletePage", "delete"],
  ["pdf-editor.movePageUp", "move-up"],
  ["pdf-editor.movePageDown", "move-down"],
  ["pdf-editor.insertBlankPageBefore", "insert-before"],
  ["pdf-editor.insertBlankPageAfter", "insert-after"],
];

const PREFS_KEY = "pdf-editor.preferences";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PdfProvider implements CustomEditorProvider<PdfFile> {
  static readonly viewType = "pdf-editor.viewer";

  static register(context: ExtensionContext): PdfProvider {
    const provider = new PdfProvider(context.extensionUri, HtmlBuilder.load(context.extensionUri.fsPath), context.globalState);
    context.subscriptions.push(
      window.registerCustomEditorProvider(PdfProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      ...COMMAND_OPS.map(([command, action]) =>
        commands.registerCommand(command, (page?: unknown) => provider.runPage(action, page)),
      ),
      commands.registerCommand("pdf-editor.print", () => provider.print()),
      // From the viewer's Copilot card: continue in Copilot Chat with @pdf.
      commands.registerCommand("pdf-editor.askInChat", (query?: unknown, partial?: unknown) =>
        commands.executeCommand("workbench.action.chat.open", { query: typeof query === "string" ? query : "@pdf ", isPartialQuery: partial === true }),
      ),
      commands.registerCommand("pdf-editor.chooseCopilotModel", () => pickModel()),
      registerChat(() => provider.currentDoc()),
    );
    return provider;
  }

  private readonly links = new Map<PdfFile, ViewLink>();
  private readonly pages = new Map<PdfFile, number>();
  /** State transitions run one at a time per document. */
  private readonly queues = new Map<PdfFile, Promise<void>>();
  private focused: PdfFile | undefined;

  private readonly _onEdit = new EventEmitter<CustomDocumentEditEvent<PdfFile>>();
  readonly onDidChangeCustomDocument = this._onEdit.event;

  constructor(
    private readonly extensionUri: Uri,
    private readonly html: HtmlBuilder,
    private readonly prefs: Memento,
  ) {}

  async openCustomDocument(uri: Uri, openContext: CustomDocumentOpenContext): Promise<PdfFile> {
    const source = openContext.backupId ? Uri.parse(openContext.backupId) : uri;
    const file = await PdfFile.open(uri, await loadPdf(source), Boolean(openContext.backupId));
    file.onExternalChange((bytes) => void this.externalChange(file, bytes));
    return file;
  }

  resolveCustomEditor(file: PdfFile, panel: WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(file.uri, ".."), this.extensionUri],
    };
    const link = new ViewLink(panel, (msg) => void this.onMessage(file, link, msg));
    this.links.set(file, link);
    this.focused = file;
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) {
        this.focused = file;
      }
    });
    panel.onDidDispose(() => {
      link.dispose();
      // A newer panel may already have replaced this one (e.g. moved to another group).
      if (this.links.get(file) === link) {
        this.links.delete(file);
        this.pages.delete(file);
        if (this.focused === file) {
          this.focused = undefined;
        }
      }
    });
    panel.webview.html = this.html.render(panel.webview, file.uri, this.prefs.get<Prefs>(PREFS_KEY, {}));
  }

  private async onMessage(file: PdfFile, link: ViewLink, msg: ToHost): Promise<void> {
    if (this.links.get(file) !== link) {
      return; // a replaced panel must not overwrite the current one's state
    }
    switch (msg.type) {
      case "ready":
        link.post({ type: "load", ...file.view(), page: this.pages.get(file) ?? 1 });
        break;
      case "edit":
        this.commit(file, msg.label, file.state, { ...file.state, annotations: msg.annotations as Annot[] });
        break;
      case "form-edit":
        await this.serialize(file, () => this.formEdit(file, link));
        break;
      case "page":
        this.pages.set(file, msg.page);
        break;
      case "command":
        if (HOST_COMMANDS.has(msg.command)) {
          await commands.executeCommand(msg.command, ...(msg.args ?? []));
        }
        break;
      case "open":
        await this.openLink(file, link, msg.url);
        break;
      case "preferences":
        await this.prefs.update(PREFS_KEY, msg.preferences);
        break;
      case "save-image":
        await this.saveImage(file, msg.name, msg.data);
        break;
      case "copilot":
        await this.answer(file, link, msg);
        break;
      case "copilot-cancel":
        link.pendingChat.get(msg.requestId)?.cancel();
        break;
      case "error":
        await window.showErrorMessage(`PDF Viewer: ${msg.message}`);
        break;
    }
  }

  private serialize(file: PdfFile, task: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(file) ?? Promise.resolve()).then(task);
    this.queues.set(file, run.catch(() => undefined));
    return run;
  }

  /** Form values become a history state so undo/redo restores them too. */
  private async formEdit(file: PdfFile, link: ViewLink): Promise<void> {
    const { formData } = await link.fetchState(false);
    if (formData) {
      const before = file.state;
      this.commit(file, "Fill In Form Field", before, { ...before, formData }, false);
    }
  }

  /** Push an undoable transition onto VS Code's edit stack and show `after`. */
  private commit(file: PdfFile, label: string, before: DocState, after: DocState, show = true): void {
    file.setState(after);
    if (show && !sameRender(before, after)) {
      this.paint(file, after);
    }
    this._onEdit.fire({
      document: file,
      label,
      undo: () => {
        file.setState(before);
        this.paint(file, before, after);
      },
      redo: () => {
        file.setState(after);
        this.paint(file, after, before);
      },
    });
  }

  /** Send a state to the viewer: a full reload only when the PDF itself differs. */
  private paint(file: PdfFile, state: DocState, previous?: DocState): void {
    const link = this.links.get(file);
    if (!link) {
      return;
    }
    if (previous && sameRender(previous, state)) {
      link.post({ type: "annotations", annotations: [...state.annotations] });
    } else {
      link.post({ type: "load", ...file.view(state), page: this.pages.get(file) ?? 1 });
    }
  }

  private async stateOf(file: PdfFile, flush = true): Promise<ViewerState> {
    const link = this.links.get(file);
    return link ? link.fetchState(flush) : { annotations: [...file.state.annotations] };
  }

  async saveCustomDocument(file: PdfFile): Promise<void> {
    const snapshot = await this.stateOf(file);
    // Read after the snapshot: the viewer commits text being typed just before answering.
    const state = file.state;
    const bytes = await file.build(snapshot);
    file.expectWrite(bytes);
    await workspace.fs.writeFile(file.uri, bytes);
    file.markSaved(state);
  }

  async saveCustomDocumentAs(file: PdfFile, destination: Uri): Promise<void> {
    await workspace.fs.writeFile(destination, await file.build(await this.stateOf(file)));
  }

  async revertCustomDocument(file: PdfFile): Promise<void> {
    file.replace(await file.parse(await loadPdf(file.uri)));
    this.paint(file, file.state);
  }

  async backupCustomDocument(
    file: PdfFile,
    context: CustomDocumentBackupContext,
    _token: CancellationToken,
  ): Promise<CustomDocumentBackup> {
    // Backups run in the background after edits: they must not interrupt typing.
    await workspace.fs.writeFile(context.destination, await file.build(await this.stateOf(file, false)));
    return {
      id: context.destination.toString(),
      delete: () => void workspace.fs.delete(context.destination).then(undefined, () => undefined),
    };
  }

  private externalChange(file: PdfFile, bytes: Uint8Array): Promise<void> {
    return this.serialize(file, async () => {
      const next = await file.parse(bytes);
      // Checked after parsing: the user may have edited in the meantime.
      if (file.dirty) {
        await window.showWarningMessage(
          `PDF Viewer: ${basename(file.uri.path)} changed on disk. Your unsaved changes are kept; use "File: Revert File" to load the new version.`,
        );
        return;
      }
      file.replace(next);
      this.paint(file, next);
    });
  }

  /** Page operations edit the in-memory PDF (comments included) and are undoable. */
  async runPage(action: PageAction, pageArg?: unknown): Promise<void> {
    const file = this.focused;
    if (!file) {
      await window.showWarningMessage("PDF Viewer: open a PDF first.");
      return;
    }
    if (file.readOnly) {
      await window.showErrorMessage(`PDF Viewer: pages cannot be changed. ${file.readOnly}`);
      return;
    }
    const page =
      typeof pageArg === "number" && Number.isInteger(pageArg) && pageArg > 0
        ? pageArg
        : (this.pages.get(file) ?? 1);
    try {
      await this.serialize(file, async () => {
        const snapshot = await this.stateOf(file);
        const start = file.state;
        const merged = await file.build(snapshot);
        const result = await perform(action, merged, page);
        if (!result) {
          return;
        }
        const before = await file.parse(merged);
        const after = await file.parse(result);
        if (file.state !== start) {
          await window.showWarningMessage(`PDF Viewer: the document changed while running "${ACTION_LABELS[action]}"; please try again.`);
          return;
        }
        this.pages.set(file, pageAfter(action, page));
        this.commit(file, ACTION_LABELS[action], before, after);
      });
    } catch (error) {
      await window.showErrorMessage(`PDF Viewer: ${reason(error)}`);
    }
  }

  /** Answer a question about a selected passage, streaming the text to the viewer. */
  private async answer(file: PdfFile, link: ViewLink, msg: Extract<ToHost, { type: "copilot" }>): Promise<void> {
    const source = new CancellationTokenSource();
    link.pendingChat.set(msg.requestId, source);
    let error: string | undefined;
    try {
      const preferred = workspace.getConfiguration("pdf-editor", file.uri).get<string>(MODEL_SETTING, "");
      await askChat(passagePrompt({ ...msg, fileName: basename(file.uri.path) }), source.token, (text) => link.post({ type: "copilot-text", requestId: msg.requestId, text }), preferred);
    } catch (failure) {
      error = source.token.isCancellationRequested ? undefined : reason(failure); // stopping is not an error
    }
    link.pendingChat.delete(msg.requestId);
    source.dispose();
    link.post({ type: "copilot-done", requestId: msg.requestId, ...(error && { error }) });
  }

  /** The focused PDF for @pdf: its name, text, selection and comments. */
  async currentDoc(): Promise<OpenDoc | undefined> {
    const file = this.focused;
    const link = file && this.links.get(file);
    if (!file || !link) {
      return undefined;
    }
    return { fileName: basename(file.uri.path), context: await link.fetchContext(), annotations: file.state.annotations };
  }

  async print(): Promise<void> {
    const file = this.focused;
    if (!file) {
      await window.showWarningMessage("PDF Viewer: open a PDF first.");
      return;
    }
    try {
      await printDocument(await file.build(await this.stateOf(file)), basename(file.uri.path));
    } catch (error) {
      await window.showErrorMessage(`PDF Viewer: ${reason(error)}`);
    }
  }

  /** Save a PNG the viewer rendered, by default next to the PDF as `<pdf name>-<what it is>.png`. */
  private async saveImage(file: PdfFile, name: string, data: unknown): Promise<void> {
    const bytes = asBytes(data);
    const stem = basename(file.uri.path).replace(/\.pdf$/iu, "");
    const suggested = `${stem}-${name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.png`;
    const target = bytes && (await window.showSaveDialog({ defaultUri: Uri.joinPath(file.uri, "..", suggested), filters: { "PNG Image": ["png"] } }));
    if (!target) {
      return;
    }
    try {
      await workspace.fs.writeFile(target, bytes);
    } catch (error) {
      await window.showErrorMessage(`PDF Viewer: ${reason(error)}`);
    }
  }

  /** Relative links in the PDF resolve to files next to it; open those in VS Code. */
  private async openLink(file: PdfFile, link: ViewLink, url: string): Promise<void> {
    const folder = Uri.joinPath(file.uri, "..");
    const root = `${link.panel.webview.asWebviewUri(folder).toString(true).replace(/\/$/u, "")}/`;
    if (!url.startsWith(root)) {
      return;
    }
    const [path = "", fragment = ""] = url.slice(root.length).split(/#(.*)/su);
    try {
      const relative = decodeURIComponent(path);
      if (relative) {
        await commands.executeCommand("vscode.open", Uri.joinPath(folder, relative).with({ fragment: decodeURIComponent(fragment) }));
      }
    } catch {
      // Malformed URL from the document: ignore.
    }
  }
}
