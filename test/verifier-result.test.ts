import { describe, expect, it } from "vitest";
import { parseVerifierOutput } from "../extensions/goal/verifier.ts";

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
      }),
    );

    expect(verdict.verdict).toBe("PASS");
    expect(verdict.confidence).toBe(0.91);
    expect(verdict.evidence).toEqual(["npm test exit 0"]);
  });

  it("extracts fenced JSON", () => {
    const verdict = parseVerifierOutput(`Here is the result:

\`\`\`json
{"verdict":"FAIL","confidence":1.4,"summary":"No test evidence","evidence":[],"objections":["npm test was not run"],"nextInstructions":"Run npm test","steeringFeedback":"Run npm test before claiming completion."}
\`\`\``);

    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.confidence).toBe(1);
    expect(verdict.objections).toEqual(["npm test was not run"]);
    expect(verdict.steeringFeedback).toBe("Run npm test before claiming completion.");
  });

  it("fails closed on malformed output", () => {
    const verdict = parseVerifierOutput("looks good to me");

    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.confidence).toBe(0);
    expect(verdict.objections[0]).toContain("parseable strict JSON");
  });
});
