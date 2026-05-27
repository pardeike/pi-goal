# pi-goal

`pi-goal` is a local Pi package that adds `/goal`.

The command keeps the normal Pi TUI session visible while a separate skeptical verifier checks whether the requested objective is actually complete. If the verifier rejects the result, the extension queues concrete follow-up instructions back into the same visible main session.

## Install

From this repository:

```bash
npm install
npm run check
```

Install this checkout into your user-global Pi configuration:

```bash
/path/to/pi-goal/install.sh
```

or from this repository:

```bash
./install.sh
```

The installer runs `npm install`, `npm run check`, smoke-loads the extension, runs `pi install <this repo>`, and creates a non-overwriting global config template at `~/.pi/agent/pi-goal.config.json` or `PI_CODING_AGENT_DIR/pi-goal.config.json`. Use `--skip-check`, `--skip-smoke`, or `--skip-config` when you need a faster or narrower reinstall.

Install into one target repo's local Pi configuration only when you need project-specific behavior:

```bash
cd /path/to/target/repo
/path/to/pi-goal/install.sh --local
```

or from this repository:

```bash
./install.sh --target /path/to/target/repo
```

Both local forms run `pi install <this repo> -l` in the target directory and write that repo's `.pi/settings.json`.

Run Pi with the extension for a one-off test:

```bash
npm exec -- pi --no-extensions -e ./extensions/goal/index.ts
```

Install it manually into the user-global Pi configuration:

```bash
pi install /path/to/pi-goal
```

Install it manually project-locally into a target repo:

```bash
cd /path/to/target/repo
pi install /path/to/pi-goal -l
```

If `pi` is not on `PATH`, use this project's local Pi binary. For a user-global install:

```bash
npm exec --prefix /path/to/pi-goal -- pi install /path/to/pi-goal
```

For a project-local install:

```bash
cd /path/to/target/repo
npm exec --prefix /path/to/pi-goal -- pi install /path/to/pi-goal -l
```

If `pi` is not globally installed, use this repository's local binary while developing:

```bash
cd /path/to/pi-goal
npm exec -- pi --version
```

## Usage

For the local "dumb main model, stronger independent observer" setup:

```bash
cd /path/to/target/repo
/path/to/pi-goal/scripts/pi-goal-qwen
```

This launches Pi with:

- main model: `ollama/qwen2.5:0.5b`
- observer model: `ollama/qwen3.6:27b-coding-nvfp4`
- thinking: `off`
- the `/goal` extension force-loaded from this checkout

Inside Pi:

```text
/goal make npm test pass without weakening tests
/goal status
/goal cancel
```

`/goal <objective>` starts a run. The main session receives a normal visible prompt and works as usual. When the main agent stops, the extension first launches a separate summarizer session to summarize the visible session log, collects deterministic workspace evidence, then launches an independent observer session with a clean context. The observer is read-oriented by default and is instructed to run validation commands, inspect the workspace, and fail closed when evidence is missing.

The Pi TUI footer and goal widget put current state and attempt first, group the latest verifier verdict with blockers and next steps, then show notes such as observer memory, no-progress count, stop reason, and compact runtime model details.

## Configuration

Configuration is layered from broad defaults to project-specific overrides:

1. built-in defaults
2. global goal config
3. project goal config
4. `PI_GOAL_*` environment variables

Global goal config is read from:

- `PI_GOAL_GLOBAL_CONFIG`, when set
- otherwise `PI_CODING_AGENT_DIR/pi-goal.config.json`
- otherwise `~/.pi/agent/pi-goal.config.json`

The global installer creates this file if it does not already exist. The template leaves model and thinking fields blank so behavior stays close to built-in defaults until you edit it.

Project goal config is read from the first existing file:

- `pi-goal.config.json`
- `.pi-goal.json`
- `.pi/goal.config.json`

