import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { GOAL_STATE_CUSTOM_TYPE, type GoalCommand, type GoalModelRef, type GoalRun, type GoalStateEntry, type ParsedCommand, type VerifierVerdict } from "./types.ts";

const SUBCOMMANDS = new Set(["status", "cancel", "help"]);
const MAX_SUMMARY_CHARS = 6_000;
const MAX_OBSERVER_MEMORY_CHARS = 4_000;

export function parseGoalCommand(args: string): ParsedCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: "Usage: /goal <objective>, /goal status, or /goal cancel",
    };
  }

  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
  if (first && SUBCOMMANDS.has(first) && trimmed === first) {
    return { ok: true, command: { kind: first as GoalCommand["kind"] } as GoalCommand };
  }

  return { ok: true, command: { kind: "start", objective: trimmed } };
}

export function createGoalRun(params: {
  objective: string;
  maxAttempts?: number;
  mainModel?: GoalModelRef;
  verifierModel?: GoalModelRef;
  summarizerModel?: GoalModelRef;
}): GoalRun {
  const now = Date.now();
  return {
    id: `goal_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    objective: params.objective,
    status: "running",
    attempt: 1,
    maxAttempts: params.maxAttempts ?? 5,
    startedAt: now,
    updatedAt: now,
    mainModel: params.mainModel,
    verifierModel: params.verifierModel,
    summarizerModel: params.summarizerModel,
  };
}

export function goalStateEntry(run: GoalRun): GoalStateEntry {
  return {
    version: 1,
    run: { ...run },
  };
}

export function isActive(run: GoalRun | undefined): run is GoalRun {
  return !!run && (run.status === "running" || run.status === "verifying");
}

export function isTerminal(run: GoalRun | undefined): boolean {
  return !!run && (run.status === "passed" || run.status === "failed" || run.status === "cancelled");
}

export function withStatus(run: GoalRun, status: GoalRun["status"], extra?: Partial<GoalRun>): GoalRun {
  return {
    ...run,
    ...extra,
    status,
    updatedAt: Date.now(),
  };
}

export function withVerdict(run: GoalRun, verdict: VerifierVerdict): GoalRun {
  const observerMemory = normalizeObserverMemory(verdict.observerMemory) ?? run.observerMemory;
  return {
    ...run,
    lastVerdict: verdict,
    observerMemory,
    updatedAt: Date.now(),
  };
}

export function nextAttempt(run: GoalRun): GoalRun {
  return {
    ...run,
    status: "running",
    attempt: run.attempt + 1,
    updatedAt: Date.now(),
  };
}

export function modelRefFromModel(model: Model<any> | undefined, thinkingLevel?: string): GoalModelRef | undefined {
  if (!model) return undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    thinkingLevel,
  };
}

export function isGoalStateEntry(value: unknown): value is GoalStateEntry {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<GoalStateEntry>;
  if (maybe.version !== 1 || !maybe.run || typeof maybe.run !== "object") return false;
  const run = maybe.run as Partial<GoalRun>;
  return (
    typeof run.id === "string" &&
    typeof run.objective === "string" &&
    typeof run.status === "string" &&
    typeof run.attempt === "number" &&
    typeof run.maxAttempts === "number"
  );
}

export function latestGoalRunFromEntries(entries: SessionEntry[]): GoalRun | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE_CUSTOM_TYPE) continue;
    if (isGoalStateEntry(entry.data)) return entry.data.run;
  }
  return undefined;
}

export function extractLatestAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter(isTextPart)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return truncate(text, MAX_SUMMARY_CHARS);
  }
  return "";
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 80).trimEnd()}\n\n[truncated ${text.length - maxChars + 80} chars]`;
}

export function normalizeObserverMemory(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return truncate(value.trim(), MAX_OBSERVER_MEMORY_CHARS);
}

export function formatModelRef(model: GoalModelRef | undefined): string {
  if (!model) return "unknown";
  const thinking = model.thinkingLevel ? `:${model.thinkingLevel}` : "";
  return `${model.provider}/${model.id}${thinking}`;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}
