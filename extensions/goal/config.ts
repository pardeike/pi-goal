import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GoalAttemptGuardRuntimeConfig, GoalEvidenceRuntimeConfig, GoalLoopSafetyRuntimeConfig, GoalRoleRuntimeConfig, GoalRuntimeConfig, GoalThinkingLevel } from "./types.ts";

const THINKING_LEVELS = new Set<GoalThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_OBSERVER_TOOLS = ["read", "bash", "grep", "find", "ls"];

interface RawGoalRoleConfig {
  model?: unknown;
  thinking?: unknown;
  systemPrompt?: unknown;
  systemPromptFile?: unknown;
  promptTemplate?: unknown;
  promptTemplateFile?: unknown;
  extraInstructions?: unknown;
  extraInstructionsFile?: unknown;
  tools?: unknown;
}

interface RawGoalEvidenceConfig {
  validationCommands?: unknown;
  extraValidationCommands?: unknown;
  validationCommandLimit?: unknown;
  validationTimeoutMs?: unknown;
}

interface RawGoalAttemptGuardConfig {
  enabled?: unknown;
  maxSingleDeltaChars?: unknown;
  maxAssistantDeltaChars?: unknown;
  maxWhitespaceDeltaChars?: unknown;
}

interface RawGoalLoopSafetyConfig {
  enabled?: unknown;
  maxRuntimeMs?: unknown;
  minAttemptsBeforeStallCheck?: unknown;
  maxStalledAttempts?: unknown;
  minStalledRuntimeMs?: unknown;
}

interface RawGoalConfig {
  maxAttempts?: unknown;
  observer?: RawGoalRoleConfig;
  verifier?: RawGoalRoleConfig;
  summarizer?: RawGoalRoleConfig;
  summary?: RawGoalRoleConfig;
  evidence?: RawGoalEvidenceConfig;
  attemptGuard?: RawGoalAttemptGuardConfig;
  loopSafety?: RawGoalLoopSafetyConfig;
}

interface LoadedRawConfig {
  path?: string;
  config: RawGoalConfig;
}

export function defaultGoalConfig(): GoalRuntimeConfig {
  return {
    maxAttempts: 10_000,
    observer: {
      tools: [...DEFAULT_OBSERVER_TOOLS],
    },
    summarizer: {
      tools: [],
    },
    evidence: {
      extraValidationCommands: [],
      validationCommandLimit: 3,
      validationTimeoutMs: 120_000,
    },
    attemptGuard: {
      enabled: true,
      maxSingleDeltaChars: 64_000,
      maxAssistantDeltaChars: 512_000,
      maxWhitespaceDeltaChars: 32_000,
    },
    loopSafety: {
      enabled: true,
      maxRuntimeMs: 0,
      minAttemptsBeforeStallCheck: 20,
      maxStalledAttempts: 12,
      minStalledRuntimeMs: 12 * 60 * 60 * 1000,
    },
  };
}

export async function loadGoalConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GoalRuntimeConfig> {
  const globalLoaded = await loadFirstRawConfig(globalConfigCandidates(cwd, env));
  const localLoaded = await loadFirstRawConfig(localConfigCandidates(cwd, env));
  const config = defaultGoalConfig();

  if (globalLoaded.path) {
    config.globalSource = globalLoaded.path;
    await mergeConfig(config, globalLoaded, cwd);
  }

  if (localLoaded.path) {
    config.source = localLoaded.path;
    await mergeConfig(config, localLoaded, cwd);
  }

  applyEnvOverrides(config, env);
  return config;
}

async function mergeConfig(config: GoalRuntimeConfig, loaded: LoadedRawConfig, cwd: string): Promise<void> {
  const observerRaw = mergeRawRole(loaded.config.verifier, loaded.config.observer);
  const summarizerRaw = mergeRawRole(loaded.config.summary, loaded.config.summarizer);
  mergeRole(config.observer, await resolvePromptFiles(observerRaw, cwd, loaded.path));
  mergeRole(config.summarizer, await resolvePromptFiles(summarizerRaw, cwd, loaded.path));
  mergeEvidence(config.evidence, loaded.config.evidence);
  mergeAttemptGuard(config.attemptGuard, loaded.config.attemptGuard);
  mergeLoopSafety(config.loopSafety, loaded.config.loopSafety);
  config.maxAttempts = clampInt(numberFromUnknown(loaded.config.maxAttempts), config.maxAttempts, 1, 10_000);
}

