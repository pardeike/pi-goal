import { describe, expect, it } from "vitest";
import { createGoalRun, latestAssistantRuntimeError, latestGoalRunFromEntries, parseGoalCommand } from "../extensions/goal/state.ts";
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
