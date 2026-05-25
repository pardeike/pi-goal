import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { createExtensionRuntime, createAgentSession, type ResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildSessionSummaryPrompt, buildVerifierPrompt } from "./prompts.ts";
import { defaultGoalConfig } from "./config.ts";
import type { CommandEvidence, EvidenceBundle, FileExcerptEvidence, FileListEvidence, GoalEvidenceRuntimeConfig, SessionSummarizerAdapter, SessionSummarizerInput, SessionSummaryEvidence, VerifierAdapter, VerifierInput, VerifierVerdict } from "./types.ts";
import { modelRefFromModel, truncate } from "./state.ts";
import { GOAL_STATE_CUSTOM_TYPE } from "./types.ts";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 12_000;
const FILE_EXCERPT_LIMIT = 16_000;
const FILE_LIST_LIMIT = 200;
const SESSION_LOG_LIMIT = 80_000;
const SESSION_SUMMARY_LIMIT = 20_000;
const DEFAULT_OBSERVER_SYSTEM_PROMPT = "You are a skeptical independent goal observer. Audit completion using real workspace evidence. Do not modify files. Return only the requested strict JSON.";
const DEFAULT_SUMMARIZER_SYSTEM_PROMPT = "You summarize Pi coding-agent session logs for a separate evaluator. Be factual, comprehensive, and concise. Return plain text only.";
const IGNORED_DIRS = new Set([".git", ".hg", ".svn", ".pi", ".build", ".swiftpm", "node_modules", "dist", "build", "target", ".next", ".turbo", ".venv", "venv", "__pycache__"]);
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".kt", ".m", ".mm", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".swift", ".ts", ".tsx", ".vue"]);

export class SdkVerifierAdapter implements VerifierAdapter {
  async verify(input: VerifierInput): Promise<VerifierVerdict> {
    const prompt = buildVerifierPrompt({
      run: input.goal,
      evidence: input.evidence,
      latestAssistantSummary: input.latestAssistantSummary,
      promptTemplate: input.observerConfig.promptTemplate,
      extraInstructions: input.observerConfig.extraInstructions,
    });

    const resourceLoader = createVerifierResourceLoader(input.observerConfig.systemPrompt ?? DEFAULT_OBSERVER_SYSTEM_PROMPT);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });

    const { session } = await createAgentSession({
      cwd: input.cwd,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      modelRegistry: input.modelRegistry,
      resourceLoader,
      tools: input.observerConfig.tools,
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
    });

    try {
      await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
      const output = extractLatestAssistantText(session.messages);
      return parseVerifierOutput(output);
    } finally {
      session.dispose();
    }
  }
}

export class SdkSessionSummarizerAdapter implements SessionSummarizerAdapter {
  async summarize(input: SessionSummarizerInput): Promise<SessionSummaryEvidence> {
    const serializedLog = serializeSessionLog(input.entries);
    const prompt = buildSessionSummaryPrompt({
      run: input.goal,
      serializedLog,
      entryCount: input.entries.length,
      promptTemplate: input.summarizerConfig.promptTemplate,
      extraInstructions: input.summarizerConfig.extraInstructions,
    });

    const resourceLoader = createVerifierResourceLoader(
      input.summarizerConfig.systemPrompt ?? DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });

    const { session } = await createAgentSession({
      cwd: input.cwd,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      modelRegistry: input.modelRegistry,
      resourceLoader,
      tools: input.summarizerConfig.tools,
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
    });

    try {
      await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
      const output = extractLatestAssistantText(session.messages);
      return {
        generatedAt: new Date().toISOString(),
        entryCount: input.entries.length,
        summary: truncate(output || "(session summarizer returned no text)", SESSION_SUMMARY_LIMIT),
        model: modelRefFromModel(input.model, input.thinkingLevel),
        rawOutput: output,
      };
    } finally {
      session.dispose();
    }
  }
}

