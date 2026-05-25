# /goal Comparison Experiment - 2026-05-25

## Question

Is it useful to test `/goal` on a semi-complex example and compare it against asking the same weak model directly?

Yes. The experiment showed a clear behavioral difference:

- Direct prompting let the weak model stop immediately without inspecting the project.
- `/goal` did not make an extremely weak model competent, but it kept the run honest: progress stayed visible, the verifier rejected unsupported completion, and the loop continued until the attempt budget was exhausted.
- The experiment also exposed verifier-model quality as a real dependency. Local `qwen3.6:27b-coding-nvfp4` was not reliable at returning strict verifier JSON; `openai/gpt-4.1-nano` produced parseable skeptical failures.

## Fixture

Root: `/tmp/pi-goal-comparison`

The fixture is a SwiftPM package named `LedgerLite` with deliberately broken behavior:

- date filtering uses exclusive bounds instead of inclusive bounds
- malformed CSV rows are ignored instead of rejected
- bad amounts are parsed as zero instead of rejected
- category totals overwrite previous rows instead of summing them
- CLI output is sorted by amount instead of category

Baseline validation failed as intended:

```text
swift test
4 tests, 6 issues
```

## Commands

Direct run:

```bash
npm run compare:rpc -- \
  --mode direct \
  --cwd /tmp/pi-goal-comparison/direct \
  --sessionDir /tmp/pi-goal-comparison/artifacts/direct-sessions \
  --jsonl /tmp/pi-goal-comparison/artifacts/direct.jsonl \
  --transcript /tmp/pi-goal-comparison/artifacts/direct-transcript.txt \
  --timeoutMs 900000 \
  --prompt 'Fix this Swift CLI so `swift test` passes and the behavior matches README.md. Do not weaken or delete tests. Run validation and summarize exact evidence.'
```

Goal run with OpenAI verifier:

```bash
OPENAI_API_KEY="..." npm run compare:rpc -- \
  --mode goal \
  --cwd /tmp/pi-goal-comparison/goal \
  --sessionDir /tmp/pi-goal-comparison/artifacts/goal-openai-sessions \
  --jsonl /tmp/pi-goal-comparison/artifacts/goal-openai.jsonl \
  --transcript /tmp/pi-goal-comparison/artifacts/goal-openai-transcript.txt \
  --timeoutMs 900000 \
  --verifierModel openai/gpt-4.1-nano \
  --prompt '/goal Fix this Swift CLI so `swift test` passes and the behavior matches README.md. Do not weaken or delete tests. Run validation and summarize exact evidence.'
```

Goal run with local Qwen verifier:

```bash
npm run compare:rpc -- \
  --mode goal \
  --cwd /tmp/pi-goal-comparison/goal \
  --sessionDir /tmp/pi-goal-comparison/artifacts/goal-sessions \
  --jsonl /tmp/pi-goal-comparison/artifacts/goal.jsonl \
  --transcript /tmp/pi-goal-comparison/artifacts/goal-transcript.txt \
  --timeoutMs 900000 \
  --verifierModel ollama/qwen3.6:27b-coding-nvfp4 \
  --prompt '/goal Fix this Swift CLI so `swift test` passes and the behavior matches README.md. Do not weaken or delete tests. Run validation and summarize exact evidence.'
```

## Results

| Arm | Main model | Verifier | Agent starts | Tool starts | Result | Source changes | Final validation |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| Direct | `ollama/qwen2.5:0.5b` | none | 1 | 0 | stopped after asking for sample code | none | `swift test` still failed |
| `/goal` | `ollama/qwen2.5:0.5b` | `openai/gpt-4.1-nano` | 5 | 0 | `goal: failed` after 5 skeptical rejections | none | `swift test` still failed |
| `/goal` | `ollama/qwen2.5:0.5b` | `ollama/qwen3.6:27b-coding-nvfp4` | 5 | 90 | `goal: failed`; verifier output often malformed | none | `swift test` still failed |

Direct transcript:

```text
Sure, I can help you with that! Could you please provide me with a sample code for the Swift CLI?
```

OpenAI verifier status progression:

```text
goal: running 1/5
goal: verifying 1/5
goal: running 2/5
goal: verifying 2/5
goal: running 3/5
goal: verifying 3/5
goal: running 4/5
goal: verifying 4/5
goal: running 5/5
goal: verifying 5/5
goal: failed
```

The OpenAI verifier returned structured `FAIL` verdicts and rejected the run because there was no real evidence that the Swift project was fixed or validated.

## Artifacts

- `/tmp/pi-goal-comparison/artifacts/direct-transcript.txt`
- `/tmp/pi-goal-comparison/artifacts/direct.jsonl`
- `/tmp/pi-goal-comparison/artifacts/direct-swift-test.txt`
- `/tmp/pi-goal-comparison/artifacts/goal-openai-transcript.txt`
- `/tmp/pi-goal-comparison/artifacts/goal-openai.jsonl`
- `/tmp/pi-goal-comparison/artifacts/goal-openai-swift-test.txt`
- `/tmp/pi-goal-comparison/artifacts/goal-transcript.txt`
- `/tmp/pi-goal-comparison/artifacts/goal.jsonl`
- `/tmp/pi-goal-comparison/artifacts/goal-qwen-verifier-swift-test.txt`
- `/tmp/pi-goal-comparison/goal/.pi/goal/runs/goal_mpl0t337_gto45s/verifier-attempt-001.json`

## Implementation Lessons

The comparison found two extension issues and one harness issue:

- Retry prompts sent synchronously from `agent_end` were not consumed reliably in RPC/headless mode. The extension now defers the retry prompt by one event-loop turn before calling `pi.sendUserMessage`.
- `scripts/pi-goal-qwen` must force-load the extension from this checkout with `--no-extensions -e <repo>/extensions/goal/index.ts`; otherwise running from another target repo may not have `/goal`.
- The RPC comparison harness needed to ignore stdout after terminal state so it does not write to a closed JSONL stream.

## Follow-up Improvements

Implemented after this comparison: the verifier evidence bundle was strengthened before asking any model to judge completion. It now includes:

- root file listing
- README excerpt
- test file listing
- source file listing
- captured output from running detected validation commands in the verifier phase
- a separate model-generated comprehensive session-log summary
- a short `steeringFeedback` field that is fed back into the visible main session on failed verification

That would reduce verifier hallucinations such as claiming `README.md` was missing when it existed.

Later `/goal` test runs exposed two additional weak-model failure modes:

- a weak main model can stream a malformed tool call indefinitely before the observer receives an `agent_end`
- even with good observer feedback, a weak main model can repeat stale failing edit calls across attempts

The extension now addresses those as follows:

- internal observer and summarizer calls must return strict structured JSON, including structured session-summary fields
- the observer verdict includes `observerMemory`, a bounded cross-attempt memory that is persisted on the goal run and passed into later observer attempts
- failed observer verdicts can include `steeringFeedback`, which is fed back into the visible main session as a short nudge
- an attempt guard aborts pathological active attempts with oversized or whitespace-heavy assistant stream deltas before they monopolize the loop
- the RPC comparison harness caps single event and total JSONL sizes so broken streams do not consume unbounded disk
