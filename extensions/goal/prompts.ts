import type { EvidenceBundle, FileListEvidence, GoalRun, SessionSummaryEvidence, VerifierVerdict } from "./types.ts";
import { formatModelRef, truncate } from "./state.ts";

const SUMMARIZER_STRUCTURED_OUTPUT_CONTRACT = `Mandatory structured output:
Return only strict JSON with this exact shape:
{
  "summary": "dense factual summary of the session log",
  "files": ["files inspected, edited, or mentioned"],
  "commands": ["commands run or attempted, including validation"],
  "claims": ["completion or evidence claims made by the main agent"],
  "openIssues": ["unresolved failures, missing evidence, suspicious behavior, or shortcuts"],
  "toolErrors": ["tool calls or command attempts that failed"]
}

Rules for this JSON:
- Do not wrap it in Markdown.
- Do not add text before or after the JSON.
- Use empty arrays when a field has no items.
- Every array item must be a quoted JSON string. Do not write prose fragments outside strings.
- Do not judge whether the goal is complete.`;

const OBSERVER_STRUCTURED_OUTPUT_CONTRACT = `Mandatory structured output:
Return only strict JSON with this exact shape:
{
  "verdict": "PASS" | "FAIL",
  "confidence": 0.0,
  "summary": "short explanation",
  "evidence": ["specific command/file/result evidence"],
  "objections": ["blocking issues if FAIL"],
  "nextInstructions": "specific remediation instruction to send to the main agent if FAIL",
  "steeringFeedback": "one short direct nudge for the main agent's next attempt if FAIL",
  "observerMemory": "updated durable memory of the overall goal progress across attempts"
}

Rules for this JSON:
- Do not wrap it in Markdown.
- Do not add text before or after the JSON.
- Use PASS only when the observable workspace state satisfies the goal.
- Use FAIL when evidence is missing, validation fails, tests are weakened, or output is uncertain.
- Always update observerMemory. Keep it concise, factual, and useful for the next verifier attempt.`;

export function buildInitialGoalPrompt(run: GoalRun): string {
  return `Goal mode is active.

Objective:
${run.objective}

Work normally and visibly in this Pi session. Use the current model and tools as you usually would. Keep tool calls small and well-formed; if a tool call fails, recover with a simpler targeted command or edit. Do not claim completion from intent alone. Inspect the real workspace, run relevant checks, and make only changes that directly support the objective.

When you believe the objective is complete, stop and summarize the exact evidence: files changed, commands run, exit codes, and any remaining risk. An independent skeptical verifier will inspect the result.`;
}

export function buildRetryPrompt(run: GoalRun, verdict: VerifierVerdict): string {
  const objections = verdict.objections.length > 0 ? verdict.objections.map((item) => `- ${item}`).join("\n") : "- The verifier did not provide detailed objections.";
  const evidence = verdict.evidence.length > 0 ? verdict.evidence.map((item) => `- ${item}`).join("\n") : "- No acceptable evidence was provided.";
  const next = verdict.nextInstructions.trim() || "Address the verifier's objections with concrete evidence.";
  const steering = verdict.steeringFeedback?.trim() || next;
  const observerMemory = verdict.observerMemory?.trim() || run.observerMemory?.trim();
  const memorySection = observerMemory
    ? `
Observer memory:
${truncate(observerMemory, 1_200)}
`
    : "";

  return `Goal verifier rejected attempt ${run.attempt}/${run.maxAttempts}.

Objective:
${run.objective}

Short steering feedback:
${steering}

Verifier summary:
${verdict.summary}

Verifier evidence:
${evidence}

Blocking objections:
${objections}
${memorySection}

Next required work:
${next}

Tool recovery rule:
If a previous tool call failed, do not repeat the same arguments. Re-read the current file and use an exact current replacement; if that remains brittle, rewrite the smallest complete file or function instead.

Continue working visibly in this main Pi session. Do not argue with the verifier or restate completion. Fix the concrete issue, run relevant validation, and stop with exact evidence when done.`;
}