export async function collectEvidence(cwd: string, sessionFile?: string, sessionSummary?: SessionSummaryEvidence, config: GoalEvidenceRuntimeConfig = defaultGoalConfig().evidence): Promise<EvidenceBundle> {
  const detectedCommands = await detectValidationCommands(cwd);
  const validationCommands = [...(config.validationCommands ?? detectedCommands), ...config.extraValidationCommands];
  const validationResults = await runValidationCommands(cwd, validationCommands, config);

  const [gitStatus, gitDiffStat, gitDiffNameOnly, rootListing, readmeExcerpt, allFiles] = await Promise.all([
    runCommand(cwd, "git", ["status", "--short"]),
    runCommand(cwd, "git", ["diff", "--stat"]),
    runCommand(cwd, "git", ["diff", "--name-only"]),
    collectRootListing(cwd),
    readReadmeExcerpt(cwd),
    listWorkspaceFiles(cwd),
  ]);
  const sourceFiles = fileListEvidence("source files", allFiles.filter(isSourceFile));
  const testFiles = fileListEvidence("test files", allFiles.filter(isTestFile));

  return {
    cwd,
    collectedAt: new Date().toISOString(),
    sessionFile,
    gitStatus,
    gitDiffStat,
    gitDiffNameOnly,
    rootListing,
    readmeExcerpt,
    sourceFiles,
    testFiles,
    detectedCommands,
    validationResults,
    sessionSummary,
  };
}

export async function writeVerifierLog(dir: string, attempt: number, payload: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `verifier-attempt-${attempt.toString().padStart(3, "0")}.json`);
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

export function parseVerifierOutput(rawOutput: string): VerifierVerdict {
  const raw = rawOutput.trim();
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return failFromParser(raw, "Verifier did not return parseable strict JSON.");
  }

  const candidate = parsed as Partial<VerifierVerdict>;
  const verdict = candidate.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL") {
    return failFromParser(raw, "Verifier JSON did not contain verdict PASS or FAIL.");
  }

  return {
    verdict,
    confidence: clampConfidence(candidate.confidence),
    summary: stringOrDefault(candidate.summary, verdict === "PASS" ? "Verifier accepted the goal." : "Verifier rejected the goal."),
    evidence: stringArray(candidate.evidence),
    objections: stringArray(candidate.objections),
    nextInstructions: stringOrDefault(candidate.nextInstructions, verdict === "PASS" ? "" : "Produce concrete evidence that satisfies the goal."),
    steeringFeedback: stringOrUndefined(candidate.steeringFeedback, 500),
    rawOutput: raw,
  };
}

export async function detectValidationCommands(cwd: string): Promise<string[]> {
  const commands = new Set<string>();
  const packageJson = await readJson(join(cwd, "package.json"));
  if (packageJson && typeof packageJson === "object" && !Array.isArray(packageJson)) {
    const scripts = (packageJson as { scripts?: Record<string, unknown> }).scripts ?? {};
    if (typeof scripts.test === "string") commands.add("npm test");
    if (typeof scripts.check === "string") commands.add("npm run check");
    if (typeof scripts.typecheck === "string") commands.add("npm run typecheck");
    if (typeof scripts.lint === "string") commands.add("npm run lint");
  }

  if (await exists(join(cwd, "Package.swift"))) commands.add("swift test");
  if (await exists(join(cwd, "Cargo.toml"))) commands.add("cargo test");
  if (await exists(join(cwd, "pyproject.toml"))) commands.add("pytest");
  if (await exists(join(cwd, "go.mod"))) commands.add("go test ./...");

  return [...commands];
}

function createVerifierResourceLoader(systemPrompt = DEFAULT_OBSERVER_SYSTEM_PROMPT): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function runCommand(cwd: string, command: string, args: string[]): Promise<CommandEvidence> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return {
      command: [command, ...args].join(" "),
      exitCode: 0,
      stdout: truncate(result.stdout.toString(), OUTPUT_LIMIT),
      stderr: truncate(result.stderr.toString(), OUTPUT_LIMIT),
    };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      command: [command, ...args].join(" "),
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: truncate(String(err.stdout ?? ""), OUTPUT_LIMIT),
      stderr: truncate(String(err.stderr ?? err.message ?? ""), OUTPUT_LIMIT),
    };
  }
}

