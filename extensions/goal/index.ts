import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAttemptGuardMetrics, recordAttemptGuardUpdate, type AttemptGuardTrip } from "./attempt-guard.ts";
import { defaultGoalConfig, loadGoalConfig } from "./config.ts";
import { activateGoalHttpIdleTimeout, type GoalHttpIdleTimeoutOverride } from "./http-idle.ts";
import { applyLoopSafety } from "./loop-safety.ts";
import { appendProgressLine, createGoalProgressSnapshot, createVerifierFlowMessage, createVerifierProgressTracker, createVerifierStartedMessage, createVerifierVerdictMessage, registerGoalVerifierMessageRenderer, type GoalVerifierFlowMessage } from "./progress.ts";
import { buildInitialGoalPrompt, buildRetryPrompt } from "./prompts.ts";
import { createGoalRun, effectiveThinkingLevelForModel, entriesForGoalRun, extractLatestAssistantText, goalStateEntry, isActive, isTerminal, latestAssistantRuntimeError, latestGoalRunFromEntries, modelRefFromModel, nextAttempt, parseGoalCommand, withStatus, withVerdict } from "./state.ts";
import { clearGoalWidget, updateGoalUI } from "./tui.ts";
import type { EvidenceProgressEvent, GoalProgressPhase, GoalProgressSnapshot, GoalRoleRuntimeConfig, GoalRun, GoalRuntimeConfig, GoalThinkingLevel, SessionSummarizerAdapter, SessionSummaryEvidence, VerifierAdapter, VerifierInput, VerifierProgressEvent, VerifierVerdict } from "./types.ts";
import { GOAL_STATE_CUSTOM_TYPE } from "./types.ts";
import { collectEvidence, SdkSessionSummarizerAdapter, SdkVerifierAdapter, writeVerifierLog } from "./verifier.ts";

const PROGRESS_UI_THROTTLE_MS = 250;
const MAX_TRANSCRIPT_PROGRESS_MESSAGES = 16;
const IDLE_FLUSH_POLL_MS = 25;

