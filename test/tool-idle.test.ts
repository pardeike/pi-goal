import { describe, expect, it } from "vitest";
import { buildMainToolIdleProgressSignature, createActiveMainToolExecution, describeObservedTool, findTimedOutMainTool, msUntilNextMainToolTimeout, touchActiveMainToolExecution } from "../extensions/goal/tool-idle.ts";

describe("main tool idle tracking", () => {
  it("describes bash commands and times out the stalest tool first", () => {
    const config = { enabled: true, timeoutMs: 5_000 };
    const older = createActiveMainToolExecution("call-1", "bash", { command: "tail -n 30 /tmp/app.log" }, 1_000);
    const newer = createActiveMainToolExecution("call-2", "read", { path: "/tmp/file.txt" }, 4_000);
    const trip = findTimedOutMainTool([older, newer], config, 9_500);

    expect(describeObservedTool("bash", { command: "npm test" })).toBe("bash npm test");
    expect(trip?.tool.toolCallId).toBe("call-1");
    expect(trip?.idleMs).toBe(8_500);
  });

  it("re-arms based on the latest tool activity and produces stable signatures", () => {
    const config = { enabled: true, timeoutMs: 10_000 };
    const started = createActiveMainToolExecution("call-1", "bash", { command: "docker logs --tail=50 sync-gateway-proxy" }, 1_000);
    const touched = touchActiveMainToolExecution(started, 7_000);

    expect(msUntilNextMainToolTimeout([touched], config, 9_500)).toBe(7_500);
    expect(buildMainToolIdleProgressSignature(touched)).toContain("docker logs --tail=50 sync-gateway-proxy");
  });
});