async function runShellCommand(cwd: string, command: string, timeout: number): Promise<CommandEvidence> {
  try {
    const result = await execFileAsync("sh", ["-lc", command], {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return {
      command,
      exitCode: 0,
      stdout: truncate(result.stdout.toString(), OUTPUT_LIMIT),
      stderr: truncate(result.stderr.toString(), OUTPUT_LIMIT),
    };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: Buffer | string; stderr?: Buffer | string; message?: string; signal?: string };
    const timedOut = err.signal === "SIGTERM" ? `\n[command timed out after ${timeout} ms]` : "";
    return {
      command,
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: truncate(String(err.stdout ?? ""), OUTPUT_LIMIT),
      stderr: truncate(`${String(err.stderr ?? err.message ?? "")}${timedOut}`, OUTPUT_LIMIT),
    };
  }
}

async function runValidationCommands(cwd: string, commands: string[], config: GoalEvidenceRuntimeConfig): Promise<CommandEvidence[]> {
  const selected = commands.slice(0, config.validationCommandLimit);
  const results: CommandEvidence[] = [];
  for (const command of selected) {
    results.push(await runShellCommand(cwd, command, config.validationTimeoutMs));
  }
  return results;
}

async function collectRootListing(cwd: string): Promise<CommandEvidence> {
  return runCommand(cwd, "find", [
    ".",
    "-maxdepth",
    "2",
    "(",
    "-path",
    "./.git",
    "-o",
    "-path",
    "./node_modules",
    "-o",
    "-path",
    "./.build",
    "-o",
    "-path",
    "./dist",
    "-o",
    "-path",
    "./target",
    ")",
    "-prune",
    "-o",
    "-print",
  ]);
}

async function readReadmeExcerpt(cwd: string): Promise<FileExcerptEvidence> {
  for (const name of ["README.md", "README.markdown", "README.txt", "Readme.md", "readme.md"]) {
    const result = await readFileExcerpt(cwd, name, FILE_EXCERPT_LIMIT);
    if (result.exists) return result;
  }
  return {
    path: "README.md",
    exists: false,
    content: "",
    truncated: false,
  };
}

async function readFileExcerpt(cwd: string, path: string, maxChars: number): Promise<FileExcerptEvidence> {
  try {
    const content = await readFile(join(cwd, path), "utf8");
    return {
      path,
      exists: true,
      content: truncate(content, maxChars),
      truncated: content.length > maxChars,
    };
  } catch {
    return {
      path,
      exists: false,
      content: "",
      truncated: false,
    };
  }
}

async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  await walk(cwd, "", files, 0);
  return files.sort();
}

