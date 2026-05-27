import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../extensions/goal/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<void> | void;

interface SentUserMessage {
  content: unknown;
  options: unknown;
}

describe("goal main tool idle retry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("waits for the aborted turn to become idle and finish before sending the retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-goal-idle-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-goal-agent-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_GOAL_GLOBAL_CONFIG", join(agentDir, "missing-goal-config.json"));
    vi.stubEnv("PI_GOAL_HTTP_IDLE_TIMEOUT_ENABLED", "false");
    vi.stubEnv("PI_GOAL_MAIN_TOOL_IDLE_TIMEOUT_MS", "1000");

    const harness = createGoalHarness(cwd);
    goalExtension(harness.pi);

    await harness.commands.get("goal")?.handler("finish the task", harness.ctx);
    harness.sentUserMessages.length = 0;
    harness.setIdle(false);
    await harness.emit("agent_start", {});
    await harness.emit("tool_execution_start", {
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "tail -f app.log" },
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.sentUserMessages).toEqual([]);

    harness.setIdle(true);
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.sentUserMessages).toEqual([]);

    await harness.emit("agent_end", { messages: [] });
    await vi.advanceTimersByTimeAsync(25);

    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.content).toEqual(expect.stringContaining("tail -f app.log"));
    expect(harness.sentUserMessages[0]?.options).toBeUndefined();
  });
});

function createGoalHarness(cwd: string) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
  const entries: any[] = [];
  const sentUserMessages: SentUserMessage[] = [];
  let idle = true;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) {
      commands.set(name, command);
    },
    registerMessageRenderer() {
      // no-op for tests
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({
        id: `entry-${entries.length + 1}`,
        type: "custom",
        customType,
        data,
      });
    },
    sendMessage() {
      // no-op for tests
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
    getThinkingLevel() {
      return "off";
    },
  } as unknown as ExtensionAPI;

  const abort = vi.fn(() => {
    idle = false;
  });

  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setWorkingMessage: vi.fn(),
    },
    isIdle: () => idle,
    abort,
    sessionManager: {
      getBranch: () => entries,
      getLeafId: () => "leaf-1",
      getSessionFile: () => join(cwd, "session.jsonl"),
    },
    model: {
      provider: "test",
      id: "model",
      name: "Test Model",
      reasoning: false,
    },
    modelRegistry: {
      find: vi.fn(),
    },
  } as unknown as ExtensionContext;

  return {
    pi,
    ctx,
    commands,
    sentUserMessages,
    abort,
    setIdle(value: boolean) {
      idle = value;
    },
    async emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}
