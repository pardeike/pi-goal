# pi-goal

`pi-goal` is a local Pi package that adds `/goal`.

The command keeps the normal Pi TUI session visible while a separate skeptical verifier checks whether the requested objective is actually complete. If the verifier rejects the result, the extension queues concrete follow-up instructions back into the same visible main session.

## Install

From this repository:

```bash
npm install
npm run check
```

Run Pi with the extension for a one-off test:

```bash
npm exec -- pi --no-extensions -e ./extensions/goal/index.ts
```

Install it project-locally into a target repo:

```bash
cd /path/to/target/repo
pi install /path/to/pi-goal -l
```

If `pi` is not on `PATH`, use this project's local Pi binary:

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

The Pi TUI footer and goal widget show the active objective, attempt count, current state, observer model, summarizer model, last verdict, blocking objection, short steering feedback, and next instruction.

## Configuration

Project config is read from the first existing file:

- `pi-goal.config.json`
- `.pi-goal.json`
- `.pi/goal.config.json`

Set `PI_GOAL_CONFIG=/path/to/config.json` to use a specific file.

Example:

```json
{
  "maxAttempts": 5,
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
  }
}
```

`observer` is the independent goal evaluator. `verifier` is accepted as a backward-compatible alias for `observer`, and `summary` is accepted as an alias for `summarizer`. `systemPromptFile`, `promptTemplateFile`, and `extraInstructionsFile` are resolved relative to the config file.

Prompt templates support these placeholders:

- observer: `{{goal}}`, `{{mainModel}}`, `{{observerModel}}`, `{{verifierModel}}`, `{{latestAssistantSummary}}`, `{{evidence}}`
- summarizer: `{{goal}}`, `{{entryCount}}`, `{{serializedLog}}`

Environment variables override file settings:

```bash
PI_GOAL_MAX_ATTEMPTS=5
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
```

Legacy `PI_GOAL_VERIFIER_*` and `PI_GOAL_SUMMARY_*` names still work as aliases for observer and summarizer settings.

If no observer model is configured, the observer uses the current main-session model in a clean independent context. If no summarizer model is configured, the summarizer uses the observer model. Validation command capture is bounded by `validationCommandLimit` and `validationTimeoutMs`.

## Observer Model

The observer receives:

- the original objective
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

The observer must return strict JSON:

```json
{
  "verdict": "PASS",
  "confidence": 0.95,
  "summary": "Goal is complete.",
  "evidence": ["npm test exited 0"],
  "objections": [],
  "nextInstructions": "",
  "steeringFeedback": ""
}
```

Malformed observer output is treated as `FAIL`. On `FAIL`, `steeringFeedback` is fed back into the visible main session as a short nudge, alongside the fuller observer objections and next instructions.

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
- The loop stops at `PI_GOAL_MAX_ATTEMPTS` to avoid runaway work.
