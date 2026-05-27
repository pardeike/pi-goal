import type { GoalMainToolIdleTimeoutRuntimeConfig } from "./types.ts";

export interface ActiveMainToolExecution {
  toolCallId: string;
  toolName: string;
  description: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface MainToolIdleTrip {
  tool: ActiveMainToolExecution;
  idleMs: number;
}

export function createActiveMainToolExecution(toolCallId: string, toolName: string, args: unknown, now = Date.now()): ActiveMainToolExecution {
  return {
    toolCallId,
    toolName,
    description: describeObservedTool(toolName, args),
    startedAt: now,
    lastActivityAt: now,
  };
}

export function touchActiveMainToolExecution(tool: ActiveMainToolExecution, now = Date.now()): ActiveMainToolExecution {
  return {
    ...tool,
    lastActivityAt: now,
  };
}

export function findTimedOutMainTool(
  tools: Iterable<ActiveMainToolExecution>,
  config: GoalMainToolIdleTimeoutRuntimeConfig,
  now = Date.now(),
): MainToolIdleTrip | undefined {
  if (!config.enabled || config.timeoutMs <= 0) return undefined;
  let timedOut: MainToolIdleTrip | undefined;
  for (const tool of tools) {
    const idleMs = Math.max(0, now - tool.lastActivityAt);
    if (idleMs < config.timeoutMs) continue;
    if (!timedOut || tool.lastActivityAt < timedOut.tool.lastActivityAt) {
      timedOut = { tool, idleMs };
    }
  }
  return timedOut;
}

export function msUntilNextMainToolTimeout(
  tools: Iterable<ActiveMainToolExecution>,
  config: GoalMainToolIdleTimeoutRuntimeConfig,
  now = Date.now(),
): number | undefined {
  if (!config.enabled || config.timeoutMs <= 0) return undefined;
  let nextWaitMs: number | undefined;
  for (const tool of tools) {
    const waitMs = Math.max(0, tool.lastActivityAt + config.timeoutMs - now);
    nextWaitMs = nextWaitMs === undefined ? waitMs : Math.min(nextWaitMs, waitMs);
  }
  return nextWaitMs;
}

export function buildMainToolIdleProgressSignature(tool: ActiveMainToolExecution): string {
  const normalized = tool.description.replace(/\s+/g, " ").trim().slice(0, 240);
  return `main-tool-idle:${tool.toolName}:${normalized}`;
}

export function describeObservedTool(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const command = typeof record.command === "string" ? record.command : undefined;
  const path = typeof record.path === "string" ? record.path : typeof record.file_path === "string" ? record.file_path : undefined;
  const pattern = typeof record.pattern === "string" ? record.pattern : undefined;
  if (toolName === "bash" && command) return `bash ${command}`;
  if (path && pattern) return `${toolName} ${pattern} in ${path}`;
  if (path) return `${toolName} ${path}`;
  if (pattern) return `${toolName} ${pattern}`;
  return toolName;
}