export function buildSessionSummaryPrompt(params: {
  run: GoalRun;
  serializedLog: string;
  entryCount: number;
  promptTemplate?: string;
  extraInstructions?: string;
}): string {
  const values = {
    goal: params.run.objective,
    serializedLog: params.serializedLog,
    entryCount: String(params.entryCount),
  };
  if (params.promptTemplate?.trim()) {
    return withStructuredOutputContract(renderTemplate(params.promptTemplate, values), SUMMARIZER_STRUCTURED_OUTPUT_CONTRACT, params.extraInstructions, "Additional summarizer instructions");
  }

  const extra = params.extraInstructions?.trim()
    ? `
Additional summarizer instructions:
${params.extraInstructions.trim()}
`
    : "";

  const prompt = `Summarize this Pi session log comprehensively for a separate skeptical goal evaluator.

Goal:
${params.run.objective}

Session entry count:
${params.entryCount}

Session log:
${params.serializedLog}

Produce a factual, dense summary. Include:
- what the user asked for
- what the main agent attempted
- files, commands, tool calls, errors, and validation results mentioned in the log
- claims the main agent made about completion
- unresolved issues, shortcuts, missing evidence, or suspicious behavior

Do not judge whether the goal is complete. Do not give advice to the main agent.${extra}`;
  return withStructuredOutputContract(prompt, SUMMARIZER_STRUCTURED_OUTPUT_CONTRACT);
}

export function buildVerifierPrompt(params: {
  run: GoalRun;
  evidence: EvidenceBundle;
  latestAssistantSummary: string;
  promptTemplate?: string;
  extraInstructions?: string;
}): string {
  const formattedEvidence = formatEvidenceBundle(params.evidence);
  const latestAssistantSummary = truncate(params.latestAssistantSummary || "(no assistant summary found)", 6_000);
  const observerMemory = params.run.observerMemory?.trim() ? truncate(params.run.observerMemory, 4_000) : "(none yet)";
  const values = {
    goal: params.run.objective,
    mainModel: formatModelRef(params.run.mainModel),
    verifierModel: formatModelRef(params.run.verifierModel),
    observerModel: formatModelRef(params.run.verifierModel),
    observerMemory,
    latestAssistantSummary,
    evidence: formattedEvidence,
  };
  if (params.promptTemplate?.trim()) {
    const rendered = renderTemplate(params.promptTemplate, values);
    return withStructuredOutputContract(
      `${rendered.trim()}

Mandatory observer memory input:
${observerMemory}`,
      OBSERVER_STRUCTURED_OUTPUT_CONTRACT,
      params.extraInstructions,
      "Additional observer instructions",
    );
  }

  const extra = params.extraInstructions?.trim()
    ? `
Additional observer instructions:
${params.extraInstructions.trim()}
`
    : "";

  const prompt = `You are an independent completion verifier. You are not continuing the main agent's work. You are auditing whether the goal is actually complete.

Goal:
${params.run.objective}

Main agent model:
${formatModelRef(params.run.mainModel)}

Verifier model:
${formatModelRef(params.run.verifierModel)}

Observer memory from previous attempts:
${observerMemory}

Main agent's latest completion summary:
${latestAssistantSummary}

Pre-collected workspace evidence:
${formattedEvidence}

Rules:
- Be skeptical.
- Do not trust the main agent's claims without evidence.
- Treat the model-generated session summary as an audit aid, not as proof.
- Prefer direct inspection and commands over summaries.
- You may run read-only inspection and validation commands.
- Do not modify files.
- Maintain observerMemory as your durable cross-attempt memory. Preserve key prior failures, progress, validated facts, and the next verification focus. Drop stale details when evidence supersedes them.
- Check for shortcuts, deleted tests, weakened assertions, stubbed behavior, fake passing output, skipped validation, and unrelated rewrites.
- If the session evidence shows repeated failed tool calls, make steeringFeedback tell the main agent to change tool strategy instead of retrying the same arguments.
- If the goal requires tests, run the narrowest relevant tests first, then broader tests when appropriate.
- If validation cannot be performed, return FAIL with the missing evidence.
- Return PASS only when the observable workspace state satisfies the goal.
${extra}`;
  return withStructuredOutputContract(prompt, OBSERVER_STRUCTURED_OUTPUT_CONTRACT);
}

