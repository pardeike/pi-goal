import { describe, expect, it } from "vitest";
import { parseSessionSummaryOutput, parseVerifierOutput } from "../extensions/goal/verifier.ts";

describe("parseVerifierOutput", () => {
  it("accepts strict JSON pass verdicts", () => {
    const verdict = parseVerifierOutput(
      JSON.stringify({
        verdict: "PASS",
        confidence: 0.91,
        summary: "Tests pass.",
        evidence: ["npm test exit 0"],
        objections: [],
        nextInstructions: "",
        steeringFeedback: "",
        observerMemory: "Validation passed on attempt 2.",
      }),
    );

    expect(verdict.verdict).toBe("PASS");
    expect(verdict.confidence).toBe(0.91);
    expect(verdict.evidence).toEqual(["npm test exit 0"]);
    expect(verdict.observerMemory).toBe("Validation passed on attempt 2.");
  });

  it("extracts fenced JSON", () => {
    const verdict = parseVerifierOutput(`Here is the result:

\`\`\`json
{"verdict":"FAIL","confidence":1.4,"summary":"No test evidence","evidence":[],"objections":["npm test was not run"],"nextInstructions":"Run npm test","steeringFeedback":"Run npm test before claiming completion.","observerMemory":"Attempt failed because no validation command was run."}
\`\`\``);

    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.confidence).toBe(1);
    expect(verdict.objections).toEqual(["npm test was not run"]);
    expect(verdict.steeringFeedback).toBe("Run npm test before claiming completion.");
    expect(verdict.observerMemory).toContain("no validation");
  });

  it("fails closed on malformed output", () => {
    const verdict = parseVerifierOutput("looks good to me");

    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.confidence).toBe(0);
    expect(verdict.objections[0]).toContain("parseable strict JSON");
  });

  it("fails closed on structurally incomplete verifier JSON", () => {
    const verdict = parseVerifierOutput(JSON.stringify({ verdict: "FAIL", confidence: 0.8, summary: "No tests." }));

    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.summary).toContain("shape invalid");
    expect(verdict.objections[0]).toContain("evidence must be an array");
  });
});

describe("parseSessionSummaryOutput", () => {
  it("accepts structured summary JSON", () => {
    const summary = parseSessionSummaryOutput(
      JSON.stringify({
        summary: "The agent edited Ledger.swift and ran tests.",
        files: ["Sources/LedgerLiteCore/Ledger.swift"],
        commands: ["swift test"],
        claims: ["tests pass"],
        openIssues: [],
        toolErrors: ["one failed edit"],
      }),
    );

    expect(summary.summary).toContain("edited Ledger.swift");
    expect(summary.files).toEqual(["Sources/LedgerLiteCore/Ledger.swift"]);
    expect(summary.commands).toEqual(["swift test"]);
    expect(summary.toolErrors).toEqual(["one failed edit"]);
  });

  it("records malformed summary output as structured evidence", () => {
    const summary = parseSessionSummaryOutput("plain text summary");

    expect(summary.summary).toContain("parseable strict JSON");
    expect(summary.openIssues[0]).toContain("parseable strict JSON");
    expect(summary.toolErrors[0]).toContain("plain text summary");
  });
});
