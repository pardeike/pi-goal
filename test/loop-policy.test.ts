import { describe, expect, it } from "vitest";
import { createAttemptGuardMetrics, recordAttemptGuardUpdate } from "../extensions/goal/attempt-guard.ts";
import { applyLoopSafety, buildProgressSignature } from "../extensions/goal/loop-safety.ts";
import { buildInitialGoalPrompt, buildRetryPrompt, buildSessionSummaryPrompt, buildVerifierPrompt } from "../extensions/goal/prompts.ts";
import { createGoalRun } from "../extensions/goal/state.ts";
import type { EvidenceBundle, GoalAttemptGuardRuntimeConfig, GoalLoopSafetyRuntimeConfig, VerifierVerdict } from "../extensions/goal/types.ts";

describe("goal prompts", () => {
  it("keeps main work visible and evidence-driven", () => {
    const run = createGoalRun({ objective: "make npm test pass" });
    const prompt = buildInitialGoalPrompt(run);

    expect(prompt).toContain("Work normally and visibly");
    expect(prompt).toContain("exact evidence");
    expect(prompt).toContain("independent skeptical verifier");
    expect(prompt).toContain("Do not continue or clean up any earlier /goal objective");
  });

  it("turns verifier failures into concrete retry instructions", () => {
    const run = createGoalRun({ objective: "make npm test pass" });
    const verdict: VerifierVerdict = {
      verdict: "FAIL",
      confidence: 0.8,
      summary: "The test was not run.",
      evidence: ["git diff shows implementation change"],
      objections: ["npm test was not run"],
      nextInstructions: "Run npm test and fix failures.",
      steeringFeedback: "Stop summarizing and run npm test now.",
      observerMemory: "Attempt 1 changed files but did not run npm test.",
    };

    const prompt = buildRetryPrompt(run, verdict);

    expect(prompt).toContain("Goal verifier rejected");
    expect(prompt).toContain("npm test was not run");
    expect(prompt).toContain("Run npm test and fix failures.");
    expect(prompt).toContain("Stop summarizing and run npm test now.");
    expect(prompt).toContain("Observer memory");
  });

  it("makes verifier instructions skeptical and read-only", () => {
    const run = {
      ...createGoalRun({ objective: "ship the feature" }),
      observerMemory: "Attempt 1 edited src/a.ts but npm test failed.",
    };
    const evidence = fakeEvidence();

    const prompt = buildVerifierPrompt({
      run,
      evidence,
      latestAssistantSummary: "Done.",
    });

    expect(prompt).toContain("Be skeptical");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Return only strict JSON");
    expect(prompt).toContain("steeringFeedback");
    expect(prompt).toContain("observerMemory");
    expect(prompt).toContain("Attempt 1 edited src/a.ts");
    expect(prompt).toContain("Model-generated comprehensive session log summary");
    expect(prompt).toContain("npm test");
  });

  it("builds a factual session-summary prompt for a separate model call", () => {
    const run = createGoalRun({ objective: "fix validation" });
    const prompt = buildSessionSummaryPrompt({
      run,
      serializedLog: "#1 role=user\n/goal fix validation",
      entryCount: 1,
    });

    expect(prompt).toContain("Summarize this Pi session log comprehensively");
    expect(prompt).toContain("Do not judge whether the goal is complete");
    expect(prompt).toContain("Return only strict JSON");
    expect(prompt).toContain("/goal fix validation");
  });

  it("supports custom observer and summarizer prompt templates", () => {
    const run = createGoalRun({ objective: "fix validation" });
    const evidence = fakeEvidence();
    const observerPrompt = buildVerifierPrompt({
      run,
      evidence,
      latestAssistantSummary: "Done.",
      promptTemplate: "OBSERVE {{goal}}\n{{observerMemory}}\n{{latestAssistantSummary}}\n{{evidence}}",
    });
    const summaryPrompt = buildSessionSummaryPrompt({
      run,
      serializedLog: "#1 user goal",
      entryCount: 1,
      promptTemplate: "SUMMARIZE {{goal}} {{entryCount}} {{serializedLog}}",
    });

    expect(observerPrompt).toContain("OBSERVE fix validation");
    expect(observerPrompt).toContain("(none yet)");
    expect(observerPrompt).toContain("Done.");
    expect(observerPrompt).toContain("Captured validation command output");
    expect(observerPrompt).toContain("Mandatory structured output");
    expect(summaryPrompt).toContain("SUMMARIZE fix validation 1 #1 user goal");
    expect(summaryPrompt).toContain("Mandatory structured output");
    expect(summaryPrompt).toContain('"toolErrors"');
  });

  it("trips the attempt guard on pathological stream deltas", () => {
    const metrics = createAttemptGuardMetrics();
    const config: GoalAttemptGuardRuntimeConfig = {
      enabled: true,
      maxSingleDeltaChars: 10,
      maxAssistantDeltaChars: 100,
      maxWhitespaceDeltaChars: 20,
    };

    const trip = recordAttemptGuardUpdate(
      metrics,
      {
        assistantMessageEvent: {
          type: "toolcall_delta",
          delta: " ".repeat(32),
        },
      },
      config,
    );

    expect(trip?.reason).toContain("oversized toolcall_delta delta");
    expect(trip?.metrics.whitespaceDeltaChars).toBe(32);
  });

  it("does not stop stalled loops before the configured minimum attempts", () => {
    const verdict = failVerdict();
    const evidence = fakeEvidence();
    const signature = buildProgressSignature(verdict, evidence);
    const run = {
      ...createGoalRun({ objective: "fix validation", maxAttempts: 100 }),
      attempt: 4,
      progressSignature: signature,
      stalledAttempts: 5,
    };

    const result = applyLoopSafety({
      run,
      verdict,
      evidence,
      config: loopSafetyConfig(),
      now: run.startedAt + 10_000,
    });

    expect(result.shouldStop).toBe(false);
    expect(result.run.stalledAttempts).toBe(6);
  });

  it("stops after repeated unchanged validation evidence once minimum attempts are reached", () => {
    const verdict = failVerdict();
    const evidence = fakeEvidence();
    const signature = buildProgressSignature(verdict, evidence);
    const run = {
      ...createGoalRun({ objective: "fix validation", maxAttempts: 100 }),
      attempt: 8,
      progressSignature: signature,
      stalledAttempts: 5,
    };

    const result = applyLoopSafety({
      run,
      verdict,
      evidence,
      config: loopSafetyConfig(),
      now: run.startedAt + 2 * 60 * 60 * 1000,
    });

    expect(result.shouldStop).toBe(true);
    expect(result.stopReason).toContain("without changed workspace or validation evidence");
    expect(result.run.stopReason).toBe(result.stopReason);
  });

  it("resets stalled loop count when validation evidence changes", () => {
    const verdict = failVerdict();
    const run = {
      ...createGoalRun({ objective: "fix validation", maxAttempts: 100 }),
      attempt: 8,
      progressSignature: buildProgressSignature(verdict, fakeEvidence()),
      stalledAttempts: 5,
    };
    const changedEvidence = {
      ...fakeEvidence(),
      validationResults: [
        {
          command: "npm test",
          exitCode: 1,
          stdout: "different failure",
          stderr: "",
        },
      ],
    };

    const result = applyLoopSafety({
      run,
      verdict,
      evidence: changedEvidence,
      config: loopSafetyConfig(),
      now: run.startedAt + 10_000,
    });

    expect(result.shouldStop).toBe(false);
    expect(result.madeProgress).toBe(true);
    expect(result.run.stalledAttempts).toBe(0);
  });

  it("stops when the configured wall-clock runtime is exceeded", () => {
    const verdict = failVerdict();
    const evidence = fakeEvidence();
    const run = createGoalRun({ objective: "fix validation", maxAttempts: 100 });

    const result = applyLoopSafety({
      run,
      verdict,
      evidence,
      config: { ...loopSafetyConfig(), maxRuntimeMs: 1_000 },
      now: run.startedAt + 1_001,
    });

    expect(result.shouldStop).toBe(true);
    expect(result.stopReason).toContain("runtime");
  });

  it("keeps retrying stalled loops until the minimum stalled runtime is reached", () => {
    const verdict = failVerdict();
    const evidence = fakeEvidence();
    const signature = buildProgressSignature(verdict, evidence);
    const run = {
      ...createGoalRun({ objective: "fix validation", maxAttempts: 100 }),
      attempt: 20,
      progressSignature: signature,
      stalledAttempts: 99,
      lastProgressAt: 1_000,
    };

    const result = applyLoopSafety({
      run,
      verdict,
      evidence,
      config: { ...loopSafetyConfig(), minStalledRuntimeMs: 12 * 60 * 60 * 1000 },
      now: 1_000 + 60 * 60 * 1000,
    });

    expect(result.shouldStop).toBe(false);
    expect(result.run.stalledAttempts).toBe(100);
  });
});

