import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { userInfo } from "node:os";
import { Uri, Webview, workspace } from "vscode";
import type { Prefs, Swatch, ViewerConfig } from "../protocol";

/** Stock viewer.html tags replaced by webview-safe ones. */
const REMOVED = [
  /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>\s*/giu,
  /<link\b[^>]*href=["']locale\/locale\.json["'][^>]*>\s*/giu,
  /<script\b[^>]*src=["'][^"']*pdf\.mjs["'][^>]*><\/script>\s*/giu,
  /<script\b[^>]*src=["']viewer\.mjs["'][^>]*><\/script>\s*/giu,
  /<link\b[^>]*href=["']viewer\.css["'][^>]*>\s*/giu,
];

/** Shared by every tool: bright enough to highlight with, dark enough to draw with. */
export const BASE_SWATCHES: readonly string[] = ["Yellow=#FFD60A", "Red=#FF453A", "Purple=#AF52DE", "Green=#30D158", "Blue=#409CFF"];

export function parseSwatches(entries: readonly unknown[]): Swatch[] {
  const swatches: Swatch[] = [];
  for (const entry of entries) {
    const match = typeof entry === "string" ? /^\s*([^=]+?)\s*=\s*(#[0-9a-f]{6})\s*$/iu.exec(entry) : null;
    if (match) {
      swatches.push({ name: match[1]!, color: match[2]!.toUpperCase() });
    }
  }
  return swatches;
}

export function escAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function csp(source: string): string {
  return [
    "default-src 'none'",
    `connect-src ${source} blob: data:`,
    `script-src ${source} 'wasm-unsafe-eval'`,
    `worker-src ${source} blob:`,
    `style-src ${source} 'unsafe-inline'`,
    `img-src ${source} blob: data:`,
    `font-src ${source} data:`,
    "media-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The OS user name, Acrobat's default comment author. */
export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * Webview HTML from the unmodified pdf.js viewer.html: its script/style/l10n
 * tags are swapped for webview URIs and the viewer's entry point.
 */
export class HtmlBuilder {
  constructor(
    private readonly extensionPath: string,
    private readonly template: string,
  ) {}

  static load(extensionPath: string): HtmlBuilder {
    return new HtmlBuilder(
      extensionPath,
      readFileSync(join(extensionPath, "resources", "pdf.js", "web", "viewer.html"), "utf8"),
    );
  }

  render(webview: Webview, documentUri: Uri, preferences: Prefs = {}): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(Uri.file(join(this.extensionPath, "resources", ...parts))).toString(true);
    const head = [
      `<meta http-equiv="Content-Security-Policy" content="${csp(webview.cspSource)}">`,
      `<meta id="pdf-config" data-config="${escAttr(JSON.stringify({ ...this.config(webview, documentUri, asset), preferences }))}">`,
      `<link rel="resource" type="application/l10n" href="${asset("pdf.js", "web", "locale", "locale.json")}">`,
      `<link rel="stylesheet" href="${asset("pdf.js", "web", "viewer.css")}">`,
      `<link rel="stylesheet" href="${asset("viewer", "viewer.css")}">`,
      `<script src="${asset("pdf.js", "build", "pdf.mjs")}" type="module"></script>`,
      `<script src="${asset("viewer", "main.mjs")}" type="module"></script>`,
    ].join("\n");
    let html = this.template;
    for (const pattern of REMOVED) {
      html = html.replace(pattern, "");
    }
    return html.replace(/<title>[^<]*<\/title>/u, `${head}\n<title>PDF</title>`);
  }

  private config(webview: Webview, documentUri: Uri, asset: (...parts: string[]) => string): Omit<ViewerConfig, "preferences"> {
    const settings = workspace.getConfiguration("pdf-editor", documentUri);
    const swatches = parseSwatches(settings.get<unknown[]>("presetColors", [...BASE_SWATCHES]));
    const folder = Uri.joinPath(documentUri, "..");
    return {
      pdfJsBuild: `${asset("pdf.js", "build")}/`,
      pdfJsWeb: `${asset("pdf.js", "web")}/`,
      mathJax: `${asset("..", "node_modules", "@mathjax")}/`,
      fonts: `${asset("fonts")}/`,
      documentUrl: webview.asWebviewUri(documentUri).toString(true),
      resourceRoot: `${webview.asWebviewUri(folder).toString(true).replace(/\/$/u, "")}/`,
      fileName: basename(documentUri.path),
      defaultZoomValue: settings.get<string>("defaultZoomValue", "auto"),
      sidebarViewOnLoad: settings.get<number>("sidebarViewOnLoad", 0),
      presetColors: swatches.length > 0 ? swatches : parseSwatches(BASE_SWATCHES),
      authorName: settings.get<string>("authorName", "").trim() || osUser(),
    };
  }
}
