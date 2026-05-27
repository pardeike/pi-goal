import { describe, expect, it } from "vitest";
import { createGoalRun, modelRefFromModel, withVerdict } from "../extensions/goal/state.ts";
import { formatStatus, formatWidget } from "../extensions/goal/tui.ts";

describe("TUI formatting", () => {
  it("formats active status compactly", () => {
    const run = createGoalRun({ objective: "fix tests", maxAttempts: 3 });
    expect(formatStatus(run)).toBe("goal: running attempt 1");
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

    const widget = formatWidget(run);
    expect(widget[0]).toBe("STATE: RUNNING | Attempt: 1");
    expect(widget).toContain("Verdict: FAIL (0.75)");
    expect(widget).toContain("  Summary: Missing validation.");
    expect(widget).toContain("  Blocking: No test command was run.");
    expect(widget).toContain("  Steer: Run the validation command before summarizing.");
    expect(widget).toContain("  Next: Run npm test.");
    expect(widget).toContain("Notes: observer memory: Attempt 1 changed code but did not run validation.");
    expect(widget).toContain("  No-progress cycles: 2");
    expect(widget).toContain("  Stop reason: Loop safety stopped the goal.");
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
    expect(widget).toContain("  Verifier activity: turns 1 | tools 0");
    expect(widget).not.toContain("hidden thinking chars 42");
    expect(widget).not.toContain("Verifier text: Checking validation evidence");
    expect(widget).toContain("  > tool: bash npm test -> running");
  });

  it("formats model refs with effective clamped thinking levels", () => {
    const model = {
      provider: "ollama",
      id: "qwen3.6:27b",
      name: "Qwen 3.7 27B (Ollama)",
      reasoning: true,
    } as any;
    const run = createGoalRun({
      objective: "audit reality",
      mainModel: modelRefFromModel(model, "xhigh"),
      verifierModel: modelRefFromModel(model, "xhigh"),
      summarizerModel: modelRefFromModel(model, "xhigh"),
    });

    const widget = formatWidget(run);

    expect(widget).toContain("Runtime: main=ollama/qwen3.6:27b:high | verifier=ollama/qwen3.6:27b:high | summarizer=ollama/qwen3.6:27b:high");
    expect(widget).not.toContain("Main: ollama/qwen3.6:27b:high");
    expect(widget).not.toContain("Verifier: ollama/qwen3.6:27b:high");
    expect(widget).not.toContain("Summarizer: ollama/qwen3.6:27b:high");
  });
});
