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
      }),
      "utf8",
    );

    const config = await loadGoalConfig(dir, {});

    expect(config.maxAttempts).toBe(7);
    expect(config.source).toBe(join(dir, ".pi-goal.json"));
    expect(config.observer.model).toBe("openai/gpt-4.1-mini");
    expect(config.observer.systemPrompt).toBe("Observer system prompt");
    expect(config.observer.tools).toEqual(["read", "bash"]);
    expect(config.summarizer.promptTemplate).toBe("Summary template for {{goal}} with {{entryCount}} entries");
    expect(config.evidence.validationCommands).toEqual(["npm test"]);
    expect(config.evidence.extraValidationCommands).toEqual(["npm run lint"]);
    expect(config.evidence.validationTimeoutMs).toBe(45000);
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
      PI_GOAL_OBSERVER_MODEL: "openai/gpt-4.1-mini",
      PI_GOAL_SUMMARIZER_THINKING: "minimal",
      PI_GOAL_VALIDATION_COMMANDS: "swift test;;npm test",
      PI_GOAL_VALIDATION_COMMAND_LIMIT: "1",
    });

    expect(config.observer.model).toBe("openai/gpt-4.1-mini");
    expect(config.observer.thinking).toBe("high");
    expect(config.summarizer.model).toBe("openai/gpt-4.1-nano");
    expect(config.summarizer.thinking).toBe("minimal");
    expect(config.evidence.validationCommands).toEqual(["swift test", "npm test"]);
    expect(config.evidence.validationCommandLimit).toBe(1);
  });
});
