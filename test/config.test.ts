import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoalConfig } from "../extensions/goal/config.ts";

describe("loadGoalConfig", () => {
  it("loads observer and summarizer role configuration from a project file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-goal-config-"));
    await mkdir(join(dir, "prompts"));
    await writeFile(join(dir, "prompts", "observer-system.txt"), "Observer system prompt", "utf8");
    await writeFile(join(dir, "prompts", "summary-template.txt"), "Summary template for {{goal}} with {{entryCount}} entries", "utf8");
    await writeFile(
      join(dir, ".pi-goal.json"),
      JSON.stringify({
        maxAttempts: 7,
        observer: {
          model: "openai/gpt-4.1-mini",
          thinking: "low",
          systemPromptFile: "prompts/observer-system.txt",
          extraInstructions: "Reject missing tests.",
          tools: ["read", "bash"],
        },
        summarizer: {
          model: "openai/gpt-4.1-nano",
          thinking: "off",
          promptTemplateFile: "prompts/summary-template.txt",
        },
        evidence: {
          validationCommands: ["npm test"],
          extraValidationCommands: ["npm run lint"],
          validationCommandLimit: 2,
          validationTimeoutMs: 45000,
        },
        attemptGuard: {
          enabled: false,
          maxSingleDeltaChars: 12345,
          maxAssistantDeltaChars: 23456,
          maxWhitespaceDeltaChars: 34567,
        },
        loopSafety: {
          enabled: true,
          maxRuntimeMs: 123456,
          minAttemptsBeforeStallCheck: 9,
          maxStalledAttempts: 4,
          minStalledRuntimeMs: 987654,
        },
      }),
      "utf8",
    );

    const config = await loadGoalConfig(dir, { PI_GOAL_GLOBAL_CONFIG: join(dir, "missing-global.json") });

    expect(config.maxAttempts).toBe(7);
    expect(config.source).toBe(join(dir, ".pi-goal.json"));
    expect(config.observer.model).toBe("openai/gpt-4.1-mini");
    expect(config.observer.systemPrompt).toBe("Observer system prompt");
    expect(config.observer.tools).toEqual(["read", "bash"]);
    expect(config.summarizer.promptTemplate).toBe("Summary template for {{goal}} with {{entryCount}} entries");
    expect(config.evidence.validationCommands).toEqual(["npm test"]);
    expect(config.evidence.extraValidationCommands).toEqual(["npm run lint"]);
    expect(config.evidence.validationTimeoutMs).toBe(45000);
    expect(config.attemptGuard.enabled).toBe(false);
    expect(config.attemptGuard.maxSingleDeltaChars).toBe(12345);
    expect(config.attemptGuard.maxAssistantDeltaChars).toBe(23456);
    expect(config.attemptGuard.maxWhitespaceDeltaChars).toBe(34567);
    expect(config.loopSafety.enabled).toBe(true);
    expect(config.loopSafety.maxRuntimeMs).toBe(123456);
    expect(config.loopSafety.minAttemptsBeforeStallCheck).toBe(9);
    expect(config.loopSafety.maxStalledAttempts).toBe(4);
    expect(config.loopSafety.minStalledRuntimeMs).toBe(987654);
  });

  it("applies environment overrides and verifier/summary aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-goal-config-"));
    await writeFile(
      join(dir, "pi-goal.config.json"),
      JSON.stringify({
        verifier: {
          model: "anthropic/claude-opus-4-5",
          thinking: "high",
        },
        summary: {
          model: "openai/gpt-4.1-nano",
        },
      }),
      "utf8",
    );

    const config = await loadGoalConfig(dir, {
      PI_GOAL_GLOBAL_CONFIG: join(dir, "missing-global.json"),
      PI_GOAL_OBSERVER_MODEL: "openai/gpt-4.1-mini",
      PI_GOAL_SUMMARIZER_THINKING: "minimal",
      PI_GOAL_VALIDATION_COMMANDS: "swift test;;npm test",
      PI_GOAL_VALIDATION_COMMAND_LIMIT: "1",
      PI_GOAL_ATTEMPT_GUARD_ENABLED: "true",
      PI_GOAL_ATTEMPT_MAX_SINGLE_DELTA_CHARS: "50000",
      PI_GOAL_LOOP_SAFETY_ENABLED: "false",
      PI_GOAL_MAX_RUNTIME_MS: "3600000",
      PI_GOAL_MIN_ATTEMPTS_BEFORE_STALL_CHECK: "12",
      PI_GOAL_MAX_STALLED_ATTEMPTS: "7",
      PI_GOAL_MIN_STALLED_RUNTIME_MS: "7200000",
    });

    expect(config.observer.model).toBe("openai/gpt-4.1-mini");
    expect(config.observer.thinking).toBe("high");
    expect(config.summarizer.model).toBe("openai/gpt-4.1-nano");
    expect(config.summarizer.thinking).toBe("minimal");
    expect(config.evidence.validationCommands).toEqual(["swift test", "npm test"]);
    expect(config.evidence.validationCommandLimit).toBe(1);
    expect(config.attemptGuard.enabled).toBe(true);
    expect(config.attemptGuard.maxSingleDeltaChars).toBe(50000);
    expect(config.loopSafety.enabled).toBe(false);
    expect(config.loopSafety.maxRuntimeMs).toBe(3600000);
    expect(config.loopSafety.minAttemptsBeforeStallCheck).toBe(12);
    expect(config.loopSafety.maxStalledAttempts).toBe(7);
    expect(config.loopSafety.minStalledRuntimeMs).toBe(7200000);
  });

  it("loads global config before project config and lets project config override it", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-goal-agent-"));
    const projectDir = await mkdtemp(join(tmpdir(), "pi-goal-config-"));
    await mkdir(join(agentDir, "prompts"));
    await writeFile(join(agentDir, "prompts", "observer-system.txt"), "Global observer prompt", "utf8");
    await writeFile(
      join(agentDir, "pi-goal.config.json"),
      JSON.stringify({
        maxAttempts: 100,
        observer: {
          model: "openai/gpt-4.1-mini",
          thinking: "high",
          systemPromptFile: "prompts/observer-system.txt",
          tools: ["read", "bash", "grep"],
        },
        summarizer: {
          model: "openai/gpt-4.1-nano",
          thinking: "off",
        },
        evidence: {
          validationCommandLimit: 4,
          validationTimeoutMs: 300000,
        },
      }),
      "utf8",
    );
    await writeFile(
      join(projectDir, "pi-goal.config.json"),
      JSON.stringify({
        maxAttempts: 8,
        observer: {
          thinking: "low",
        },
        evidence: {
          validationCommands: ["npm test"],
          validationTimeoutMs: 45000,
        },
      }),
      "utf8",
    );

    const config = await loadGoalConfig(projectDir, { PI_CODING_AGENT_DIR: agentDir });

    expect(config.globalSource).toBe(join(agentDir, "pi-goal.config.json"));
    expect(config.source).toBe(join(projectDir, "pi-goal.config.json"));
    expect(config.maxAttempts).toBe(8);
    expect(config.observer.model).toBe("openai/gpt-4.1-mini");
    expect(config.observer.thinking).toBe("low");
    expect(config.observer.systemPrompt).toBe("Global observer prompt");
    expect(config.observer.tools).toEqual(["read", "bash", "grep"]);
    expect(config.summarizer.model).toBe("openai/gpt-4.1-nano");
    expect(config.summarizer.thinking).toBe("off");
    expect(config.evidence.validationCommands).toEqual(["npm test"]);
    expect(config.evidence.validationCommandLimit).toBe(4);
    expect(config.evidence.validationTimeoutMs).toBe(45000);
  });
});