Set `PI_GOAL_CONFIG=/path/to/config.json` to use a specific project config file while still inheriting global goal config. Project config overrides only the fields it specifies, so a global file is a good place for stable choices such as `observer.model`, `summarizer.model`, model thinking levels, and shared guard limits. Keep project-specific validation commands in the local project config.

Example:

```json
{
  "maxAttempts": 10000,
  "observer": {
    "model": "openai/gpt-4.1-mini",
    "thinking": "low",
    "systemPromptFile": "prompts/observer-system.txt",
    "promptTemplateFile": "prompts/observer-template.txt",
    "extraInstructions": "Reject missing validation and weakened tests.",
    "tools": ["read", "bash", "grep", "find", "ls"]
  },
  "summarizer": {
    "model": "openai/gpt-4.1-nano",
    "thinking": "off",
    "systemPrompt": "Summarize session logs factually for a skeptical evaluator.",
    "promptTemplateFile": "prompts/summarizer-template.txt",
    "tools": []
  },
  "evidence": {
    "validationCommands": ["swift test"],
    "extraValidationCommands": [],
    "validationCommandLimit": 3,
    "validationTimeoutMs": 120000
  },
  "attemptGuard": {
    "enabled": true,
    "maxSingleDeltaChars": 64000,
    "maxAssistantDeltaChars": 512000,
    "maxWhitespaceDeltaChars": 32000
  },
  "loopSafety": {
    "enabled": true,
    "maxRuntimeMs": 0,
    "minAttemptsBeforeStallCheck": 20,
    "maxStalledAttempts": 12,
    "minStalledRuntimeMs": 43200000
  },
  "httpIdleTimeout": {
    "enabled": true,
    "timeoutMs": 0
  },
  "mainToolIdleTimeout": {
    "enabled": true,
    "timeoutMs": 300000
  }
}
```

`observer` is the independent goal evaluator. `verifier` is accepted as a backward-compatible alias for `observer`, and `summary` is accepted as an alias for `summarizer`. `systemPromptFile`, `promptTemplateFile`, and `extraInstructionsFile` are resolved relative to the config file.

Prompt templates support these placeholders:

- observer: `{{goal}}`, `{{mainModel}}`, `{{observerModel}}`, `{{verifierModel}}`, `{{observerMemory}}`, `{{latestAssistantSummary}}`, `{{evidence}}`
- summarizer: `{{goal}}`, `{{entryCount}}`, `{{serializedLog}}`

Custom templates cannot opt out of structured output. The extension always appends a mandatory strict-JSON contract to internal observer and summarizer prompts.

Environment variables override file settings:

```bash
PI_GOAL_MAX_ATTEMPTS=10000
PI_GOAL_OBSERVER_MODEL=openai/gpt-4.1-mini
PI_GOAL_OBSERVER_THINKING=low
PI_GOAL_OBSERVER_SYSTEM_PROMPT='...'
PI_GOAL_OBSERVER_PROMPT_TEMPLATE='... {{goal}} ... {{evidence}} ...'
PI_GOAL_OBSERVER_EXTRA_INSTRUCTIONS='Be especially skeptical of shortcut fixes.'
PI_GOAL_OBSERVER_TOOLS='read,bash,grep,find,ls'
PI_GOAL_SUMMARIZER_MODEL=openai/gpt-4.1-nano
PI_GOAL_SUMMARIZER_THINKING=off
PI_GOAL_SUMMARIZER_SYSTEM_PROMPT='...'
PI_GOAL_SUMMARIZER_PROMPT_TEMPLATE='... {{serializedLog}} ...'
PI_GOAL_SUMMARIZER_EXTRA_INSTRUCTIONS='Include failed tool calls.'
PI_GOAL_VALIDATION_COMMANDS='swift test'
PI_GOAL_EXTRA_VALIDATION_COMMANDS='swift test --filter LedgerLiteCoreTests'
PI_GOAL_VALIDATION_COMMAND_LIMIT=3
PI_GOAL_VALIDATION_TIMEOUT_MS=120000
PI_GOAL_ATTEMPT_GUARD_ENABLED=true
PI_GOAL_ATTEMPT_MAX_SINGLE_DELTA_CHARS=64000
PI_GOAL_ATTEMPT_MAX_ASSISTANT_DELTA_CHARS=512000
PI_GOAL_ATTEMPT_MAX_WHITESPACE_DELTA_CHARS=32000
PI_GOAL_LOOP_SAFETY_ENABLED=true
PI_GOAL_MAX_RUNTIME_MS=0
PI_GOAL_MIN_ATTEMPTS_BEFORE_STALL_CHECK=20
PI_GOAL_MAX_STALLED_ATTEMPTS=12
PI_GOAL_MIN_STALLED_RUNTIME_MS=43200000
PI_GOAL_HTTP_IDLE_TIMEOUT_ENABLED=true
PI_GOAL_HTTP_IDLE_TIMEOUT_MS=0
PI_GOAL_MAIN_TOOL_IDLE_TIMEOUT_ENABLED=true
PI_GOAL_MAIN_TOOL_IDLE_TIMEOUT_MS=300000
```