export default function goalExtension(pi: ExtensionAPI): void {
  registerGoalVerifierMessageRenderer(pi);

  let activeRun: GoalRun | undefined;
  let activeProgress: GoalProgressSnapshot | undefined;
  let activeConfig: GoalRuntimeConfig = defaultGoalConfig();
  let verifierRunning = false;
  let activeAgentTurnId = 0;
  let guardAbortedTurnId: number | undefined;
  let attemptMetrics = createAttemptGuardMetrics();
  let activeHttpIdleTimeoutOverride: GoalHttpIdleTimeoutOverride | undefined;
  const verifier: VerifierAdapter = new SdkVerifierAdapter();
  const summarizer: SessionSummarizerAdapter = new SdkSessionSummarizerAdapter();

  function persist(run: GoalRun): void {
    pi.appendEntry(GOAL_STATE_CUSTOM_TYPE, goalStateEntry(run));
  }

  function setRun(run: GoalRun | undefined, ctx?: ExtensionContext): void {
    activeRun = run;
    if (run) persist(run);
    if (ctx) updateGoalUI(ctx, activeRun, activeProgress);
    if (isTerminal(run)) restoreHttpIdleTimeout(ctx);
  }

  async function activateHttpIdleTimeoutOverride(config: GoalRuntimeConfig, ctx: ExtensionContext): Promise<void> {
    restoreHttpIdleTimeout(ctx);
    try {
      activeHttpIdleTimeoutOverride = await activateGoalHttpIdleTimeout(config.httpIdleTimeout, ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Goal could not change HTTP idle timeout: ${message}`, "warning");
    }
  }

  function restoreHttpIdleTimeout(ctx?: ExtensionContext): void {
    const override = activeHttpIdleTimeoutOverride;
    activeHttpIdleTimeoutOverride = undefined;
    if (!override?.enabled) return;
    try {
      override.restore();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.ui.notify(`Goal could not restore HTTP idle timeout: ${message}`, "warning");
    }
  }

  function setProgress(ctx: ExtensionContext, progress: GoalProgressSnapshot | undefined, immediate = true): void {
    activeProgress = progress;
    if (!ctx.hasUI) return;
    if (progress) ctx.ui.setWorkingMessage(progress.action);
    else ctx.ui.setWorkingMessage();
    if (immediate) updateGoalUI(ctx, activeRun, activeProgress);
  }

  function sendVerifierFlowMessage(message: GoalVerifierFlowMessage): void {
    pi.sendMessage(message);
  }

  function runAfterCurrentAgentEvent(callback: () => void): void {
    setTimeout(callback, 0);
  }

  function runWhenSessionIsIdle(ctx: ExtensionContext, callback: () => void): void {
    const poll = (): void => {
      if (ctx.isIdle()) {
        callback();
        return;
      }
      setTimeout(poll, IDLE_FLUSH_POLL_MS);
    };
    runAfterCurrentAgentEvent(poll);
  }

  function sendUserMessage(text: string, ctx: ExtensionContext): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  async function summarizeSessionSafely(run: GoalRun, model: VerifierInput["model"], thinkingLevel: GoalThinkingLevel | undefined, ctx: ExtensionContext, config: GoalRuntimeConfig): Promise<SessionSummaryEvidence> {
    const entries = entriesForGoalRun(ctx.sessionManager.getBranch(), run);
    try {
      return await summarizer.summarize({
        goal: {
          ...run,
          verifierModel: modelRefFromModel(model, thinkingLevel),
        },
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        entries,
        model,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel,
        summarizerConfig: config.summarizer,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        generatedAt: new Date().toISOString(),
        entryCount: entries.length,
        summary: `Session summarizer failed: ${message}`,
        files: [],
        commands: [],
        claims: [],
        openIssues: [`Session summarizer failed: ${message}`],
        toolErrors: [],
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
        const run = activeRun ?? latestGoalRunFromEntries(ctx.sessionManager.getBranch());
        if (!run) {
          ctx.ui.notify("No goal run in this session.", "info");
          return;
        }
        activeRun = run;
        updateGoalUI(ctx, run, activeProgress);
        ctx.ui.notify(`${run.status} attempt ${run.attempt}: ${run.objective}`, "info");
        return;
      }

      if (parsed.command.kind === "cancel") {
        if (!activeRun) {
          ctx.ui.notify("No active goal to cancel.", "info");
          return;
        }
        const cancelled = withStatus(activeRun, "cancelled");
        setRun(cancelled, ctx);
        setProgress(ctx, undefined);
        clearGoalWidget(ctx);
        ctx.ui.notify("Goal cancelled.", "info");
        return;
      }

      if (isActive(activeRun)) {
        ctx.ui.notify("A goal is already active. Use /goal status or /goal cancel.", "warning");
        return;
      }

      const config = await loadConfig(ctx);
      activeConfig = config;
      await activateHttpIdleTimeoutOverride(config, ctx);
      const verifierModel = resolveConfiguredModel(ctx, config.observer.model) ?? ctx.model;
      const summarizerModel = resolveConfiguredModel(ctx, config.summarizer.model) ?? verifierModel ?? ctx.model;
      const verifierThinkingLevel = effectiveThinkingLevelForModel(verifierModel ?? ctx.model, thinkingLevelFor(config.observer, pi));
      const summarizerThinkingLevel = effectiveThinkingLevelForModel(summarizerModel ?? ctx.model, thinkingLevelFor(config.summarizer, pi));
      const run = createGoalRun({
        objective: parsed.command.objective,
        maxAttempts: config.maxAttempts,
        contextStartEntryId: ctx.sessionManager.getLeafId(),
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
    activeProgress = undefined;
    const restoredRun = latestGoalRunFromEntries(ctx.sessionManager.getBranch());
    activeRun = isActive(restoredRun) ? restoredRun : undefined;
    if (isActive(activeRun)) {
      const config = await loadConfig(ctx);
      activeConfig = config;
      await activateHttpIdleTimeoutOverride(config, ctx);
    } else {
      restoreHttpIdleTimeout(ctx);
    }
    updateGoalUI(ctx, activeRun, activeProgress);
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
    activeAgentTurnId += 1;
    attemptMetrics = createAttemptGuardMetrics();
    if (!isActive(activeRun)) return;
    updateGoalUI(ctx, activeRun, activeProgress);
  });

  pi.on("message_update", async (event, ctx) => {
    if (!activeRun || activeRun.status !== "running" || verifierRunning) return;
    if (guardAbortedTurnId === activeAgentTurnId) return;
    const trip = recordAttemptGuardUpdate(attemptMetrics, event, activeConfig.attemptGuard);
    if (!trip) return;
    guardAbortedTurnId = activeAgentTurnId;
    handleAttemptGuardTrip(trip, ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeRun || activeRun.status !== "running" || verifierRunning) return;
    if (guardAbortedTurnId === activeAgentTurnId) {
      guardAbortedTurnId = undefined;
      updateGoalUI(ctx, activeRun, activeProgress);
      return;
    }

    verifierRunning = true;
    const verifying = withStatus(activeRun, "verifying", {
      lastMainLeafId: ctx.sessionManager.getLeafId(),
      verifierLogDir: goalLogDir(ctx.cwd, activeRun.id),
    });
    setRun(verifying, ctx);
    if (ctx.hasUI) ctx.ui.setWorkingMessage("Waiting for main session to settle before independent verification...");
    runWhenSessionIsIdle(ctx, () => {
      void runVerifierCycle(event.messages, ctx, verifying);
    });
  });

  async function runVerifierCycle(latestMessages: unknown[], ctx: ExtensionContext, verifying: GoalRun): Promise<void> {
    if (!isCurrentVerifierRun(verifying)) {
      verifierRunning = false;
      return;
    }

    try {
      if (ctx.hasUI) ctx.ui.setWorkingMessage("Preparing independent goal evidence...");

      const config = await loadConfig(ctx);
      activeConfig = config;
      const model = resolveConfiguredModel(ctx, config.observer.model) ?? ctx.model;
      if (!model) {
        const failed = withStatus(withVerdict(verifying, missingModelVerdict()), "failed");
        setRun(failed, ctx);
        ctx.ui.notify("Goal verifier could not run because no model is selected.", "error");
        return;
      }
      const verifierThinkingLevel = effectiveThinkingLevelForModel(model, thinkingLevelFor(config.observer, pi));
      const summaryModel = resolveConfiguredModel(ctx, config.summarizer.model) ?? model;
      const summaryThinkingLevel = effectiveThinkingLevelForModel(summaryModel, thinkingLevelFor(config.summarizer, pi));
      const verifierModelRef = modelRefFromModel(model, verifierThinkingLevel);
      const summaryModelRef = modelRefFromModel(summaryModel, summaryThinkingLevel);
      const mainRuntimeError = latestAssistantRuntimeError(latestMessages);
      if (mainRuntimeError) {
        const judged = withMainRuntimeErrorProgress(withVerdict(verifying, mainRuntimeErrorVerdict(mainRuntimeError)), mainRuntimeError);
        if (shouldStopAfterMainRuntimeError(judged)) {
          const failed = withStatus(judged, "failed", {
            stopReason: `Goal stopped after ${judged.stalledAttempts ?? 0} repeated main-model runtime errors without progress.`,
          });
          setRun(failed, ctx);
          ctx.ui.notify(failed.stopReason ?? "Goal stopped after repeated main-model runtime errors.", "error");
          return;
        }

        if (judged.attempt >= judged.maxAttempts) {
          const failed = withStatus(judged, "failed", {
            stopReason: `Goal reached maxAttempts (${judged.maxAttempts}) after a main-model runtime error.`,
          });
          setRun(failed, ctx);
          ctx.ui.notify(`Goal failed after main-model runtime error on attempt ${failed.attempt}/${failed.maxAttempts}.`, "error");
          return;
        }

        const retryRun = nextAttempt(judged);
        setRun(retryRun, ctx);
        ctx.ui.notify(`Goal attempt ${judged.attempt}/${judged.maxAttempts} hit a main-model runtime error.`, "warning");
        sendUserMessage(buildRetryPrompt(judged, mainRuntimeErrorVerdict(mainRuntimeError)), ctx);
        return;
      }

      let lastProgressUiAt = 0;
      let transcriptProgressMessages = 0;
      let transcriptSuppressed = false;
      const publishProgress = (progress: GoalProgressSnapshot, immediate = false): void => {
        if (!isCurrentVerifierRun(verifying)) return;
        activeProgress = progress;
        if (!ctx.hasUI) return;
        const now = Date.now();
        if (immediate || now - lastProgressUiAt >= PROGRESS_UI_THROTTLE_MS) {
          ctx.ui.setWorkingMessage(progress.action);
          updateGoalUI(ctx, activeRun, activeProgress);
          lastProgressUiAt = now;
        }
      };
      const sendCappedVerifierMessage = (message: GoalVerifierFlowMessage): void => {
        if (!isCurrentVerifierRun(verifying)) return;
        if (transcriptProgressMessages < MAX_TRANSCRIPT_PROGRESS_MESSAGES) {
          transcriptProgressMessages += 1;
          sendVerifierFlowMessage(message);
          return;
        }
        if (transcriptSuppressed) return;
        transcriptSuppressed = true;
        sendVerifierFlowMessage(createVerifierFlowMessage({
          phase: "verifying",
          status: "info",
          title: "Verifier transcript progress capped",
          lines: ["Further verifier tool progress remains visible in the goal widget and verifier log."],
        }));
      };
      const updatePhase = (phase: GoalProgressPhase, action: string, lines: string[] = []): void => {
        publishProgress(createGoalProgressSnapshot(phase, action, lines), true);
      };
      const handleEvidenceProgress = (progressEvent: EvidenceProgressEvent): void => {
        const base = activeProgress ?? createGoalProgressSnapshot("collectingEvidence", "Collecting workspace evidence...");
        if (progressEvent.type === "validation_start") {
          publishProgress(appendProgressLine(base, `Running validation: ${progressEvent.command}`, `validation: ${progressEvent.command} -> running`), true);
          sendCappedVerifierMessage(createVerifierFlowMessage({
            phase: "collectingEvidence",
            status: "running",
            title: "Validation command started",
            lines: [progressEvent.command],
          }));
          return;
        }
        publishProgress(appendProgressLine(base, `Validation finished: ${progressEvent.command}`, `validation: ${progressEvent.command} -> exit ${progressEvent.exitCode}`), true);
        sendCappedVerifierMessage(createVerifierFlowMessage({
          phase: "collectingEvidence",
          status: progressEvent.exitCode === 0 ? "success" : "error",
          title: "Validation command finished",
          lines: [progressEvent.command, `Exit code: ${progressEvent.exitCode}`],
        }));
      };
      const verifierProgressTracker = createVerifierProgressTracker();
      const handleVerifierProgress = (progressEvent: VerifierProgressEvent): void => {
        const result = verifierProgressTracker.handle(progressEvent);
        const immediate = progressEvent.type !== "text_delta" && progressEvent.type !== "thinking_delta" && progressEvent.type !== "tool_update";
        publishProgress(result.snapshot, immediate);
        if (result.message) sendCappedVerifierMessage(result.message);
      };

      updatePhase("summarizing", "Summarizing visible goal session...");
      const sessionSummary = await summarizeSessionSafely(verifying, summaryModel, summaryThinkingLevel, ctx, config);
      if (!isCurrentVerifierRun(verifying)) return;
      updatePhase("collectingEvidence", "Collecting workspace evidence...");
      sendCappedVerifierMessage(createVerifierStartedMessage(verifying.attempt, verifying.maxAttempts, verifierModelRef));
      const evidence = await collectEvidence(ctx.cwd, ctx.sessionManager.getSessionFile(), sessionSummary, config.evidence, handleEvidenceProgress);
      if (!isCurrentVerifierRun(verifying)) return;
      publishProgress(appendProgressLine(activeProgress ?? createGoalProgressSnapshot("collectingEvidence", "Workspace evidence collected."), "Workspace evidence collected.", "workspace evidence collected"), true);
      updatePhase("verifying", "Verifying goal independently...", verifierProgressTracker.snapshot().lines);

      const verifierInput: VerifierInput = {
        goal: {
          ...verifying,
          verifierModel: verifierModelRef,
          summarizerModel: summaryModelRef,
        },
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        latestAssistantSummary: extractLatestAssistantText(latestMessages),
        latestMessages,
        evidence,
        model,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel: verifierThinkingLevel,
        observerConfig: config.observer,
      };

      const verdict = await verifier.verify(verifierInput, { onProgress: handleVerifierProgress });
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
      if (!isCurrentVerifierRun(verifying)) return;
      sendVerifierFlowMessage(createVerifierVerdictMessage(verdict, logFile));

      const judgedBeforeSafety = withVerdict(
        {
          ...verifying,
          verifierModel: verifierModelRef,
          summarizerModel: summaryModelRef,
        },
        {
          ...verdict,
          evidence: [...verdict.evidence, `verifier log: ${logFile}`],
        },
      );
      const safety = applyLoopSafety({
        run: judgedBeforeSafety,
        verdict,
        evidence: verifierInput.evidence,
        config: config.loopSafety,
      });
      const judged = safety.run;

      if (verdict.verdict === "PASS") {
        const passed = withStatus(judged, "passed");
        setRun(passed, ctx);
        ctx.ui.notify(`Goal passed: ${passed.objective}`, "info");
        return;
      }

      if (safety.shouldStop) {
        const failed = withStatus(judged, "failed");
        setRun(failed, ctx);
        ctx.ui.notify(safety.stopReason ?? "Loop safety stopped the goal.", "error");
        return;
      }

      if (judged.attempt >= judged.maxAttempts) {
        const failed = withStatus(judged, "failed", {
          stopReason: `Goal reached maxAttempts (${judged.maxAttempts}).`,
        });
        setRun(failed, ctx);
        ctx.ui.notify(`Goal failed after ${failed.maxAttempts} attempts.`, "error");
        return;
      }

      const retryRun = nextAttempt(judged);
      setRun(retryRun, ctx);
      runAfterCurrentAgentEvent(() => sendUserMessage(buildRetryPrompt(judged, verdict), ctx));
    } catch (error) {
      if (activeRun && (activeRun.id !== verifying.id || activeRun.status === "cancelled")) return;
      const message = error instanceof Error ? error.message : String(error);
      const currentRun = activeRun?.id === verifying.id ? activeRun : verifying;
      const failed = withStatus(withVerdict(currentRun, verifierErrorVerdict(message)), "failed");
      setRun(failed, ctx);
      ctx.ui.notify(`Goal verifier failed: ${message}`, "error");
    } finally {
      verifierRunning = false;
      if (activeRun?.id === verifying.id) setProgress(ctx, undefined);
    }
  }

  function isCurrentVerifierRun(run: GoalRun): boolean {
    return activeRun?.id === run.id && activeRun.status === "verifying";
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    updateGoalUI(ctx, activeRun, activeProgress);
    restoreHttpIdleTimeout(ctx);
  });

  function handleAttemptGuardTrip(trip: AttemptGuardTrip, ctx: ExtensionContext): void {
    if (!activeRun || activeRun.status !== "running") return;

    const verdict = attemptGuardVerdict(trip);
    const judged = withAttemptGuardProgress(withVerdict(activeRun, verdict), trip);
    ctx.abort();

    if (shouldStopAfterAttemptGuard(judged)) {
      const failed = withStatus(judged, "failed", {
        stopReason: `Loop safety stopped the goal after ${judged.stalledAttempts ?? 0} repeated attempt-guard aborts without progress.`,
      });
      setRun(failed, ctx);
      ctx.ui.notify(failed.stopReason ?? "Loop safety stopped the goal.", "error");
      return;
    }

    if (judged.attempt >= judged.maxAttempts) {
      const failed = withStatus(judged, "failed", {
        stopReason: `Goal reached maxAttempts (${judged.maxAttempts}) after an attempt-guard abort.`,
      });
      setRun(failed, ctx);
      ctx.ui.notify(`Goal failed after attempt guard aborted attempt ${failed.attempt}/${failed.maxAttempts}.`, "error");
      return;
    }

    const retryRun = nextAttempt(judged);
    setRun(retryRun, ctx);
    ctx.ui.notify(`Goal attempt ${judged.attempt}/${judged.maxAttempts} aborted by attempt guard.`, "warning");
    sendUserMessage(buildRetryPrompt(judged, verdict), ctx);
  }

  function withAttemptGuardProgress(run: GoalRun, trip: AttemptGuardTrip): GoalRun {
    const progressSignature = `attempt-guard:${trip.reason}`;
    const stalledAttempts = run.progressSignature === progressSignature ? (run.stalledAttempts ?? 0) + 1 : 0;
    return {
      ...run,
      progressSignature,
      stalledAttempts,
      lastProgressAt: stalledAttempts === 0 ? Date.now() : run.lastProgressAt ?? run.startedAt,
    };
  }

  function shouldStopAfterAttemptGuard(run: GoalRun): boolean {
    if (!activeConfig.loopSafety.enabled) return false;
    const stalledRuntimeMs = Math.max(0, Date.now() - (run.lastProgressAt ?? run.startedAt));
    return (
      run.attempt >= activeConfig.loopSafety.minAttemptsBeforeStallCheck &&
      (run.stalledAttempts ?? 0) >= activeConfig.loopSafety.maxStalledAttempts &&
      stalledRuntimeMs >= activeConfig.loopSafety.minStalledRuntimeMs
    );
  }

  function withMainRuntimeErrorProgress(run: GoalRun, errorMessage: string): GoalRun {
    const progressSignature = `main-runtime-error:${normalizeRuntimeError(errorMessage)}`;
    const stalledAttempts = run.progressSignature === progressSignature ? (run.stalledAttempts ?? 0) + 1 : 0;
    return {
      ...run,
      progressSignature,
      stalledAttempts,
      lastProgressAt: stalledAttempts === 0 ? Date.now() : run.lastProgressAt ?? run.startedAt,
    };
  }

  function shouldStopAfterMainRuntimeError(run: GoalRun): boolean {
    return (run.stalledAttempts ?? 0) >= 2;
  }
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

function mainRuntimeErrorVerdict(message: string): VerifierVerdict {
  return {
    verdict: "FAIL",
    confidence: 1,
    summary: `The main model failed before producing any work: ${message}`,
    evidence: [`main model runtime error: ${message}`],
    objections: ["The main model produced no assistant content, no tool calls, and no verifiable workspace change."],
    nextInstructions: "Switch to a working main model or fix the model runtime, then rerun the goal.",
    steeringFeedback: "The selected main model is failing before it can work. Switch models or fix the model runtime before continuing.",
  };
}

function normalizeRuntimeError(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function attemptGuardVerdict(trip: AttemptGuardTrip): VerifierVerdict {
  const metrics = trip.metrics;
  return {
    verdict: "FAIL",
    confidence: 1,
    summary: `The main attempt was aborted before verification because ${trip.reason}.`,
    evidence: [
      `message updates: ${metrics.messageUpdates}`,
      `assistant delta chars: ${metrics.assistantDeltaChars}`,
      `whitespace delta chars: ${metrics.whitespaceDeltaChars}`,
      `largest single delta chars: ${metrics.largestDeltaChars}`,
      `last stream event type: ${metrics.lastEventType ?? "unknown"}`,
    ],
    objections: ["The main model did not produce a complete, verifiable attempt before the stream became pathological."],
    nextInstructions: "Continue with a smaller, concrete edit plan. Avoid giant or malformed edit tool calls. Read the target file, make one targeted change at a time, then run validation.",
    steeringFeedback: "Stop the malformed edit stream. Make one small targeted edit, then run validation.",
  };
}
