/**
 * `hooks.maxConcurrent` only buys throughput across DISTINCT resolved session
 * keys: `/hooks/agent` serializes per canonical queue key ahead of lane
 * admission (`createSessionKeyedHookDispatchQueue`, `hooks.ts`), so runs that
 * canonicalize together can never run in parallel no matter how wide the lane.
 *
 * That makes the canonicalization a load-bearing part of the feature rather
 * than an implementation detail: if it ever started collapsing distinct request
 * keys onto one queue key, the width setting would silently stop delivering
 * concurrency while every lane-level test stayed green.
 *
 * This does NOT prove end-to-end throughput — see the note in the PR. The
 * gateway test harness mocks `runCronIsolatedAgentTurn`, which is the function
 * that carries the lane into execution, so no in-repo test can observe real
 * concurrent hook turns. This guards the one precondition that IS observable.
 */
import { describe, expect, it } from "vitest";
import { resolveCronAgentSessionKey } from "../cron/isolated-agent/session-key.js";

const AGENT = "main";

describe("hook dispatch queue-key distinctness", () => {
  it("keeps distinct request session keys distinct", () => {
    const keys = ["hook:a", "hook:b", "pickup:gh-1", "pickup:gh-2", "review:gh-3"];
    const resolved = keys.map((sessionKey) =>
      resolveCronAgentSessionKey({ sessionKey, agentId: AGENT }),
    );
    expect(new Set(resolved).size).toBe(keys.length);
  });

  it("collapses one shared key onto one queue key", () => {
    // Positive control for the assertion above: prove the resolver CAN produce
    // a collision, so the distinctness test is not passing vacuously.
    const resolved = [0, 1, 2].map(() =>
      resolveCronAgentSessionKey({ sessionKey: "hook:shared", agentId: AGENT }),
    );
    expect(new Set(resolved).size).toBe(1);
  });
});