Legacy `PI_GOAL_VERIFIER_*` and `PI_GOAL_SUMMARY_*` names still work as aliases for observer and summarizer settings.

If no observer model is configured, the observer uses the current main-session model in a clean independent context. If no summarizer model is configured, the summarizer uses the observer model. Validation command capture is bounded by `validationCommandLimit` and `validationTimeoutMs`.

While `/goal` is active, `httpIdleTimeout` temporarily overrides Pi's HTTP idle timeout. The default `timeoutMs: 0` disables the idle timeout for goal runs, and `/goal` restores the prior Pi setting when the run passes, fails, is cancelled, or the session shuts down.

`mainToolIdleTimeout` aborts and retries the visible main-session attempt when a tool call goes quiet for too long. The default timeout is 5 minutes. This catches cases like a hung shell pipeline before the run disappears into an endless wait without ever reaching independent verification.

## Observer Model

The observer receives:

- the original objective
- its durable observer memory from prior attempts in this `/goal` run
- the main agent's final visible summary
- a separate model-generated comprehensive summary of the full session log
- pre-collected workspace evidence
- `git status --short`
- `git diff --stat`
- `git diff --name-only`
- root workspace listing
- README excerpt
- source and test file listings
- discovered validation commands such as `npm test`, `npm run check`, `swift test`, `cargo test`, `pytest`, or `go test ./...`
- captured output from running configured or detected validation commands, within the configured timeout and command limit

The summarizer must return strict JSON:

```json
{
  "summary": "dense factual summary of the session log",
  "files": ["files inspected, edited, or mentioned"],
  "commands": ["commands run or attempted, including validation"],
  "claims": ["completion or evidence claims made by the main agent"],
  "openIssues": ["unresolved failures, missing evidence, suspicious behavior, or shortcuts"],
  "toolErrors": ["tool calls or command attempts that failed"]
}
```

The observer must return strict JSON:

```json
{
  "verdict": "PASS",
  "confidence": 0.95,
  "summary": "Goal is complete.",
  "evidence": ["npm test exited 0"],
  "objections": [],
  "nextInstructions": "",
  "steeringFeedback": "",
  "observerMemory": "Attempt 1 failed validation; attempt 2 fixed the filter and npm test exited 0."
}
```

Malformed observer output is treated as `FAIL`. On `FAIL`, `steeringFeedback` is fed back into the visible main session as a short nudge, alongside the fuller observer objections and next instructions.

`observerMemory` is the observer's bounded cross-attempt memory for the current goal. The extension persists it on the goal run, passes it into the next observer prompt, shows a short excerpt in the TUI widget, and includes it in verifier logs. It should preserve durable facts such as previous validation failures, files already changed, repeated tool-call problems, test weakening concerns, and the next verification focus.