function applyEnvOverrides(config: GoalRuntimeConfig, env: NodeJS.ProcessEnv): void {
  config.maxAttempts = clampInt(parseEnvInt(env.PI_GOAL_MAX_ATTEMPTS), config.maxAttempts, 1, 10_000);

  applyRoleEnv(config.observer, env, {
    model: ["PI_GOAL_OBSERVER_MODEL", "PI_GOAL_VERIFIER_MODEL"],
    thinking: ["PI_GOAL_OBSERVER_THINKING", "PI_GOAL_VERIFIER_THINKING"],
    systemPrompt: ["PI_GOAL_OBSERVER_SYSTEM_PROMPT", "PI_GOAL_VERIFIER_SYSTEM_PROMPT"],
    promptTemplate: ["PI_GOAL_OBSERVER_PROMPT_TEMPLATE", "PI_GOAL_VERIFIER_PROMPT_TEMPLATE"],
    extraInstructions: ["PI_GOAL_OBSERVER_EXTRA_INSTRUCTIONS", "PI_GOAL_VERIFIER_EXTRA_INSTRUCTIONS"],
    tools: ["PI_GOAL_OBSERVER_TOOLS", "PI_GOAL_VERIFIER_TOOLS"],
  });

  applyRoleEnv(config.summarizer, env, {
    model: ["PI_GOAL_SUMMARIZER_MODEL", "PI_GOAL_SUMMARY_MODEL"],
    thinking: ["PI_GOAL_SUMMARIZER_THINKING", "PI_GOAL_SUMMARY_THINKING"],
    systemPrompt: ["PI_GOAL_SUMMARIZER_SYSTEM_PROMPT", "PI_GOAL_SUMMARY_SYSTEM_PROMPT"],
    promptTemplate: ["PI_GOAL_SUMMARIZER_PROMPT_TEMPLATE", "PI_GOAL_SUMMARY_PROMPT_TEMPLATE"],
    extraInstructions: ["PI_GOAL_SUMMARIZER_EXTRA_INSTRUCTIONS", "PI_GOAL_SUMMARY_EXTRA_INSTRUCTIONS"],
    tools: ["PI_GOAL_SUMMARIZER_TOOLS", "PI_GOAL_SUMMARY_TOOLS"],
  });

  const validationCommands = splitEnvList(env.PI_GOAL_VALIDATION_COMMANDS);
  if (validationCommands.length > 0) config.evidence.validationCommands = validationCommands;
  const extraValidationCommands = splitEnvList(env.PI_GOAL_EXTRA_VALIDATION_COMMANDS);
  if (extraValidationCommands.length > 0) config.evidence.extraValidationCommands = extraValidationCommands;
  config.evidence.validationCommandLimit = clampInt(parseEnvInt(env.PI_GOAL_VALIDATION_COMMAND_LIMIT), config.evidence.validationCommandLimit, 0, 10);
  config.evidence.validationTimeoutMs = clampInt(parseEnvInt(env.PI_GOAL_VALIDATION_TIMEOUT_MS), config.evidence.validationTimeoutMs, 5_000, 600_000);

  const guardEnabled = parseEnvBool(env.PI_GOAL_ATTEMPT_GUARD_ENABLED);
  if (guardEnabled !== undefined) config.attemptGuard.enabled = guardEnabled;
  config.attemptGuard.maxSingleDeltaChars = clampInt(parseEnvInt(env.PI_GOAL_ATTEMPT_MAX_SINGLE_DELTA_CHARS), config.attemptGuard.maxSingleDeltaChars, 4_096, 2_000_000);
  config.attemptGuard.maxAssistantDeltaChars = clampInt(parseEnvInt(env.PI_GOAL_ATTEMPT_MAX_ASSISTANT_DELTA_CHARS), config.attemptGuard.maxAssistantDeltaChars, 16_384, 10_000_000);
  config.attemptGuard.maxWhitespaceDeltaChars = clampInt(parseEnvInt(env.PI_GOAL_ATTEMPT_MAX_WHITESPACE_DELTA_CHARS), config.attemptGuard.maxWhitespaceDeltaChars, 4_096, 2_000_000);

  const loopSafetyEnabled = parseEnvBool(env.PI_GOAL_LOOP_SAFETY_ENABLED);
  if (loopSafetyEnabled !== undefined) config.loopSafety.enabled = loopSafetyEnabled;
  config.loopSafety.maxRuntimeMs = clampInt(parseEnvInt(env.PI_GOAL_MAX_RUNTIME_MS), config.loopSafety.maxRuntimeMs, 0, 7 * 24 * 60 * 60 * 1000);
  config.loopSafety.minAttemptsBeforeStallCheck = clampInt(parseEnvInt(env.PI_GOAL_MIN_ATTEMPTS_BEFORE_STALL_CHECK), config.loopSafety.minAttemptsBeforeStallCheck, 1, 1000);
  config.loopSafety.maxStalledAttempts = clampInt(parseEnvInt(env.PI_GOAL_MAX_STALLED_ATTEMPTS), config.loopSafety.maxStalledAttempts, 1, 1000);
  config.loopSafety.minStalledRuntimeMs = clampInt(parseEnvInt(env.PI_GOAL_MIN_STALLED_RUNTIME_MS), config.loopSafety.minStalledRuntimeMs, 0, 7 * 24 * 60 * 60 * 1000);
}

