import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalProgressSnapshot, GoalRun } from "./types.ts";
import { formatModelRef, isTerminal, truncate } from "./state.ts";

const STATUS_KEY = "goal";
const WIDGET_KEY = "goal";

export function updateGoalUI(ctx: ExtensionContext, run: GoalRun | undefined, progress?: GoalProgressSnapshot): void {
  if (!ctx.hasUI) return;
  if (!run) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, formatStatus(run));
  ctx.ui.setWidget(WIDGET_KEY, formatWidget(run, progress), { placement: "aboveEditor" });
}

export function clearGoalWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function formatStatus(run: GoalRun): string {
  const prefix = run.status === "passed" ? "goal: passed" : run.status === "failed" ? "goal: failed" : run.status === "cancelled" ? "goal: cancelled" : `goal: ${run.status}`;
  if (isTerminal(run)) return prefix;
  return `${prefix} ${run.attempt}/${run.maxAttempts}`;
}

export function formatWidget(run: GoalRun, progress?: GoalProgressSnapshot): string[] {
  const verdict = run.lastVerdict;
  const lines = [
    `Goal: ${run.objective}`,
    `State: ${run.status} | Attempt: ${run.attempt}/${run.maxAttempts}`,
    `Main: ${formatModelRef(run.mainModel)}`,
    `Verifier: ${formatModelRef(run.verifierModel)}`,
    `Summarizer: ${formatModelRef(run.summarizerModel)}`,
  ];

  if (run.observerMemory?.trim()) {
    lines.push(`Observer memory: ${truncate(run.observerMemory.trim(), 240).replace(/\s+/g, " ")}`);
  }
  if ((run.stalledAttempts ?? 0) > 0) {
    lines.push(`No-progress cycles: ${run.stalledAttempts}`);
  }
  if (run.stopReason?.trim()) {
    lines.push(`Stop reason: ${truncate(run.stopReason.trim(), 240).replace(/\s+/g, " ")}`);
  }

  if (progress) {
    lines.push(`Progress: ${progress.action}`);
    if (progress.turnCount !== undefined || progress.toolCount !== undefined) {
      const metrics = [
        progress.turnCount !== undefined ? `turns ${progress.turnCount}` : "",
        progress.toolCount !== undefined ? `tools ${progress.toolCount}` : "",
      ].filter(Boolean);
      if (metrics.length > 0) lines.push(`Verifier activity: ${metrics.join(" | ")}`);
    }
    for (const progressLine of progress.lines.slice(-5)) {
      lines.push(`> ${progressLine}`);
    }
  }

  if (verdict) {
    lines.push(`Last verdict: ${verdict.verdict} (${verdict.confidence.toFixed(2)}) ${verdict.summary}`);
    if (verdict.objections.length > 0) {
      lines.push(`Blocking: ${verdict.objections[0]}`);
    }
    if (verdict.steeringFeedback?.trim()) {
      lines.push(`Steer: ${verdict.steeringFeedback.trim()}`);
    }
    if (verdict.nextInstructions.trim()) {
      lines.push(`Next: ${verdict.nextInstructions.trim()}`);
    }
  }

  return lines;
}
