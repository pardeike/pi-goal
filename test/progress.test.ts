import { describe, expect, it } from "vitest";
import { createVerifierFlowMessage, createVerifierProgressTracker, createVerifierStartedMessage, createVerifierVerdictMessage } from "../extensions/goal/progress.ts";

describe("verifier progress transcript messages", () => {
  it("keeps LLM-visible content compact while preserving details for display", () => {
    const message = createVerifierFlowMessage({
      phase: "verifying",
      status: "running",
      title: "Verifier tool started",
      lines: ["bash npm test", "stdout tail that is only for the renderer"],
    });

    expect(message.customType).toBe("pi-goal-verifier");
    expect(message.display).toBe(true);
    expect(message.content).toBe("Independent verifier: Verifier tool started");
    expect(message.details.lines).toContain("stdout tail that is only for the renderer");
  });

  it("formats final verdict summaries as compact verifier messages", () => {
    const message = createVerifierVerdictMessage(
      {
        verdict: "FAIL",
        confidence: 0.8,
        summary: "Validation failed.",
        evidence: [],
        objections: ["npm test failed"],
        nextInstructions: "Fix the failing test.",
      },
      "/tmp/verifier-attempt-001.json",
    );

    expect(message.content).toBe("Independent verifier: Verifier verdict: FAIL");
    expect(message.details.status).toBe("error");
    expect(message.details.lines).toContain("Blocking: npm test failed");
    expect(message.details.lines).toContain("Next: Fix the failing test.");
  });

  it("shows verifier start attempt without the max-attempt denominator", () => {
    const message = createVerifierStartedMessage(2, 10000);

    expect(message.details.lines).toContain("Attempt: 2");
    expect(message.details.lines).not.toContain("Attempt: 2/10000");
  });
});

describe("verifier progress tracker", () => {
  it("tracks text, thinking, turns, and tool milestones", () => {
    const tracker = createVerifierProgressTracker();

    tracker.handle({ type: "turn_start", turnIndex: 0 });
    tracker.handle({ type: "thinking_delta", delta: "private reasoning" });
    tracker.handle({ type: "text_delta", delta: "Checking evidence." });
    const start = tracker.handle({
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    const end = tracker.handle({
      type: "tool_end",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "npm test" },
      result: {},
      isError: false,
    });

    expect(start.message?.content).toBe("Independent verifier: Verifier tool started");
    expect(end.message?.content).toBe("Independent verifier: Verifier tool finished");
    expect(end.snapshot.turnCount).toBe(1);
    expect(end.snapshot.toolCount).toBe(1);
    expect(end.snapshot.thinkingChars).toBe("private reasoning".length);
    expect(end.snapshot.textPreview).toContain("Checking evidence.");
    expect(end.snapshot.lines).toContain("tool: bash npm test -> ok");
  });

  it("emits visible verifier text as progress messages", () => {
    const tracker = createVerifierProgressTracker();

    const first = tracker.handle({ type: "text_delta", delta: "Checking workspace evidence." });
    const thinking = tracker.handle({ type: "thinking_delta", delta: "private reasoning" });
    const done = tracker.handle({ type: "agent_end" });

    expect(first.message).toBeUndefined();
    expect(thinking.snapshot.action).toContain("Visible output is being written to the transcript.");
    expect(done.message?.content).toBe("Independent verifier: Verifier output complete");
    expect(done.message?.details.lines).toContain("Checking workspace evidence.");
    expect(done.snapshot.action).toBe("Verifier response complete; parsing verdict.");
  });

  it("chunks verifier text into transcript messages without mirroring it as widget action", () => {
    const tracker = createVerifierProgressTracker();
    const result = tracker.handle({ type: "text_delta", delta: `${"A".repeat(181)}\n` });

    expect(result.snapshot.action).toBe("Verifier is writing visible output...");
    expect(result.message?.content).toBe("Independent verifier: Verifier output");
    expect(result.message?.details.lines[0]).toContain("A");
  });
});
