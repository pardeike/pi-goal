import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateGoalHttpIdleTimeout } from "../extensions/goal/http-idle.ts";

describe("goal HTTP idle timeout override", () => {
  it("activates Pi's dispatcher override and restores the previous setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-goal-http-"));
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 120000 }), "utf8");

    const override = await activateGoalHttpIdleTimeout({ enabled: true, timeoutMs: 0 }, dir, {
      PI_CODING_AGENT_DIR: agentDir,
    });

    expect(override.enabled).toBe(true);
    expect(override.appliedTimeoutMs).toBe(0);
    expect(override.previousTimeoutMs).toBe(120000);
    expect(() => override.restore()).not.toThrow();
  });

  it("leaves the dispatcher alone when disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-goal-http-"));
    const override = await activateGoalHttpIdleTimeout({ enabled: false, timeoutMs: 0 }, dir, {
      PI_CODING_AGENT_DIR: join(dir, "missing-agent"),
    });

    expect(override.enabled).toBe(false);
    expect(override.appliedTimeoutMs).toBe(300000);
    expect(override.previousTimeoutMs).toBe(300000);
  });
});
