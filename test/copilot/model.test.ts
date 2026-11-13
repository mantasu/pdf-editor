import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import { ConfigurationTarget, LanguageModelError, configuration, fakeModel, languageModels, quickPick, resetMock, shownWarnings, window, workspace } from "../__mocks__/vscode";
import { NO_CHAT, friendlyError, pickModel } from "../../src/copilot/model";

const claude = () => fakeModel(["from Claude"], 64_000, { id: "claude-x", name: "Claude X", family: "claude", vendor: "anthropic" });

beforeEach(() => resetMock());

describe("asking Copilot", () => {
  test("friendlyError covers each LanguageModelError code", () => {
    expect(friendlyError(LanguageModelError.NoPermissions())).toMatch(/may not use this language model yet/u);
    expect(friendlyError(LanguageModelError.Blocked())).toBe("The language model declined this request.");
    expect(friendlyError(LanguageModelError.NotFound())).toBe(NO_CHAT);
    expect(friendlyError(new LanguageModelError("rate limited", "Other"))).toBe("rate limited");
    expect(friendlyError(new Error("boom"))).toBe("boom"); // non-model errors pass through
    expect(friendlyError("plain")).toBe("plain"); // even non-errors
  });

  test("pickModel lists every model and saves the choice to the user settings", async () => {
    await pickModel();
    expect(shownWarnings).toEqual([NO_CHAT]); // nothing to pick from
    languageModels.push(fakeModel([]), claude());
    quickPick.choose = (items) => items[2];
    await pickModel();
    expect(window.showQuickPick.mock.calls[0]![0]).toEqual([
      { label: "Automatic", description: "a Copilot model", id: "", picked: true },
      { label: "GPT X", description: "copilot · gpt", id: "gpt-x", picked: false },
      { label: "Claude X", description: "anthropic · claude", id: "claude-x", picked: false },
    ]);
    expect(configuration.get("copilot.model")).toBe("claude-x");
    const settings = workspace.getConfiguration.mock.results.at(-1)!.value as { update: ReturnType<typeof vi.fn> };
    expect(settings.update).toHaveBeenCalledWith("copilot.model", "claude-x", ConfigurationTarget.Global);
    // The current choice is marked; dismissing the list changes nothing.
    quickPick.choose = () => undefined;
    await pickModel();
    expect((window.showQuickPick.mock.calls[1]![0] as Array<{ picked: boolean }>).map((item) => item.picked)).toEqual([false, false, true]);
    expect(configuration.get("copilot.model")).toBe("claude-x");
  });
});
