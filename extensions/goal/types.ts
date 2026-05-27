import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const GOAL_STATE_CUSTOM_TYPE = "pi-goal-state";

export type GoalStatus = "running" | "verifying" | "passed" | "failed" | "cancelled";

export interface GoalModelRef {
  provider: string;
  id: string;
  name?: string;
  thinkingLevel?: string;
}

export type GoalThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GoalRoleRuntimeConfig {
  model?: string;
  thinking?: GoalThinkingLevel;
  systemPrompt?: string;
  promptTemplate?: string;
  extraInstructions?: string;
  tools: string[];
}

export interface GoalEvidenceRuntimeConfig {
  validationCommands?: string[];
  extraValidationCommands: string[];
  validationCommandLimit: number;
  validationTimeoutMs: number;
}

export interface GoalAttemptGuardRuntimeConfig {
  enabled: boolean;
  maxSingleDeltaChars: number;
  maxAssistantDeltaChars: number;
  maxWhitespaceDeltaChars: number;
}

export interface GoalLoopSafetyRuntimeConfig {
  enabled: boolean;
  maxRuntimeMs: number;
  minAttemptsBeforeStallCheck: number;
  maxStalledAttempts: number;
  minStalledRuntimeMs: number;
}

export interface GoalHttpIdleTimeoutRuntimeConfig {
  enabled: boolean;
  timeoutMs: number;
}

export interface GoalRuntimeConfig {
  source?: string;
  globalSource?: string;
  maxAttempts: number;
  observer: GoalRoleRuntimeConfig;
  summarizer: GoalRoleRuntimeConfig;
  evidence: GoalEvidenceRuntimeConfig;
  attemptGuard: GoalAttemptGuardRuntimeConfig;
  loopSafety: GoalLoopSafetyRuntimeConfig;
  httpIdleTimeout: GoalHttpIdleTimeoutRuntimeConfig;
}

export interface GoalRun {
  id: string;
  objective: string;
  status: GoalStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  updatedAt: number;
  contextStartEntryId?: string | null;
  mainModel?: GoalModelRef;
  verifierModel?: GoalModelRef;
  summarizerModel?: GoalModelRef;
  observerMemory?: string;
  progressSignature?: string;
  stalledAttempts?: number;
  lastProgressAt?: number;
  stopReason?: string;
  lastVerdict?: VerifierVerdict;
  lastMainLeafId?: string | null;
  verifierLogDir?: string;
}

export type GoalProgressPhase = "preparing" | "summarizing" | "collectingEvidence" | "verifying" | "parsing";

export interface GoalProgressSnapshot {
  phase: GoalProgressPhase;
  action: string;
  lines: string[];
  turnCount?: number;
  toolCount?: number;
  thinkingChars?: number;
  textPreview?: string;
  updatedAt: number;
}

export interface GoalStateEntry {
  version: 1;
  run: GoalRun;
}

export type GoalCommand =
  | { kind: "start"; objective: string }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "help" };

export interface CommandResult {
  ok: true;
  command: GoalCommand;
}

export interface CommandError {
  ok: false;
  message: string;
}

export type ParsedCommand = CommandResult | CommandError;

export interface CommandEvidence {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FileExcerptEvidence {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
}

export interface FileListEvidence {
  label: string;
  files: string[];
  total: number;
  truncated: boolean;
}

export interface SessionSummaryEvidence {
  generatedAt: string;
  entryCount: number;
  summary: string;
  files: string[];
  commands: string[];
  claims: string[];
  openIssues: string[];
  toolErrors: string[];
  model?: GoalModelRef;
  rawOutput?: string;
}

export interface EvidenceBundle {
  cwd: string;
  collectedAt: string;
  sessionFile?: string;
  gitStatus: CommandEvidence;
  gitDiffStat: CommandEvidence;
  gitDiffNameOnly: CommandEvidence;
  rootListing: CommandEvidence;
  readmeExcerpt: FileExcerptEvidence;
  sourceFiles: FileListEvidence;
  testFiles: FileListEvidence;
  detectedCommands: string[];
  validationResults: CommandEvidence[];
  sessionSummary?: SessionSummaryEvidence;
}

export interface VerifierVerdict {
  verdict: "PASS" | "FAIL";
  confidence: number;
  summary: string;
  evidence: string[];
  objections: string[];
  nextInstructions: string;
  steeringFeedback?: string;
  observerMemory?: string;
  rawOutput?: string;
}

export interface VerifierInput {
  goal: GoalRun;
  cwd: string;
  sessionFile?: string;
  latestAssistantSummary: string;
  latestMessages: unknown[];
  evidence: EvidenceBundle;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  thinkingLevel?: GoalThinkingLevel;
  observerConfig: GoalRoleRuntimeConfig;
}

export type VerifierProgressEvent =
  | { type: "turn_start"; turnIndex: number }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; args: unknown; result: unknown; isError: boolean }
  | { type: "agent_end" };

export interface VerifierProgressOptions {
  onProgress?: (event: VerifierProgressEvent) => void;
}

export interface VerifierAdapter {
  verify(input: VerifierInput, options?: VerifierProgressOptions): Promise<VerifierVerdict>;
}

export type EvidenceProgressEvent =
  | { type: "validation_start"; command: string }
  | { type: "validation_end"; command: string; exitCode: number };

export interface SessionSummarizerInput {
  goal: GoalRun;
  cwd: string;
  sessionFile?: string;
  entries: unknown[];
  model: Model<any>;
  modelRegistry: ModelRegistry;
  thinkingLevel?: GoalThinkingLevel;
  summarizerConfig: GoalRoleRuntimeConfig;
}

export interface SessionSummarizerAdapter {
  summarize(input: SessionSummarizerInput): Promise<SessionSummaryEvidence>;
}

export interface LoopDecision {
  shouldContinue: boolean;
  prompt?: string;
  finalStatus?: Extract<GoalStatus, "passed" | "failed">;
}
