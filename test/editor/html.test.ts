import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import * as os from "node:os";
import { Uri, configuration, resetMock } from "../__mocks__/vscode";
import {
  BASE_SWATCHES,
  HtmlBuilder,
  osUser,
} from "../../src/editor/html";
import type { ViewerConfig } from "../../src/protocol";

vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), userInfo: vi.fn(() => ({ username: "reader" })) }));

const EXTENSION = "/ext";
const TEMPLATE = `<!doctype html>
<html><head>
<title>PDF.js viewer</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
<link rel="resource" type="application/l10n" href="locale/locale.json" />
<script src="../build/pdf.mjs" type="module"></script>
<link rel="stylesheet" href="viewer.css" />
<script src="viewer.mjs" type="module"></script>
</head><body><div id="outerContainer"></div></body></html>`;

const webview = {
  cspSource: "vscode-resource:",
  asWebviewUri: (uri: Uri) => Uri.parse(`https://webview${uri.path}`),
};

function render(documentPath = "/docs/paper one.pdf", preferences?: Record<string, unknown>): { html: string; config: ViewerConfig } {
  const html = new HtmlBuilder(EXTENSION, TEMPLATE).render(webview as never, Uri.file(documentPath) as never, preferences);
  const raw = /data-config="([^"]*)"/u.exec(html)![1]!;
  const config = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  return { html, config };
}

beforeEach(() => {
  resetMock();
  vi.mocked(os.userInfo).mockReturnValue({ username: "reader" } as never);
});

describe("HtmlBuilder", () => {
  test("honours settings and falls back to default colors when none are valid", () => {
    configuration.set("defaultZoomValue", "page-width");
    configuration.set("sidebarViewOnLoad", 1);
    configuration.set("authorName", "  Dr. Who  ");
    configuration.set("presetColors", ["Mint=#aaffcc", "broken", 7]);
    let { config } = render();
    expect(config).toMatchObject({ defaultZoomValue: "page-width", sidebarViewOnLoad: 1, authorName: "Dr. Who" });
    expect(config.presetColors).toEqual([{ name: "Mint", color: "#AAFFCC" }]);
    configuration.set("presetColors", ["nope"]);
    ({ config } = render());
    expect(config.presetColors).toHaveLength(BASE_SWATCHES.length);
  });
});

describe("helpers", () => {
  test("osUser falls back to empty when the user is unknown", () => {
    expect(osUser()).toBe("reader");
    vi.mocked(os.userInfo).mockImplementation(() => {
      throw new Error("no user");
    });
    expect(osUser()).toBe("");
  });
});