function applyRoleEnv(role: GoalRoleRuntimeConfig, env: NodeJS.ProcessEnv, keys: Record<"model" | "thinking" | "systemPrompt" | "promptTemplate" | "extraInstructions" | "tools", string[]>): void {
  const model = firstEnv(env, keys.model);
  if (model) role.model = model;

  const thinking = normalizeThinking(firstEnv(env, keys.thinking));
  if (thinking) role.thinking = thinking;

  const systemPrompt = firstEnv(env, keys.systemPrompt);
  if (systemPrompt) role.systemPrompt = systemPrompt;

  const promptTemplate = firstEnv(env, keys.promptTemplate);
  if (promptTemplate) role.promptTemplate = promptTemplate;

  const extraInstructions = firstEnv(env, keys.extraInstructions);
  if (extraInstructions) role.extraInstructions = extraInstructions;

  const tools = firstEnv(env, keys.tools);
  if (tools) role.tools = splitEnvList(tools);
}

async function loadFirstRawConfig(candidates: string[]): Promise<LoadedRawConfig> {
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("top-level config must be a JSON object");
      }
      return { path: candidate, config: parsed as RawGoalConfig };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") continue;
      throw new Error(`Failed to read goal config ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { config: {} };
}

function globalConfigCandidates(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const configured = env.PI_GOAL_GLOBAL_CONFIG?.trim();
  if (configured) return [resolveConfiguredPath(configured, cwd)];

  const agentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? resolveConfiguredPath(env.PI_CODING_AGENT_DIR, cwd)
    : join(homedir(), ".pi", "agent");
  return [join(agentDir, "pi-goal.config.json")];
}

function localConfigCandidates(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const configured = env.PI_GOAL_CONFIG?.trim();
  if (configured) {
    return [resolveConfiguredPath(configured, cwd)];
  }
  return [
    join(cwd, "pi-goal.config.json"),
    join(cwd, ".pi-goal.json"),
    join(cwd, ".pi", "goal.config.json"),
  ];
}

function resolveConfiguredPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function mergeRawRole(base: RawGoalRoleConfig | undefined, override: RawGoalRoleConfig | undefined): RawGoalRoleConfig {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

async function resolvePromptFiles(raw: RawGoalRoleConfig, cwd: string, configPath?: string): Promise<RawGoalRoleConfig> {
  const baseDir = configPath ? dirname(configPath) : cwd;
  const resolved = { ...raw };
  resolved.systemPrompt = await readConfiguredText(raw.systemPrompt, raw.systemPromptFile, baseDir);
  resolved.promptTemplate = await readConfiguredText(raw.promptTemplate, raw.promptTemplateFile, baseDir);
  resolved.extraInstructions = await readConfiguredText(raw.extraInstructions, raw.extraInstructionsFile, baseDir);
  return resolved;
}

async function readConfiguredText(inline: unknown, file: unknown, baseDir: string): Promise<unknown> {
  if (typeof inline === "string") return inline;
  if (typeof file !== "string" || !file.trim()) return inline;
  const path = isAbsolute(file) ? file : resolve(baseDir, file);
  return readFile(path, "utf8");
}

function mergeRole(target: GoalRoleRuntimeConfig, raw: RawGoalRoleConfig): void {
  if (typeof raw.model === "string" && raw.model.trim()) target.model = raw.model.trim();
  const thinking = normalizeThinking(raw.thinking);
  if (thinking) target.thinking = thinking;
  if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()) target.systemPrompt = raw.systemPrompt.trim();
  if (typeof raw.promptTemplate === "string" && raw.promptTemplate.trim()) target.promptTemplate = raw.promptTemplate.trim();
  if (typeof raw.extraInstructions === "string" && raw.extraInstructions.trim()) target.extraInstructions = raw.extraInstructions.trim();
  const tools = normalizeStringArray(raw.tools);
  if (tools) target.tools = tools;
}

function mergeEvidence(target: GoalEvidenceRuntimeConfig, raw: RawGoalEvidenceConfig | undefined): void {
  if (!raw) return;
  const validationCommands = normalizeStringArray(raw.validationCommands);
  if (validationCommands) target.validationCommands = validationCommands;
  const extraValidationCommands = normalizeStringArray(raw.extraValidationCommands);
  if (extraValidationCommands) target.extraValidationCommands = extraValidationCommands;
  target.validationCommandLimit = clampInt(numberFromUnknown(raw.validationCommandLimit), target.validationCommandLimit, 0, 10);
  target.validationTimeoutMs = clampInt(numberFromUnknown(raw.validationTimeoutMs), target.validationTimeoutMs, 5_000, 600_000);
}

function mergeAttemptGuard(target: GoalAttemptGuardRuntimeConfig, raw: RawGoalAttemptGuardConfig | undefined): void {
  if (!raw) return;
  const enabled = boolFromUnknown(raw.enabled);
  if (enabled !== undefined) target.enabled = enabled;
  target.maxSingleDeltaChars = clampInt(numberFromUnknown(raw.maxSingleDeltaChars), target.maxSingleDeltaChars, 4_096, 2_000_000);
  target.maxAssistantDeltaChars = clampInt(numberFromUnknown(raw.maxAssistantDeltaChars), target.maxAssistantDeltaChars, 16_384, 10_000_000);
  target.maxWhitespaceDeltaChars = clampInt(numberFromUnknown(raw.maxWhitespaceDeltaChars), target.maxWhitespaceDeltaChars, 4_096, 2_000_000);
}

function mergeLoopSafety(target: GoalLoopSafetyRuntimeConfig, raw: RawGoalLoopSafetyConfig | undefined): void {
  if (!raw) return;
  const enabled = boolFromUnknown(raw.enabled);
  if (enabled !== undefined) target.enabled = enabled;
  target.maxRuntimeMs = clampInt(numberFromUnknown(raw.maxRuntimeMs), target.maxRuntimeMs, 0, 7 * 24 * 60 * 60 * 1000);
  target.minAttemptsBeforeStallCheck = clampInt(numberFromUnknown(raw.minAttemptsBeforeStallCheck), target.minAttemptsBeforeStallCheck, 1, 1000);
  target.maxStalledAttempts = clampInt(numberFromUnknown(raw.maxStalledAttempts), target.maxStalledAttempts, 1, 1000);
  target.minStalledRuntimeMs = clampInt(numberFromUnknown(raw.minStalledRuntimeMs), target.minStalledRuntimeMs, 0, 7 * 24 * 60 * 60 * 1000);
}

function normalizeThinking(value: unknown): GoalThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.has(value as GoalThinkingLevel) ? (value as GoalThinkingLevel) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function splitEnvList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/\n|;;|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvInt(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  return numberFromUnknown(value);
}

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (!value?.trim()) return undefined;
  return boolFromUnknown(value);
}

function boolFromUnknown(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  const finite = value ?? fallback;
  return Math.max(min, Math.min(max, Math.trunc(finite)));
}
