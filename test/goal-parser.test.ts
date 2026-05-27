import { describe, expect, it } from "vitest";
import { createGoalRun, entriesForGoalRun, latestAssistantRuntimeError, latestGoalRunFromEntries, parseGoalCommand } from "../extensions/goal/state.ts";
import { GOAL_STATE_CUSTOM_TYPE, type GoalStateEntry } from "../extensions/goal/types.ts";

describe("parseGoalCommand", () => {
  it("rejects an empty command", () => {
    expect(parseGoalCommand("")).toEqual({
      ok: false,
      message: "Usage: /goal <objective>, /goal status, or /goal cancel",
    });
  });

  it("parses status and cancel subcommands", () => {
    expect(parseGoalCommand("status")).toEqual({ ok: true, command: { kind: "status" } });
    expect(parseGoalCommand("cancel")).toEqual({ ok: true, command: { kind: "cancel" } });
  });

  it("treats subcommand-looking phrases as objective text", () => {
    expect(parseGoalCommand("status page should work")).toEqual({
      ok: true,
      command: { kind: "start", objective: "status page should work" },
    });
  });
});

describe("latestGoalRunFromEntries", () => {
  it("restores the latest pi-goal custom entry", () => {
    const first = createGoalRun({ objective: "first" });
    const second = createGoalRun({ objective: "second" });
    const entryData: GoalStateEntry = { version: 1, run: second };

    const restored = latestGoalRunFromEntries([
      {
        type: "custom",
        id: "1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: GOAL_STATE_CUSTOM_TYPE,
        data: { version: 1, run: first },
      },
      {
        type: "custom",
        id: "2",
        parentId: "1",
        timestamp: new Date().toISOString(),
        customType: GOAL_STATE_CUSTOM_TYPE,
        data: entryData,
      },
    ]);

    expect(restored?.objective).toBe("second");
  });
});

describe("entriesForGoalRun", () => {
  it("drops earlier session entries before the current goal start marker", () => {
    const run = createGoalRun({ objective: "second goal", contextStartEntryId: "before-goal" });
    const entries = [
      { type: "message", id: "old-goal", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [] } },
      { type: "message", id: "before-goal", parentId: "old-goal", timestamp: new Date().toISOString(), message: { role: "assistant", content: [] } },
      { type: "custom", id: "current-state", parentId: "before-goal", timestamp: new Date().toISOString(), customType: GOAL_STATE_CUSTOM_TYPE, data: { version: 1, run } },
      { type: "message", id: "current-prompt", parentId: "current-state", timestamp: new Date().toISOString(), message: { role: "user", content: [] } },
    ] as any;

    expect(entriesForGoalRun(entries, run).map((entry) => entry.id)).toEqual(["current-state", "current-prompt"]);
  });

  it("keeps all entries for runs created before goal start markers existed", () => {
    const run = createGoalRun({ objective: "legacy goal" });
    const entries = [
      { type: "message", id: "one", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [] } },
      { type: "message", id: "two", parentId: "one", timestamp: new Date().toISOString(), message: { role: "assistant", content: [] } },
    ] as any;

    expect(entriesForGoalRun(entries, run).map((entry) => entry.id)).toEqual(["one", "two"]);
  });
});

describe("latestAssistantRuntimeError", () => {
  it("detects an empty assistant turn that stopped with a runtime error", () => {
    expect(
      latestAssistantRuntimeError([
        { role: "user", content: [{ type: "text", text: "start" }] },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "500 mlx runner failed",
        },
      ]),
    ).toBe("500 mlx runner failed");
  });

  it("ignores error turns that still contain assistant content", () => {
    expect(
      latestAssistantRuntimeError([
        {
          role: "assistant",
          content: [{ type: "text", text: "I made progress before failing." }],
          stopReason: "error",
          errorMessage: "tool failed",
        },
      ]),
    ).toBeUndefined();
  });
});
