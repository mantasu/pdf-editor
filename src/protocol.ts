/** Host <-> viewer (resources/viewer) message protocol. Field names and type strings are wire format: keep them in sync with the viewer. */
import type { AskAction, DocContext } from "./copilot/prompts";
import type { Annot } from "./pdf/model";

export type { DocContext };

/** What the webview reports when asked for its state (save, print, page ops, backups). */
export interface ViewerState {
  annotations: Annot[];
  /** pdf.js `saveDocument()` output when form fields were filled in, else absent. */
  formData?: Uint8Array;
}

/** Webview -> extension. */
export type ToHost =
  | { type: "ready" }
  | { type: "edit"; label: string; annotations: Annot[] }
  | { type: "form-edit" }
  | { type: "snapshot"; requestId: number; snapshot: ViewerState }
  | { type: "page"; page: number }
  | { type: "command"; command: string; args?: unknown[] }
  | { type: "open"; url: string }
  | { type: "preferences"; preferences: Prefs }
  /** A drawing, picture or signature as PNG, to save where the user picks; `name` is what it is ("Signature"). */
  | { type: "save-image"; name: string; data: Uint8Array }
  /** A question about a selected passage; answered with copilot-text chunks, then copilot-done. */
  | { type: "copilot"; requestId: number; action: AskAction; question?: string; selection: string; pageText: string; page: number }
  | { type: "copilot-cancel"; requestId: number }
  | { type: "context"; requestId: number; context: DocContext }
  | { type: "error"; message: string };

/** Extension -> webview. */
export type ToWebview =
  | { type: "load"; data: Uint8Array; annotations: Annot[]; readOnly?: string; page?: number }
  | { type: "annotations"; annotations: Annot[] }
  /** `flush`: commit what is being typed first (save, print, page ops; not backups). */
  | { type: "request-snapshot"; requestId: number; flush: boolean }
  /** For @pdf: the text, page in view, selection and marked text. */
  | { type: "request-context"; requestId: number }
  | { type: "copilot-text"; requestId: number; text: string }
  | { type: "copilot-done"; requestId: number; error?: string };

/** Viewer settings kept across documents and sessions (VS Code global state); owned by the webview. */
export type Prefs = Record<string, unknown>;

export interface Swatch {
  name: string;
  /** `#RRGGBB`. */
  color: string;
}

/** Injected into the webview HTML; read by resources/viewer/core.mjs. */
export interface ViewerConfig {
  /** Webview URI of the pdf.js `build/` directory, trailing slash. */
  pdfJsBuild: string;
  /** Webview URI of the pdf.js `web/` directory, trailing slash. */
  pdfJsWeb: string;
  /** Webview URI of node_modules/@mathjax (MathJax 4's browser bundle and its TeX font), trailing slash; loaded when maths first shows. */
  mathJax: string;
  /** Webview URI of resources/fonts (the text-box fonts), trailing slash. */
  fonts: string;
  /** Webview URI of the PDF itself: base for relative links. */
  documentUrl: string;
  /** Webview URI of the PDF's folder, trailing slash. */
  resourceRoot: string;
  fileName: string;
  defaultZoomValue: string;
  sidebarViewOnLoad: number;
  presetColors: Swatch[];
  /** Author (`/T`) stamped onto new comments. */
  authorName: string;
  preferences: Prefs;
}

export function isToHost(value: unknown): value is ToHost {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Commands the webview may run in the host (toolbar, context menu, keyboard). */
export const HOST_COMMANDS: ReadonlySet<string> = new Set([
  "pdf-editor.rotatePage",
  "pdf-editor.deletePage",
  "pdf-editor.movePageUp",
  "pdf-editor.movePageDown",
  "pdf-editor.insertBlankPageBefore",
  "pdf-editor.insertBlankPageAfter",
  "pdf-editor.print",
  "pdf-editor.askInChat",
  "workbench.action.files.save",
  "undo",
  "redo",
]);
