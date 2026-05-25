import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GoalHttpIdleTimeoutRuntimeConfig } from "./types.ts";

const DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS = 300_000;
const DISPATCHER_MODULE_URL = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js", import.meta.url);

interface HttpDispatcherModule {
  DEFAULT_HTTP_IDLE_TIMEOUT_MS?: number;
  configureHttpDispatcher(timeoutMs?: number): void;
  parseHttpIdleTimeoutMs(value: unknown): number | undefined;
}

export interface GoalHttpIdleTimeoutOverride {
  enabled: boolean;
  appliedTimeoutMs: number;
  previousTimeoutMs: number;
  restore(): void;
}

export async function activateGoalHttpIdleTimeout(config: GoalHttpIdleTimeoutRuntimeConfig, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GoalHttpIdleTimeoutOverride> {
  const dispatcher = await loadHttpDispatcher();
  const previousTimeoutMs = await readCurrentPiHttpIdleTimeoutMs(cwd, env, dispatcher);
  if (!config.enabled) {
    return {
      enabled: false,
      appliedTimeoutMs: previousTimeoutMs,
      previousTimeoutMs,
      restore: () => undefined,
    };
  }

  dispatcher.configureHttpDispatcher(config.timeoutMs);
  return {
    enabled: true,
    appliedTimeoutMs: config.timeoutMs,
    previousTimeoutMs,
    restore: () => dispatcher.configureHttpDispatcher(previousTimeoutMs),
  };
}

async function loadHttpDispatcher(): Promise<HttpDispatcherModule> {
  const mod = await import(DISPATCHER_MODULE_URL.href) as HttpDispatcherModule;
  return mod;
}

async function readCurrentPiHttpIdleTimeoutMs(cwd: string, env: NodeJS.ProcessEnv, dispatcher: HttpDispatcherModule): Promise<number> {
  const settingsPath = settingsFilePath(cwd, env);
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as { httpIdleTimeoutMs?: unknown };
    const parsed = dispatcher.parseHttpIdleTimeoutMs(raw.httpIdleTimeoutMs);
    if (parsed !== undefined) return parsed;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return dispatcher.DEFAULT_HTTP_IDLE_TIMEOUT_MS ?? DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS;
}

function settingsFilePath(cwd: string, env: NodeJS.ProcessEnv): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() ? resolveConfiguredPath(env.PI_CODING_AGENT_DIR, cwd) : join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function resolveConfiguredPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path.startsWith("/") ? path : resolve(cwd, path);
}
