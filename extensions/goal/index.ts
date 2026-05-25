import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultGoalConfig, loadGoalConfig } from "./config.ts";
import { buildInitialGoalPrompt, buildRetryPrompt } from "./prompts.ts";
import { createGoalRun, extractLatestAssistantText, formatModelRef, goalStateEntry, isActive, latestGoalRunFromEntries, modelRefFromModel, nextAttempt, parseGoalCommand, withStatus, withVerdict } from "./state.ts";
import { clearGoalWidget, updateGoalUI } from "./tui.ts";
import type { GoalRoleRuntimeConfig, GoalRun, GoalRuntimeConfig, GoalThinkingLevel, SessionSummarizerAdapter, SessionSummaryEvidence, VerifierAdapter, VerifierInput, VerifierVerdict } from "./types.ts";
import { GOAL_STATE_CUSTOM_TYPE } from "./types.ts";
import { collectEvidence, SdkSessionSummarizerAdapter, SdkVerifierAdapter, writeVerifierLog } from "./verifier.ts";

export default function goalExtension(pi: ExtensionAPI): void {
  let activeRun: GoalRun | undefined;
  let verifierRunning = false;
  const verifier: VerifierAdapter = new SdkVerifierAdapter();
  const summarizer: SessionSummarizerAdapter = new SdkSessionSummarizerAdapter();

  function persist(run: GoalRun): void {
    pi.appendEntry(GOAL_STATE_CUSTOM_TYPE, goalStateEntry(run));
  }

  function setRun(run: GoalRun | undefined, ctx?: ExtensionContext): void {
    activeRun = run;
    if (run) persist(run);
    if (ctx) updateGoalUI(ctx, activeRun);
  }

  function sendUserMessage(text: string, ctx: ExtensionContext): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  function sendUserMessageAfterCurrentRun(text: string): void {
    setTimeout(() => {
      pi.sendUserMessage(text);
    }, 0);
  }

  async function summarizeSessionSafely(run: GoalRun, model: VerifierInput["model"], thinkingLevel: GoalThinkingLevel | undefined, ctx: ExtensionContext, config: GoalRuntimeConfig): Promise<SessionSummaryEvidence> {
    try {
      return await summarizer.summarize({
        goal: {
          ...run,
          verifierModel: modelRefFromModel(model, thinkingLevel),
        },
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        entries: ctx.sessionManager.getEntries(),
        model,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel,
        summarizerConfig: config.summarizer,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        generatedAt: new Date().toISOString(),
        entryCount: ctx.sessionManager.getEntries().length,
        summary: `Session summarizer failed: ${message}`,
        model: modelRefFromModel(model, thinkingLevel),
      };
    }
  }

  pi.registerCommand("goal", {
    description: "Run a visible goal loop with independent skeptical verification",
    handler: async (args, ctx) => {
      const parsed = parseGoalCommand(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }

      if (parsed.command.kind === "help") {
        ctx.ui.notify("Usage: /goal <objective>, /goal status, /goal cancel", "info");
        return;
      }

      if (parsed.command.kind === "status") {
        const run = activeRun ?? latestGoalRunFromEntries(ctx.sessionManager.getEntries());
        if (!run) {
          ctx.ui.notify("No goal run in this session.", "info");
          return;
        }
        activeRun = run;
        updateGoalUI(ctx, run);
        ctx.ui.notify(`${run.status} ${run.attempt}/${run.maxAttempts}: ${run.objective}`, "info");
        return;
      }

      if (parsed.command.kind === "cancel") {
        if (!activeRun) {
          ctx.ui.notify("No active goal to cancel.", "info");
          return;
        }
        const cancelled = withStatus(activeRun, "cancelled");
        setRun(cancelled, ctx);
        clearGoalWidget(ctx);
        ctx.ui.notify("Goal cancelled.", "info");
        return;
      }

      if (isActive(activeRun)) {
        ctx.ui.notify("A goal is already active. Use /goal status or /goal cancel.", "warning");
        return;
      }

      const config = await loadConfig(ctx);
      const verifierModel = resolveConfiguredModel(ctx, config.observer.model) ?? ctx.model;
      const summarizerModel = resolveConfiguredModel(ctx, config.summarizer.model) ?? verifierModel ?? ctx.model;
      const verifierThinkingLevel = thinkingLevelFor(config.observer, pi);
      const summarizerThinkingLevel = thinkingLevelFor(config.summarizer, pi);
      const run = createGoalRun({
        objective: parsed.command.objective,
        maxAttempts: config.maxAttempts,
        mainModel: modelRefFromModel(ctx.model, pi.getThinkingLevel()),
        verifierModel: modelRefFromModel(verifierModel ?? ctx.model, verifierThinkingLevel),
        summarizerModel: modelRefFromModel(summarizerModel ?? ctx.model, summarizerThinkingLevel),
      });
      setRun(run, ctx);
      ctx.ui.notify(`Goal started: ${run.objective}`, "info");
      sendUserMessage(buildInitialGoalPrompt(run), ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeRun = latestGoalRunFromEntries(ctx.sessionManager.getEntries());
    updateGoalUI(ctx, activeRun);
  });

  pi.on("model_select", async (event, ctx) => {
    if (!isActive(activeRun)) return;
    activeRun = {
      ...activeRun,
      mainModel: modelRefFromModel(event.model, pi.getThinkingLevel()),
      updatedAt: Date.now(),
    };
    setRun(activeRun, ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (!isActive(activeRun)) return;
    activeRun = {
      ...activeRun,
      mainModel: activeRun.mainModel ? { ...activeRun.mainModel, thinkingLevel: event.level } : activeRun.mainModel,
      updatedAt: Date.now(),
    };
    setRun(activeRun, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isActive(activeRun)) return;
    updateGoalUI(ctx, activeRun);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeRun || activeRun.status !== "running" || verifierRunning) return;

    verifierRunning = true;
    try {
      const verifying = withStatus(activeRun, "verifying", {
        lastMainLeafId: ctx.sessionManager.getLeafId(),
        verifierLogDir: goalLogDir(ctx.cwd, activeRun.id),
      });
      setRun(verifying, ctx);
      if (ctx.hasUI) ctx.ui.setWorkingMessage("Preparing independent goal evidence...");

      const config = await loadConfig(ctx);
      const model = resolveConfiguredModel(ctx, config.observer.model) ?? ctx.model;
      if (!model) {
        const failed = withStatus(withVerdict(verifying, missingModelVerdict()), "failed");
        setRun(failed, ctx);
        ctx.ui.notify("Goal verifier could not run because no model is selected.", "error");
        return;
      }
      const verifierThinkingLevel = thinkingLevelFor(config.observer, pi);
      const summaryModel = resolveConfiguredModel(ctx, config.summarizer.model) ?? model;
      const summaryThinkingLevel = thinkingLevelFor(config.summarizer, pi);
      if (ctx.hasUI) ctx.ui.setWorkingMessage("Summarizing visible goal session...");
      const sessionSummary = await summarizeSessionSafely(verifying, summaryModel, summaryThinkingLevel, ctx, config);
      if (ctx.hasUI) ctx.ui.setWorkingMessage("Collecting workspace evidence...");
      const evidence = await collectEvidence(ctx.cwd, ctx.sessionManager.getSessionFile(), sessionSummary, config.evidence);
      if (ctx.hasUI) ctx.ui.setWorkingMessage("Verifying goal independently...");

      const verifierInput: VerifierInput = {
        goal: {
          ...verifying,
          verifierModel: modelRefFromModel(model, verifierThinkingLevel),
          summarizerModel: modelRefFromModel(summaryModel, summaryThinkingLevel),
        },
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        latestAssistantSummary: extractLatestAssistantText(event.messages),
        latestMessages: event.messages,
        evidence,
        model,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel: verifierThinkingLevel,
        observerConfig: config.observer,
      };

      const verdict = await verifier.verify(verifierInput);
      const logFile = await writeVerifierLog(verifying.verifierLogDir ?? goalLogDir(ctx.cwd, verifying.id), verifying.attempt, {
        input: {
          goal: verifierInput.goal,
          cwd: verifierInput.cwd,
          sessionFile: verifierInput.sessionFile,
          latestAssistantSummary: verifierInput.latestAssistantSummary,
          config,
          evidence: verifierInput.evidence,
        },
        verdict,
      });

      const judged = withVerdict(
        {
          ...verifying,
          verifierModel: modelRefFromModel(model, verifierThinkingLevel),
          summarizerModel: modelRefFromModel(summaryModel, summaryThinkingLevel),
        },
        {
          ...verdict,
          evidence: [...verdict.evidence, `verifier log: ${logFile}`],
        },
      );

      if (verdict.verdict === "PASS") {
        const passed = withStatus(judged, "passed");
        setRun(passed, ctx);
        ctx.ui.notify(`Goal passed: ${passed.objective}`, "info");
        return;
      }

      if (judged.attempt >= judged.maxAttempts) {
        const failed = withStatus(judged, "failed");
        setRun(failed, ctx);
        ctx.ui.notify(`Goal failed after ${failed.maxAttempts} attempts.`, "error");
        return;
      }

      const retryRun = nextAttempt(judged);
      setRun(retryRun, ctx);
      sendUserMessageAfterCurrentRun(buildRetryPrompt(judged, verdict));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = withStatus(withVerdict(activeRun, verifierErrorVerdict(message)), "failed");
      setRun(failed, ctx);
      ctx.ui.notify(`Goal verifier failed: ${message}`, "error");
    } finally {
      verifierRunning = false;
      if (ctx.hasUI) ctx.ui.setWorkingMessage();
      updateGoalUI(ctx, activeRun);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    updateGoalUI(ctx, activeRun);
  });
}

async function loadConfig(ctx: ExtensionContext): Promise<GoalRuntimeConfig> {
  try {
    return await loadGoalConfig(ctx.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Using default /goal config because config loading failed: ${message}`, "warning");
    return defaultGoalConfig();
  }
}

function resolveConfiguredModel(ctx: ExtensionContext, spec: string | undefined) {
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function thinkingLevelFor(role: GoalRoleRuntimeConfig, pi: ExtensionAPI): GoalThinkingLevel {
  return role.thinking ?? pi.getThinkingLevel();
}

function goalLogDir(cwd: string, goalId: string): string {
  return join(cwd, ".pi", "goal", "runs", goalId);
}

function missingModelVerdict(): VerifierVerdict {
  return {
    verdict: "FAIL",
    confidence: 0,
    summary: "No verifier model was available.",
    evidence: [],
    objections: ["No current model or configured verifier model was available."],
    nextInstructions: "Select or configure a model before using /goal.",
  };
}

function verifierErrorVerdict(message: string): VerifierVerdict {
  return {
    verdict: "FAIL",
    confidence: 0,
    summary: `Verifier failed to run: ${message}`,
    evidence: [],
    objections: [`Verifier runtime error: ${message}`],
    nextInstructions: "Fix the verifier/runtime issue, then rerun the goal.",
  };
}
