import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { collectEvidence, detectValidationCommands, serializeSessionLog } from "../extensions/goal/verifier.ts";

describe("detectValidationCommands", () => {
  it("discovers npm validation scripts from package.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          check: "npm run typecheck && npm test",
          typecheck: "tsc --noEmit",
        },
      }),
      "utf8",
    );

    await expect(detectValidationCommands(dir)).resolves.toEqual(["npm test", "npm run check", "npm run typecheck"]);
  });

  it("collects deterministic workspace evidence and validation output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "test"));
    await writeFile(join(dir, "README.md"), "Run npm test to validate.\n", "utf8");
    await writeFile(join(dir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(dir, "test", "index.test.ts"), "console.log('test file');\n", "utf8");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"console.log('validation-ok')\"",
        },
      }),
      "utf8",
    );

    const evidence = await collectEvidence(dir, undefined, {
      generatedAt: "2026-05-25T00:00:00.000Z",
      entryCount: 1,
      summary: "The agent claimed validation without proof.",
    });

    expect(evidence.readmeExcerpt.content).toContain("Run npm test");
    expect(evidence.sourceFiles.files).toEqual(["src/index.ts"]);
    expect(evidence.testFiles.files).toEqual(["test/index.test.ts"]);
    expect(evidence.validationResults[0]?.stdout).toContain("validation-ok");
    expect(evidence.sessionSummary?.summary).toContain("claimed validation");
  });

  it("serializes session entries for the summary model", () => {
    const log = serializeSessionLog([
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: "2026-05-25T00:00:00.000Z",
        message: {
          role: "assistant",
          provider: "ollama",
          model: "qwen",
          content: [{ type: "text", text: "I changed src/index.ts." }],
        },
      },
    ]);

    expect(log).toContain("role=assistant");
    expect(log).toContain("I changed src/index.ts");
  });
});
