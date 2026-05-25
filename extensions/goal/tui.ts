import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRun } from "./types.ts";
import { formatModelRef, isTerminal } from "./state.ts";

const STATUS_KEY = "goal";
const WIDGET_KEY = "goal";

export function updateGoalUI(ctx: ExtensionContext, run: GoalRun | undefined): void {
  if (!ctx.hasUI) return;
  if (!run) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, formatStatus(run));
  ctx.ui.setWidget(WIDGET_KEY, formatWidget(run), { placement: "aboveEditor" });
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

export function formatWidget(run: GoalRun): string[] {
  const verdict = run.lastVerdict;
  const lines = [
    `Goal: ${run.objective}`,
    `State: ${run.status} | Attempt: ${run.attempt}/${run.maxAttempts}`,
    `Main: ${formatModelRef(run.mainModel)}`,
    `Verifier: ${formatModelRef(run.verifierModel)}`,
    `Summarizer: ${formatModelRef(run.summarizerModel)}`,
  ];

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
