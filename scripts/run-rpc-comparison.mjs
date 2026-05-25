#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

for (const required of ["mode", "cwd", "prompt", "jsonl", "transcript", "sessionDir"]) {
  if (!args[required]) {
    printUsage();
    throw new Error(`Missing --${required}`);
  }
}

if (args.mode !== "direct" && args.mode !== "goal") {
  throw new Error("--mode must be direct or goal");
}

const timeoutMs = Number(args.timeoutMs ?? 15 * 60 * 1000);
const maxEventBytes = Number(args.maxEventBytes ?? 20 * 1024 * 1024);
const maxJsonlBytes = Number(args.maxJsonlBytes ?? 100 * 1024 * 1024);
const mainModel = args.mainModel ?? "ollama/qwen2.5:0.5b";
const mainThinking = args.mainThinking ?? "off";
const observerModel = args.observerModel ?? args.verifierModel ?? "ollama/qwen3.6:27b-coding-nvfp4";
const observerThinking = args.observerThinking ?? args.verifierThinking ?? "off";
const summarizerModel = args.summarizerModel ?? observerModel;
const summarizerThinking = args.summarizerThinking ?? observerThinking;

const piArgs = [
  "exec",
  "--prefix",
  repoRoot,
  "--",
  "pi",
  "--mode",
  "rpc",
  "--session-dir",
  args.sessionDir,
  "--model",
  mainModel,
  "--thinking",
  mainThinking,
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-themes",
];

if (args.mode === "goal") {
  piArgs.push("--no-extensions", "-e", `${repoRoot}/extensions/goal/index.ts`);
} else {
  piArgs.push("--no-extensions");
}

await mkdir(dirname(resolve(args.jsonl)), { recursive: true });
await mkdir(dirname(resolve(args.transcript)), { recursive: true });

const jsonl = createWriteStream(args.jsonl, { flags: "w" });
const transcriptLines = [];
const proc = spawn("npm", piArgs, {
  cwd: args.cwd,
  env: {
    ...process.env,
    PI_GOAL_OBSERVER_MODEL: observerModel,
    PI_GOAL_OBSERVER_THINKING: observerThinking,
    PI_GOAL_SUMMARIZER_MODEL: summarizerModel,
    PI_GOAL_SUMMARIZER_THINKING: summarizerThinking,
    PI_GOAL_MAX_ATTEMPTS: args.maxAttempts ?? "5",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderrBuffer = "";
let settled = false;
let sawAgentStart = false;
let agentEndCount = 0;
let terminalGoalStatus;
let jsonlBytes = 0;

const timer = setTimeout(() => {
  void finish("timeout");
}, timeoutMs);

proc.stdout.on("data", (chunk) => {
  if (settled) return;
  stdoutBuffer += chunk.toString();
  if (stdoutBuffer.length > maxEventBytes && !stdoutBuffer.includes("\n")) {
    transcriptLines.push(`\n[stdout_line_too_large] buffered=${stdoutBuffer.length} max=${maxEventBytes}\n`);
    void finish(`stdout-line-too-large:${stdoutBuffer.length}`);
    return;
  }
  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
    if (settled) return;
    const line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    if (!writeJsonlLine(line)) return;
    handleJsonLine(line);
  }
});

proc.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderrBuffer += text;
  transcriptLines.push(`[stderr] ${text}`);
});

proc.on("exit", (code, signal) => {
  if (!settled) {
    void finish(`process-exit:${code ?? signal ?? "unknown"}`);
  }
});

send({
  id: "prompt-1",
  type: "prompt",
  message: args.prompt,
});

function handleJsonLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    transcriptLines.push(`[unparsed] ${line}`);
    return;
  }

  if (event.type === "response") {
    transcriptLines.push(`[response:${event.command}] success=${event.success}`);
    return;
  }

  if (event.type === "agent_start") {
    sawAgentStart = true;
    transcriptLines.push("\n[agent_start]\n");
    return;
  }

  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update?.type === "text_delta") {
      transcriptLines.push(update.delta);
    }
    return;
  }

  if (event.type === "tool_execution_start") {
    transcriptLines.push(`\n[tool_start] ${event.toolName} ${JSON.stringify(event.args ?? {})}\n`);
    return;
  }

  if (event.type === "tool_execution_end") {
    transcriptLines.push(`\n[tool_end] ${event.toolName} error=${Boolean(event.isError)}\n`);
    return;
  }

  if (event.type === "agent_end") {
    agentEndCount += 1;
    transcriptLines.push(`\n[agent_end ${agentEndCount}]\n`);
    if (args.mode === "direct") {
      void finish("direct-agent-end");
    }
    return;
  }

  if (event.type === "extension_ui_request") {
    if (event.method === "setStatus" && event.statusKey === "goal") {
      const text = event.text ?? event.statusText ?? event.value ?? "";
      if (text) transcriptLines.push(`\n[goal_status] ${text}\n`);
      if (/goal:\s*(passed|failed|cancelled)/i.test(text)) {
        terminalGoalStatus = text;
        void finish(`goal-terminal:${text}`);
      }
    }

    const widgetLines = event.content ?? event.widgetLines;
    if (event.method === "setWidget" && event.widgetKey === "goal" && Array.isArray(widgetLines)) {
      transcriptLines.push(`\n[goal_widget]\n${widgetLines.join("\n")}\n`);
    }
  }
}

function writeJsonlLine(line) {
  const lineBytes = Buffer.byteLength(line) + 1;
  if (lineBytes > maxEventBytes) {
    const truncated = JSON.stringify({
      type: "event_truncated",
      originalBytes: lineBytes,
      prefix: line.slice(0, 2048),
    });
    jsonl.write(`${truncated}\n`);
    transcriptLines.push(`\n[event_truncated] originalBytes=${lineBytes} max=${maxEventBytes}\n`);
    void finish(`event-too-large:${lineBytes}`);
    return false;
  }

  if (jsonlBytes + lineBytes > maxJsonlBytes) {
    const capped = JSON.stringify({
      type: "jsonl_cap_reached",
      maxJsonlBytes,
      attemptedTotalBytes: jsonlBytes + lineBytes,
    });
    jsonl.write(`${capped}\n`);
    transcriptLines.push(`\n[jsonl_cap_reached] bytes=${jsonlBytes + lineBytes} max=${maxJsonlBytes}\n`);
    void finish(`jsonl-cap:${jsonlBytes + lineBytes}`);
    return false;
  }

  jsonl.write(`${line}\n`);
  jsonlBytes += lineBytes;
  return true;
}

function send(command) {
  proc.stdin.write(`${JSON.stringify(command)}\n`);
}

async function finish(reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  transcriptLines.push(`\n[finish] ${reason}\n`);
  if (terminalGoalStatus) transcriptLines.push(`[terminal_goal_status] ${terminalGoalStatus}\n`);
  if (!sawAgentStart) transcriptLines.push("[warning] agent_start was not observed\n");
  if (stderrBuffer.trim()) transcriptLines.push(`\n[stderr_all]\n${stderrBuffer}\n`);
  await new Promise((resolveEnd) => jsonl.end(resolveEnd));
  try {
    proc.stdin.end();
    proc.kill("SIGTERM");
  } catch {
    // Process may already be gone.
  }
  await writeFile(args.transcript, transcriptLines.join(""), "utf8");
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      result.help = "true";
      continue;
    }
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    result[name] = argv[i + 1];
    i += 1;
  }
  return result;
}

function printUsage() {
  console.log(`Usage:
  npm run compare:rpc -- \\
    --mode direct|goal \\
    --cwd /path/to/fixture \\
    --sessionDir /tmp/pi-goal-comparison/artifacts/sessions \\
    --jsonl /tmp/pi-goal-comparison/artifacts/run.jsonl \\
    --transcript /tmp/pi-goal-comparison/artifacts/run-transcript.txt \\
    --prompt 'Fix the project and run validation.'

Optional:
  --mainModel ollama/qwen2.5:0.5b
  --mainThinking off
  --observerModel openai/gpt-4.1-nano
  --observerThinking off
  --summarizerModel openai/gpt-4.1-nano
  --summarizerThinking off
  --maxAttempts 5
  --maxEventBytes 20971520
  --maxJsonlBytes 104857600
  --timeoutMs 900000`);
}