Malformed summarizer output does not by itself fail the goal. It is converted into structured evidence with an `openIssues` entry so the observer can treat the missing summary as a weak-evidence condition.

## Attempt Guard

Less capable models can fail before the observer gets a turn, for example by streaming a malformed edit tool call or pages of whitespace. While a `/goal` run is active, the attempt guard watches assistant stream deltas and aborts a pathological attempt when configured limits are exceeded. The run is not marked complete; it records a synthetic `FAIL` verdict, updates the TUI, and feeds a retry prompt back into the visible main session with instructions to use smaller concrete edits and validation.

The guard is deliberately narrow. It does not judge code quality or goal completion; it only prevents one broken main-model attempt from monopolizing the loop before independent verification can run.

## Loop Safety

`maxAttempts` is the final hard budget. Values up to `10000` are accepted, and the default is `10000` because `/goal` is meant to keep weaker local/internal models working until success when they are still making observable progress.

`loopSafety` is the earlier bail-out layer for runs that are no longer making observable progress:

- `maxRuntimeMs` stops a goal after a wall-clock budget. It defaults to `0`, which disables the wall-clock stop.
- `minAttemptsBeforeStallCheck` prevents early give-up. Stalled-loop detection is ignored until this attempt number is reached.
- `maxStalledAttempts` stops only after this many repeated verifier cycles with unchanged workspace and validation evidence.
- `minStalledRuntimeMs` is the minimum wall-clock time without progress before stalled-loop detection can stop the run. It defaults to `43200000` milliseconds, or 12 hours.

`httpIdleTimeout` temporarily overrides Pi's HTTP idle timeout while a `/goal` run is active. The default `timeoutMs` is `0`, which disables the idle timeout so slow local thinking models do not get terminated after Pi's normal 5-minute idle window. The previous Pi setting is restored when the goal passes, fails, is cancelled, or the session shuts down. Set `PI_GOAL_HTTP_IDLE_TIMEOUT_MS` or `PI_GOAL_HTTP_IDLE_TIMEOUT_ENABLED=false` to override this behavior.

`mainToolIdleTimeout` is the guard for the visible main session itself. When an active tool stops producing updates and does not finish before `timeoutMs`, `/goal` aborts the attempt, records a synthetic `FAIL`, and feeds back a retry prompt that tells the main model to use a smaller or bounded command. The default `timeoutMs` is `300000` milliseconds, or 5 minutes. Set `PI_GOAL_MAIN_TOOL_IDLE_TIMEOUT_MS=0` or `PI_GOAL_MAIN_TOOL_IDLE_TIMEOUT_ENABLED=false` to disable it.

Progress is detected deterministically from evidence collected before observer judgement: `git status`, `git diff --stat`, changed file names, validation commands, validation exit codes, and normalized validation output. A new failure mode or changed validation result resets the stalled count. Reworded observer text alone does not count as progress.

## Development

```bash
npm run typecheck
npm test
npm run check
```

Run the RPC comparison harness:

```bash
npm run compare:rpc -- --help
```

The first semi-complex comparison is documented in `docs/comparison-2026-05-25.md`.

Smoke-load the extension:

```bash
npm exec -- pi --no-extensions -e ./extensions/goal/index.ts --no-session
```

Verifier logs are written under the target repo:

```text
.pi/goal/runs/<goal-id>/verifier-attempt-001.json
```

## Limits

- The observer is independent by context. It is independent by model only when observer configuration selects a different model.
- The evidence collector runs configured or detected validation commands before observation. The observer can also run read-only inspection and validation commands through Pi's tools. Command choice still matters.
- The loop stops at `PI_GOAL_MAX_ATTEMPTS`, `PI_GOAL_MAX_RUNTIME_MS`, or repeated unchanged evidence after `PI_GOAL_MIN_ATTEMPTS_BEFORE_STALL_CHECK`, `PI_GOAL_MAX_STALLED_ATTEMPTS`, and `PI_GOAL_MIN_STALLED_RUNTIME_MS`.
