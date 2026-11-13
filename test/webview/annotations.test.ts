import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as model from "../../resources/viewer/annotations.mjs";

// A minimal sticky-note thread root shared by most cases below.
const note = { id: "r", kind: "note", subtype: "Text", page: 0, rect: [10, 10, 34, 34], opacity: 1, contents: "root", author: "" };
const idsOf = (list: Array<{ id: string }>) => list.map((a) => a.id);

describe("annotations", () => {
  let reasons: string[];
  let stop: () => void;

  beforeEach(() => {
    reasons = [];
    model.reset([], null);
    stop = model.onChange((reason: string) => reasons.push(reason));
  });
  afterEach(() => stop());

  test("threads order replies chronologically and expose status/check/roots", () => {
    model.reset(
      [
        note,
        { ...note, id: "r1", replyTo: "r", contents: "one", created: "2026-01-01T00:00:02Z" },
        { ...note, id: "r2", replyTo: "r1", contents: "two", created: "2026-01-01T00:00:01Z" },
        { ...note, id: "s1", replyTo: "r", state: { model: "Review", value: "Accepted" }, modified: "2026-01-01T00:00:03Z" },
        { ...note, id: "s2", replyTo: "r", state: { model: "Review", value: "None" }, modified: "2026-01-01T00:00:04Z" },
        { ...note, id: "m1", replyTo: "r", state: { model: "Marked", value: "Marked" }, author: "someone else" },
        { ...note, id: "lost", replyTo: "missing" },
        { ...note, id: "r3", replyTo: "r", contents: "undated" },
        { ...note, id: "r4", replyTo: "r", contents: "modified", modified: "2026-01-01T00:00:00Z" },
        { ...note, id: "s0", replyTo: "r", state: { model: "Review", value: "Rejected" }, created: "2026-01-01T00:00:00Z" },
        { ...note, id: "s9", replyTo: "r", state: { model: "Review", value: "Cancelled" } },
      ],
      null,
    );
    // Orphaned replies ("lost") surface as their own thread head.
    expect(idsOf(model.threads())).toEqual(["r", "lost"]);
    expect(idsOf(model.replies("r"))).toEqual(["r3", "r4", "r2", "r1"]);
    expect(model.rootOf(model.find("r2")).id).toBe("r");
    expect(model.reviewStatus("r")).toBeUndefined(); // newest review state wins, and it is "None"
    expect(model.checkedByMe("r")).toBe(false); // another author's checkmark does not count
    expect(model.list()).toHaveLength(11);
  });

  test("addReply / setReviewStatus / toggleCheck / patch", () => {
    model.reset([note], null);
    model.addReply("r", "hello", [[{ text: "hello", bold: true }]]);
    model.addReply("r", "   "); // blank replies are ignored
    model.setReviewStatus("r", "Completed");
    model.setReviewStatus("r", "Accepted");
    model.toggleCheck("r");
    expect(model.checkedByMe("r")).toBe(true);
    model.toggleCheck("r");
    expect(model.checkedByMe("r")).toBe(false);
    expect(model.reviewStatus("r")).toBe("Accepted");
    expect(model.list().filter((a: { state?: unknown }) => a.state)).toHaveLength(2);
    expect(model.replies("r")[0]).toMatchObject({ contents: "hello", rich: [[{ text: "hello", bold: true }]] });
    model.patch("r", { rect: [100, 100, 124, 124] }, "Move");
    expect(model.list().every((a: { rect: number[] }) => a.rect[0] === 100)).toBe(true);
    expect(reasons.filter((c) => c === "edit")).toHaveLength(6);
  });

  test("toggleResolved sets and clears the Completed state; hasDiscussion wants a comment or replies", () => {
    const highlight = { ...note, id: "h", kind: "highlight", subtype: "Highlight", contents: "" };
    model.reset([note, highlight], null);
    expect(model.hasDiscussion(note)).toBe(true);
    expect(model.hasDiscussion(highlight)).toBe(false); // a bare mark has nothing to resolve
    expect(model.hasDiscussion(undefined)).toBe(false);
    model.addReply("h", "a reply makes it a thread");
    expect(model.hasDiscussion(model.find("h"))).toBe(true);
    const labels: string[] = [];
    const stopLabels = model.onChange(() => labels.push(model.list().at(-1)?.contents ?? ""));
    model.toggleResolved("r");
    expect(model.reviewStatus("r")).toBe("Completed");
    model.toggleResolved("r");
    expect(model.reviewStatus("r")).toBeUndefined();
    model.setReviewStatus("r", "Rejected");
    model.toggleResolved("r"); // a thread with another status gets resolved, not reopened
    expect(model.reviewStatus("r")).toBe("Completed");
    model.setReviewStatus("r", "None");
    expect(model.reviewStatus("r")).toBeUndefined();
    stopLabels();
    expect(labels).toEqual(["Completed set by ", "None set by ", "Rejected set by ", "Completed set by ", "None set by "]);
  });

  test("remove drops whole threads, or re-parents answers when only a reply goes", () => {
    model.reset([note, { ...note, id: "r1", replyTo: "r", created: "1" }, { ...note, id: "r2", replyTo: "r1", created: "2" }], null);
    model.remove("r1", "Delete Reply");
    expect(model.list().map((a: { id: string; replyTo?: string }) => [a.id, a.replyTo])).toEqual([["r", undefined], ["r2", "r"]]);
    model.reset([note, { ...note, id: "r2", replyTo: "r" }, { ...note, id: "other" }], null);
    model.select("other");
    model.remove("r", "Delete");
    expect(model.selectedId()).toBe("other");
    model.select("other");
    model.remove("other", "Delete");
    expect(model.list()).toEqual([]);
    expect(model.selectedId()).toBeNull();
    model.remove("missing", "noop"); // deleting an unknown id changes nothing
    expect(reasons.filter((c) => c === "edit")).toHaveLength(3);
  });

  test("canReply needs a referenced parent and a writable document", () => {
    model.reset([note], null);
    expect(model.canReply(note)).toBe(true);
    expect(model.canReply({ ...note, kind: "other" })).toBe(false); // foreign annotations cannot be replied to
    expect(model.canReply({ ...note, kind: "other", ref: "5 0" })).toBe(true);
    expect(model.canReply(undefined)).toBe(false);
    model.reset([note], "encrypted");
    expect(model.readOnlyReason()).toBe("encrypted");
    expect(model.canReply(note)).toBe(false);
    model.addReply("r", "x");
    model.setReviewStatus("r", "Accepted");
    expect(model.list()).toHaveLength(1); // both writes were refused
  });

  test("draft lifecycle, batching, replace and selection", () => {
    model.setDraft([{ ...note, id: "d" }]);
    expect(model.find("d")).toBeDefined();
    expect(model.drafts()).toHaveLength(1);
    model.commitDraft({ contents: "typed" }, "Add Sticky Note");
    expect(model.list()).toMatchObject([{ id: "d", contents: "typed" }]);
    model.commitDraft({ contents: "nothing" }, "noop"); // empty reason => no-op
    expect(model.list()).toHaveLength(1);
    model.add([{ ...note, id: "e" }], "Batch");
    expect(idsOf(model.list())).toEqual(["d", "e"]);
    model.select("e");
    model.select("e"); // selecting twice does not re-fire
    model.restore([note]);
    expect(model.selectedId()).toBeNull();
    model.select("r");
    model.restore([note]);
    expect(model.selectedId()).toBe("r");
    model.patch("missing", { contents: "x" }, "noop");
    expect(reasons).toEqual(["draft", "edit", "draft", "edit", "select", "replace", "select", "replace"]);
  });
});