async function walk(cwd: string, relativeDir: string, files: string[], depth: number): Promise<void> {
  if (files.length >= 5_000 || depth > 8) return;
  let entries;
  try {
    entries = await readdir(join(cwd, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= 5_000) return;
    if (entry.name.startsWith(".") && IGNORED_DIRS.has(entry.name)) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(cwd, relativePath, files, depth + 1);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

function fileListEvidence(label: string, files: string[]): FileListEvidence {
  const sorted = [...new Set(files)].sort();
  return {
    label,
    files: sorted.slice(0, FILE_LIST_LIMIT),
    total: sorted.length,
    truncated: sorted.length > FILE_LIST_LIMIT,
  };
}

function isSourceFile(path: string): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  if (isTestFile(path)) return false;
  return /(^|\/)(Sources|src|source|lib|app|apps|packages|components|server|client)(\/|$)/i.test(path) || !path.includes("/");
}

function isTestFile(path: string): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  return /(^|\/)(Tests|tests|test|spec|__tests__)(\/|$)/.test(path) || /\.(test|spec)\.[^.]+$/i.test(path);
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function extractLatestAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter(isTextPart)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function serializeSessionLog(entries: unknown[]): string {
  const formatted = entries.map(formatSessionEntry).filter(Boolean).join("\n\n");
  return truncate(formatted || "(no session entries)", SESSION_LOG_LIMIT);
}

function formatSessionEntry(entry: unknown, index: number): string {
  if (!entry || typeof entry !== "object") return `#${index + 1} ${String(entry)}`;
  const record = entry as Record<string, unknown>;
  const type = stringProp(record, "type");
  const id = stringProp(record, "id");
  const parentId = stringProp(record, "parentId");
  const timestamp = stringProp(record, "timestamp");
  const header = `#${index + 1} type=${type || "unknown"} id=${id || "unknown"} parent=${parentId || "null"} time=${timestamp || "unknown"}`;

  if (type === "message") {
    return `${header}\n${formatMessage(record.message)}`;
  }

  if (type === "custom") {
    const customType = stringProp(record, "customType");
    if (customType === GOAL_STATE_CUSTOM_TYPE) {
      return `${header} customType=${customType}\n${truncate(JSON.stringify(record.data ?? {}, null, 2), 2_000)}`;
    }
    return `${header} customType=${customType || "unknown"}`;
  }

  if (type === "custom_message") {
    return `${header} customType=${stringProp(record, "customType") || "unknown"}\n${formatContent(record.content)}`;
  }

  if (type === "compaction" || type === "branch_summary") {
    return `${header}\nsummary:\n${truncate(String(record.summary ?? ""), 4_000)}`;
  }

  if (type === "model_change") {
    return `${header}\nmodel=${stringProp(record, "provider") || "unknown"}/${stringProp(record, "modelId") || "unknown"}`;
  }

  if (type === "thinking_level_change") {
    return `${header}\nthinkingLevel=${stringProp(record, "thinkingLevel") || "unknown"}`;
  }

  if (type === "session_info") {
    return `${header}\nname=${stringProp(record, "name") || ""}`;
  }

  return header;
}

function formatMessage(message: unknown): string {
  if (!message || typeof message !== "object") return String(message ?? "");
  const record = message as Record<string, unknown>;
  const role = stringProp(record, "role") || "unknown";
  const model = stringProp(record, "model");
  const provider = stringProp(record, "provider");
  const stopReason = stringProp(record, "stopReason");
  const toolName = stringProp(record, "toolName");
  const isError = typeof record.isError === "boolean" ? ` isError=${record.isError}` : "";
  const metadata = [
    `role=${role}`,
    provider && model ? `model=${provider}/${model}` : undefined,
    stopReason ? `stopReason=${stopReason}` : undefined,
    toolName ? `tool=${toolName}` : undefined,
    isError || undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `${metadata}\n${formatContent(record.content)}`;
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return truncate(content, 8_000);
  if (!Array.isArray(content)) return truncate(JSON.stringify(content ?? ""), 4_000);

  const parts = content.map((part) => {
    if (!part || typeof part !== "object") return String(part);
    const record = part as Record<string, unknown>;
    const type = stringProp(record, "type") || "unknown";
    if (type === "text") return truncate(String(record.text ?? ""), 8_000);
    if (type === "toolCall") {
      return `[toolCall name=${stringProp(record, "name") || "unknown"} id=${stringProp(record, "id") || "unknown"} args=${truncate(JSON.stringify(record.arguments ?? {}), 2_000)}]`;
    }
    if (type === "image") return "[image]";
    return `[${type}] ${truncate(JSON.stringify(record), 2_000)}`;
  });

  return parts.filter(Boolean).join("\n");
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}

function parseJsonObject(raw: string): unknown | undefined {
  for (const candidate of jsonCandidates(raw)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function jsonCandidates(raw: string): string[] {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  return candidates;
}

function failFromParser(rawOutput: string, summary: string): VerifierVerdict {
  return {
    verdict: "FAIL",
    confidence: 0,
    summary,
    evidence: [],
    objections: [summary],
    nextInstructions: "Make the workspace state and validation evidence explicit enough for the verifier to audit.",
    rawOutput,
  };
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringOrUndefined(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return truncate(value.trim(), maxChars);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
