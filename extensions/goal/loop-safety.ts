import type { EvidenceBundle, GoalLoopSafetyRuntimeConfig, GoalRun, VerifierVerdict } from "./types.ts";

export interface LoopSafetyResult {
  run: GoalRun;
  shouldStop: boolean;
  stopReason?: string;
  madeProgress: boolean;
  progressSignature: string;
}

export function applyLoopSafety(params: {
  run: GoalRun;
  verdict: VerifierVerdict;
  evidence: EvidenceBundle;
  config: GoalLoopSafetyRuntimeConfig;
  now?: number;
}): LoopSafetyResult {
  const now = params.now ?? Date.now();
  const progressSignature = buildProgressSignature(params.verdict, params.evidence);
  const previousSignature = params.run.progressSignature;
  const madeProgress = !previousSignature || previousSignature !== progressSignature || params.verdict.verdict === "PASS";
  const stalledAttempts = madeProgress ? 0 : (params.run.stalledAttempts ?? 0) + 1;
  const lastProgressAt = madeProgress ? now : params.run.lastProgressAt ?? params.run.startedAt;

  const run: GoalRun = {
    ...params.run,
    progressSignature,
    stalledAttempts,
    lastProgressAt,
    stopReason: undefined,
  };

  if (!params.config.enabled || params.verdict.verdict === "PASS") {
    return { run, shouldStop: false, madeProgress, progressSignature };
  }

  const runtimeMs = Math.max(0, now - params.run.startedAt);
  if (params.config.maxRuntimeMs > 0 && runtimeMs >= params.config.maxRuntimeMs) {
    const stopReason = `Loop safety stopped the goal after ${formatDuration(runtimeMs)} runtime.`;
    return {
      run: { ...run, stopReason },
      shouldStop: true,
      stopReason,
      madeProgress,
      progressSignature,
    };
  }

  const stalledRuntimeMs = Math.max(0, now - lastProgressAt);
  if (params.run.attempt >= params.config.minAttemptsBeforeStallCheck && stalledAttempts >= params.config.maxStalledAttempts && stalledRuntimeMs >= params.config.minStalledRuntimeMs) {
    const stopReason = `Loop safety stopped the goal after ${stalledAttempts} verifier cycles and ${formatDuration(stalledRuntimeMs)} without changed workspace or validation evidence.`;
    return {
      run: { ...run, stopReason },
      shouldStop: true,
      stopReason,
      madeProgress,
      progressSignature,
    };
  }

  return { run, shouldStop: false, madeProgress, progressSignature };
}

export function buildProgressSignature(verdict: VerifierVerdict, evidence: EvidenceBundle): string {
  const validation = evidence.validationResults.map((result) => ({
    command: result.command,
    exitCode: result.exitCode,
    stdout: normalizeForSignature(result.stdout),
    stderr: normalizeForSignature(result.stderr),
  }));
  const payload = {
    verdict: verdict.verdict,
    gitStatus: normalizeForSignature(evidence.gitStatus.stdout),
    gitDiffStat: normalizeForSignature(evidence.gitDiffStat.stdout),
    gitDiffNameOnly: normalizeForSignature(evidence.gitDiffNameOnly.stdout),
    validation,
  };
  return stableHash(JSON.stringify(payload));
}

function normalizeForSignature(value: string): string {
  return value
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<timestamp>")
    .replace(/\b\d+\.\d+\s*seconds?\b/g, "<duration>")
    .replace(/\b\d+\.\d+s\b/g, "<duration>")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "<hex>")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim()
    .slice(0, 12_000);
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
