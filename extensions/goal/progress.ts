import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatModelRef } from "./state.ts";
import type { GoalModelRef, GoalProgressPhase, GoalProgressSnapshot, VerifierProgressEvent, VerifierVerdict } from "./types.ts";

export const GOAL_VERIFIER_MESSAGE_CUSTOM_TYPE = "pi-goal-verifier";

const PROGRESS_LINE_LIMIT = 8;
const PROGRESS_TEXT_LIMIT = 500;
const MESSAGE_LINE_LIMIT = 6;
const MESSAGE_LINE_CHARS = 220;

export interface GoalVerifierFlowMessageDetails {
  title: string;
  status: "info" | "running" | "success" | "error";
  lines: string[];
  phase?: GoalProgressPhase;
  timestamp: number;
}

export interface GoalVerifierFlowMessage {
  customType: typeof GOAL_VERIFIER_MESSAGE_CUSTOM_TYPE;
  content: string;
  display: true;
  details: GoalVerifierFlowMessageDetails;
}

export interface VerifierProgressTrackerResult {
  snapshot: GoalProgressSnapshot;
  message?: GoalVerifierFlowMessage;
}

export function registerGoalVerifierMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<GoalVerifierFlowMessageDetails>(GOAL_VERIFIER_MESSAGE_CUSTOM_TYPE, (message, _options, theme) => {
    const details = message.details;
    const title = details?.title ?? contentText(message.content);
    const status = details?.status ?? "info";
    const labelColor = status === "success" ? "success" : status === "error" ? "error" : status === "running" ? "accent" : "dim";
    const lines = [
      `${theme.fg(labelColor, theme.bold("[goal verifier]"))} ${theme.fg("text", title)}`,
      ...(details?.lines ?? []).map((line) => theme.fg("dim", sanitizeLine(line, MESSAGE_LINE_CHARS))),
    ];

    const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });
}

export function createVerifierFlowMessage(details: Omit<GoalVerifierFlowMessageDetails, "timestamp"> & { timestamp?: number }): GoalVerifierFlowMessage {
  const normalized: GoalVerifierFlowMessageDetails = {
    ...details,
    title: sanitizeLine(details.title, MESSAGE_LINE_CHARS),
    lines: details.lines.map((line) => sanitizeLine(line, MESSAGE_LINE_CHARS)).slice(0, MESSAGE_LINE_LIMIT),
    timestamp: details.timestamp ?? Date.now(),
  };
  return {
    customType: GOAL_VERIFIER_MESSAGE_CUSTOM_TYPE,
    content: `Independent verifier: ${normalized.title}`,
    display: true,
    details: normalized,
  };
}

export function createVerifierStartedMessage(attempt: number, maxAttempts: number, model?: GoalModelRef): GoalVerifierFlowMessage {
  return createVerifierFlowMessage({
    phase: "verifying",
    status: "running",
    title: "Independent verifier started",
    lines: [`Attempt: ${attempt}/${maxAttempts}`, `Verifier model: ${formatModelRef(model)}`],
  });
}

export function createVerifierVerdictMessage(verdict: VerifierVerdict, logFile: string): GoalVerifierFlowMessage {
  const status = verdict.verdict === "PASS" ? "success" : "error";
  const lines = [
    `Confidence: ${verdict.confidence.toFixed(2)}`,
    `Summary: ${verdict.summary}`,
    verdict.objections[0] ? `Blocking: ${verdict.objections[0]}` : "",
    verdict.nextInstructions.trim() ? `Next: ${verdict.nextInstructions.trim()}` : "",
    `Log: ${logFile}`,
  ].filter(Boolean);
  return createVerifierFlowMessage({
    phase: "parsing",
    status,
    title: `Verifier verdict: ${verdict.verdict}`,
    lines,
  });
}

export function createGoalProgressSnapshot(phase: GoalProgressPhase, action: string, lines: string[] = []): GoalProgressSnapshot {
  return {
    phase,
    action: sanitizeLine(action, MESSAGE_LINE_CHARS),
    lines: compactLines(lines),
    updatedAt: Date.now(),
  };
}

export function createVerifierProgressTracker(): {
  handle(event: VerifierProgressEvent): VerifierProgressTrackerResult;
  snapshot(): GoalProgressSnapshot;
} {
  let snapshot = createGoalProgressSnapshot("verifying", "Verifying goal independently...");
  let textPreview = "";
  let turnCount = 0;
  let toolCount = 0;
  let thinkingChars = 0;

  function update(action: string, line?: string): GoalProgressSnapshot {
    snapshot = {
      ...snapshot,
      action: sanitizeLine(action, MESSAGE_LINE_CHARS),
      lines: compactLines(line ? [...snapshot.lines, line] : snapshot.lines),
      turnCount,
      toolCount,
      thinkingChars,
      textPreview: textPreview.trim() || undefined,
      updatedAt: Date.now(),
    };
    return snapshot;
  }

  return {
    handle(event) {
      switch (event.type) {
        case "turn_start": {
          turnCount = Math.max(turnCount, event.turnIndex + 1);
          return { snapshot: update(`Verifier turn ${turnCount} started.`, `turn ${turnCount}: started`) };
        }
        case "text_delta": {
          textPreview = tailText(`${textPreview}${event.delta}`, PROGRESS_TEXT_LIMIT);
          return { snapshot: update("Verifier is writing its judgement...") };
        }
        case "thinking_delta": {
          thinkingChars += event.delta.length;
          return { snapshot: update(`Verifier is thinking (${thinkingChars} chars hidden).`) };
        }
        case "tool_start": {
          const description = describeTool(event.toolName, event.args);
          const line = `tool: ${description} -> running`;
          return {
            snapshot: update(`Verifier tool running: ${description}`, line),
            message: createVerifierFlowMessage({
              phase: "verifying",
              status: "running",
              title: "Verifier tool started",
              lines: [description],
            }),
          };
        }
        case "tool_update": {
          return { snapshot: update(`Verifier tool still running: ${describeTool(event.toolName, event.args)}`) };
        }
        case "tool_end": {
          toolCount += 1;
          const description = describeTool(event.toolName, event.args);
          const status = event.isError ? "error" : "ok";
          const line = `tool: ${description} -> ${status}`;
          return {
            snapshot: update(`Verifier tool finished: ${description}`, line),
            message: createVerifierFlowMessage({
              phase: "verifying",
              status: event.isError ? "error" : "success",
              title: "Verifier tool finished",
              lines: [description, `Result: ${status}`],
            }),
          };
        }
        case "agent_end": {
          return { snapshot: update("Verifier response complete; parsing verdict.", "verifier response complete") };
        }
      }
    },
    snapshot: () => snapshot,
  };
}

export function appendProgressLine(snapshot: GoalProgressSnapshot, action: string, line: string): GoalProgressSnapshot {
  return {
    ...snapshot,
    action: sanitizeLine(action, MESSAGE_LINE_CHARS),
    lines: compactLines([...snapshot.lines, line]),
    updatedAt: Date.now(),
  };
}

function describeTool(toolName: string, args: unknown): string {
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

function compactLines(lines: string[]): string[] {
  return lines.map((line) => sanitizeLine(line, MESSAGE_LINE_CHARS)).filter(Boolean).slice(-PROGRESS_LINE_LIMIT);
}

function sanitizeLine(line: string, maxChars: number): string {
  const compact = line.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 14).trimEnd()} ... [truncated]`;
}

function tailText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars);
}

function contentText(content: GoalVerifierFlowMessage["content"] | unknown): string {
  if (typeof content === "string") return content;
  return "";
}
