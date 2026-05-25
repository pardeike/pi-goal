import { describe, expect, it } from "vitest";
import { createGoalRun, withVerdict } from "../extensions/goal/state.ts";
import { formatStatus, formatWidget } from "../extensions/goal/tui.ts";

describe("TUI formatting", () => {
  it("formats active status compactly", () => {
    const run = createGoalRun({ objective: "fix tests", maxAttempts: 3 });
    expect(formatStatus(run)).toBe("goal: running 1/3");
  });

  it("includes verifier objections in the widget", () => {
    const run = {
      ...withVerdict(createGoalRun({ objective: "fix tests" }), {
        verdict: "FAIL",
        confidence: 0.75,
        summary: "Missing validation.",
        evidence: [],
        objections: ["No test command was run."],
        nextInstructions: "Run npm test.",
        steeringFeedback: "Run the validation command before summarizing.",
        observerMemory: "Attempt 1 changed code but did not run validation.",
      }),
      stalledAttempts: 2,
      stopReason: "Loop safety stopped the goal.",
    };

    expect(formatWidget(run)).toContain("Blocking: No test command was run.");
    expect(formatWidget(run)).toContain("Steer: Run the validation command before summarizing.");
    expect(formatWidget(run)).toContain("Next: Run npm test.");
    expect(formatWidget(run)).toContain("Observer memory: Attempt 1 changed code but did not run validation.");
    expect(formatWidget(run)).toContain("No-progress cycles: 2");
    expect(formatWidget(run)).toContain("Stop reason: Loop safety stopped the goal.");
  });

  it("includes transient verifier progress when provided", () => {
    const run = createGoalRun({ objective: "ship it", maxAttempts: 2 });

    const widget = formatWidget(run, {
      phase: "verifying",
      action: "Verifier tool running: bash npm test",
      lines: ["turn 1: started", "tool: bash npm test -> running"],
      turnCount: 1,
      toolCount: 0,
      thinkingChars: 42,
      textPreview: "Checking validation evidence",
      updatedAt: Date.now(),
    });

    expect(widget).toContain("Progress: Verifier tool running: bash npm test");
    expect(widget).toContain("Verifier activity: turns 1 | tools 0 | hidden thinking chars 42");
    expect(widget).toContain("Verifier text: Checking validation evidence");
    expect(widget).toContain("> tool: bash npm test -> running");
  });
});