export function formatEvidenceBundle(evidence: EvidenceBundle): string {
  const detected = evidence.detectedCommands.length > 0 ? evidence.detectedCommands.join("\n") : "(none detected)";
  const validation = evidence.validationResults.length > 0 ? evidence.validationResults.map(formatCommandEvidence).join("\n\n") : "(none run)";
  return `cwd: ${evidence.cwd}
collectedAt: ${evidence.collectedAt}
sessionFile: ${evidence.sessionFile ?? "(none)"}

Model-generated comprehensive session log summary:
${formatSessionSummary(evidence.sessionSummary)}

$ ${evidence.gitStatus.command}
exit ${evidence.gitStatus.exitCode}
stdout:
${emptyMarker(evidence.gitStatus.stdout)}
stderr:
${emptyMarker(evidence.gitStatus.stderr)}

$ ${evidence.gitDiffStat.command}
exit ${evidence.gitDiffStat.exitCode}
stdout:
${emptyMarker(evidence.gitDiffStat.stdout)}
stderr:
${emptyMarker(evidence.gitDiffStat.stderr)}

$ ${evidence.gitDiffNameOnly.command}
exit ${evidence.gitDiffNameOnly.exitCode}
stdout:
${emptyMarker(evidence.gitDiffNameOnly.stdout)}
stderr:
${emptyMarker(evidence.gitDiffNameOnly.stderr)}

$ ${evidence.rootListing.command}
exit ${evidence.rootListing.exitCode}
stdout:
${emptyMarker(evidence.rootListing.stdout)}
stderr:
${emptyMarker(evidence.rootListing.stderr)}

README excerpt (${evidence.readmeExcerpt.path}):
${evidence.readmeExcerpt.exists ? emptyMarker(evidence.readmeExcerpt.content) : "(not found)"}
${evidence.readmeExcerpt.truncated ? "[truncated]" : ""}

Source files:
${formatFileList(evidence.sourceFiles)}

Test files:
${formatFileList(evidence.testFiles)}

Detected validation commands:
${detected}

Captured validation command output:
${validation}`;
}

function formatCommandEvidence(result: { command: string; exitCode: number; stdout: string; stderr: string }): string {
  return `$ ${result.command}
exit ${result.exitCode}
stdout:
${emptyMarker(result.stdout)}
stderr:
${emptyMarker(result.stderr)}`;
}

function formatFileList(list: FileListEvidence): string {
  const files = list.files.length > 0 ? list.files.join("\n") : "(none)";
  const suffix = list.truncated ? `\n[truncated: showing ${list.files.length} of ${list.total}]` : "";
  return `${files}${suffix}`;
}

function formatSessionSummary(summary: SessionSummaryEvidence | undefined): string {
  if (!summary) return "(not generated)";
  const model = summary.model ? formatModelRef(summary.model) : "unknown";
  return `generatedAt: ${summary.generatedAt}
model: ${model}
entryCount: ${summary.entryCount}
summary:
${emptyMarker(summary.summary)}
files:
${formatSummaryArray(summary.files)}
commands:
${formatSummaryArray(summary.commands)}
claims:
${formatSummaryArray(summary.claims)}
openIssues:
${formatSummaryArray(summary.openIssues)}
toolErrors:
${formatSummaryArray(summary.toolErrors)}`;
}

function emptyMarker(value: string): string {
  return value.trim() ? value.trim() : "(empty)";
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}

function withStructuredOutputContract(prompt: string, contract: string, extraInstructions?: string, extraHeader?: string): string {
  const extra = extraInstructions?.trim() && extraHeader
    ? `
${extraHeader}:
${extraInstructions.trim()}
`
    : "";
  return `${prompt.trim()}${extra}

${contract}`;
}

function formatSummaryArray(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "(none)";
}
