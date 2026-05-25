import type { GoalAttemptGuardRuntimeConfig } from "./types.ts";

export interface AttemptGuardMetrics {
  messageUpdates: number;
  assistantDeltaChars: number;
  whitespaceDeltaChars: number;
  largestDeltaChars: number;
  lastEventType?: string;
}

export interface AttemptGuardTrip {
  reason: string;
  metrics: AttemptGuardMetrics;
}

export function createAttemptGuardMetrics(): AttemptGuardMetrics {
  return {
    messageUpdates: 0,
    assistantDeltaChars: 0,
    whitespaceDeltaChars: 0,
    largestDeltaChars: 0,
  };
}

export function recordAttemptGuardUpdate(metrics: AttemptGuardMetrics, event: unknown, config: GoalAttemptGuardRuntimeConfig): AttemptGuardTrip | undefined {
  const delta = deltaFromMessageUpdate(event);
  if (!delta) return undefined;

  const eventType = eventTypeFromMessageUpdate(event);
  metrics.messageUpdates += 1;
  metrics.assistantDeltaChars += delta.length;
  metrics.largestDeltaChars = Math.max(metrics.largestDeltaChars, delta.length);
  metrics.lastEventType = eventType;

  if (/^\s+$/.test(delta)) {
    metrics.whitespaceDeltaChars += delta.length;
  }

  if (!config.enabled) return undefined;

  if (delta.length > config.maxSingleDeltaChars) {
    return {
      reason: `assistant streamed an oversized ${eventType ?? "message"} delta (${delta.length} chars)`,
      metrics: { ...metrics },
    };
  }

  if (metrics.assistantDeltaChars > config.maxAssistantDeltaChars) {
    return {
      reason: `assistant streamed too much content in one attempt (${metrics.assistantDeltaChars} chars)`,
      metrics: { ...metrics },
    };
  }

  if (metrics.whitespaceDeltaChars > config.maxWhitespaceDeltaChars) {
    return {
      reason: `assistant streamed too much whitespace in one attempt (${metrics.whitespaceDeltaChars} chars)`,
      metrics: { ...metrics },
    };
  }

  return undefined;
}

function deltaFromMessageUpdate(event: unknown): string | undefined {
  const maybe = (event as { assistantMessageEvent?: { delta?: unknown } }).assistantMessageEvent?.delta;
  return typeof maybe === "string" ? maybe : undefined;
}

function eventTypeFromMessageUpdate(event: unknown): string | undefined {
  const maybe = (event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent?.type;
  return typeof maybe === "string" ? maybe : undefined;
}
