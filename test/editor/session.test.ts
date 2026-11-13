import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import { EventEmitter } from "../__mocks__/vscode";
import { ViewLink } from "../../src/editor/session";

function stubPanel() {
  const received = new EventEmitter<unknown>();
  const posted: unknown[] = [];
  const panel = {
    webview: {
      onDidReceiveMessage: received.event,
      postMessage: vi.fn(async (message: unknown) => {
        posted.push(message);
        return true;
      }),
    },
  };
  return { panel, posted, receive: received.fire };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ViewLink", () => {
  let harness: ReturnType<typeof stubPanel>;
  let onMessage: ReturnType<typeof vi.fn>;
  let session: ViewLink;

  beforeEach(() => {
    harness = stubPanel();
    onMessage = vi.fn();
    session = new ViewLink(harness.panel as never, onMessage);
  });

  test("forwards protocol messages and ignores anything else", () => {
    harness.receive({ type: "ready" });
    harness.receive("garbage");
    harness.receive({ kind: "no type" });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "ready" });
  });

  test("rejects invalid snapshots", async () => {
    const pending = session.fetchState();
    const { requestId } = harness.posted[0] as { requestId: number };
    harness.receive({ type: "snapshot", requestId, snapshot: { annotations: "no" } });
    await expect(pending).rejects.toThrow(/invalid response/u);
  });

  test("dispose fails pending requests and stops listening", async () => {
    const pending = session.fetchState();
    session.dispose();
    await expect(pending).rejects.toThrow(/invalid response/u);
    harness.receive({ type: "ready" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