function failVerdict(): VerifierVerdict {
  return {
    verdict: "FAIL",
    confidence: 0.9,
    summary: "Validation failed.",
    evidence: ["npm test exit 1"],
    objections: ["Tests failed."],
    nextInstructions: "Fix failing tests.",
    steeringFeedback: "Fix failing tests.",
    observerMemory: "Tests still fail.",
  };
}

function loopSafetyConfig(): GoalLoopSafetyRuntimeConfig {
  return {
    enabled: true,
    maxRuntimeMs: 0,
    minAttemptsBeforeStallCheck: 8,
    maxStalledAttempts: 6,
    minStalledRuntimeMs: 0,
  };
}

function fakeEvidence(): EvidenceBundle {
  return {
    cwd: "/tmp/example",
    collectedAt: "2026-05-25T00:00:00.000Z",
    gitStatus: {
      command: "git status --short",
      exitCode: 0,
      stdout: " M src/a.ts",
      stderr: "",
    },
    gitDiffStat: {
      command: "git diff --stat",
      exitCode: 0,
      stdout: " src/a.ts | 2 +-",
      stderr: "",
    },
    gitDiffNameOnly: {
      command: "git diff --name-only",
      exitCode: 0,
      stdout: "src/a.ts",
      stderr: "",
    },
    rootListing: {
      command: "find . -maxdepth 2",
      exitCode: 0,
      stdout: ".\n./src\n./src/a.ts",
      stderr: "",
    },
    readmeExcerpt: {
      path: "README.md",
      exists: true,
      content: "Run npm test.",
      truncated: false,
    },
    sourceFiles: {
      label: "source files",
      files: ["src/a.ts"],
      total: 1,
      truncated: false,
    },
    testFiles: {
      label: "test files",
      files: ["test/a.test.ts"],
      total: 1,
      truncated: false,
    },
    detectedCommands: ["npm test"],
    validationResults: [
      {
        command: "npm test",
        exitCode: 1,
        stdout: "failed",
        stderr: "",
      },
    ],
    sessionSummary: {
      generatedAt: "2026-05-25T00:00:00.000Z",
      entryCount: 4,
      summary: "The agent changed src/a.ts but did not run npm test.",
      files: ["src/a.ts"],
      commands: [],
      claims: ["Done."],
      openIssues: ["npm test was not run"],
      toolErrors: [],
    },
  };
}
