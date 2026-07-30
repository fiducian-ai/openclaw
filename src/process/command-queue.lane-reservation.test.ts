// Regression coverage for reserved capacity inside a shared command-lane pool.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../test-utils/deferred.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
  setCommandLanePool,
} from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { CommandLane } from "./lanes.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const HOOK_LANE = "hook:dispatch";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function activeCount(lane: string): number {
  return getCommandLaneSnapshot(lane).activeCount;
}

describe("command lane pool reservations", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
  });

  it("starts a reserved lane task while the shared pool is saturated", async () => {
    setCommandLaneConcurrency(CommandLane.CronNested, 2);
    setCommandLaneConcurrency(HOOK_LANE, 1);
    setCommandLanePool("isolated-agent", {
      budget: 2,
      lanes: [CommandLane.CronNested, HOOK_LANE],
      reservations: { [HOOK_LANE]: 1 },
    });

    const cronGate = createDeferred();
    const hookGate = createDeferred();
    const started: string[] = [];

    void enqueueCommandInLane(CommandLane.CronNested, async () => {
      started.push("cron-1");
      await cronGate.promise;
    });
    void enqueueCommandInLane(CommandLane.CronNested, async () => {
      started.push("cron-2");
      await cronGate.promise;
    });
    await flushMicrotasks();

    // Budget 2 with one slot reserved for the hook lane leaves exactly one
    // general slot, so the second cron task must stay queued.
    expect(activeCount(CommandLane.CronNested)).toBe(1);

    void enqueueCommandInLane(HOOK_LANE, async () => {
      started.push("hook");
      await hookGate.promise;
    });
    await flushMicrotasks();

    // The reserved slot is available immediately even though cron is saturated.
    expect(started).toContain("hook");
    expect(activeCount(HOOK_LANE)).toBe(1);
    // Total concurrency never exceeds the pool budget.
    expect(activeCount(CommandLane.CronNested) + activeCount(HOOK_LANE)).toBe(2);

    cronGate.resolve();
    hookGate.resolve();
    await flushMicrotasks();
  });

  it("wakes a queued sibling lane when pool capacity frees up", async () => {
    setCommandLaneConcurrency("pool:a", 1);
    setCommandLaneConcurrency("pool:b", 1);
    setCommandLanePool("shared", { budget: 1, lanes: ["pool:a", "pool:b"] });

    const firstGate = createDeferred();
    const started: string[] = [];

    void enqueueCommandInLane("pool:a", async () => {
      started.push("a");
      await firstGate.promise;
    });
    await flushMicrotasks();

    void enqueueCommandInLane("pool:b", async () => {
      started.push("b");
    });
    await flushMicrotasks();

    // The single pool slot is taken, so the sibling lane must wait.
    expect(started).toEqual(["a"]);

    firstGate.resolve();
    await flushMicrotasks();

    // Nothing else enqueues on pool:b, so only the pool release can start it.
    expect(started).toEqual(["a", "b"]);
  });

  it("holds the reserved slot even while the reserved lane is idle", async () => {
    setCommandLaneConcurrency(CommandLane.CronNested, 4);
    setCommandLaneConcurrency(HOOK_LANE, 1);
    setCommandLanePool("isolated-agent", {
      budget: 3,
      lanes: [CommandLane.CronNested, HOOK_LANE],
      reservations: { [HOOK_LANE]: 1 },
    });

    const cronGate = createDeferred();
    for (let i = 0; i < 4; i++) {
      void enqueueCommandInLane(CommandLane.CronNested, async () => {
        await cronGate.promise;
      });
    }
    await flushMicrotasks();

    // Budget 3 minus the reserved hook slot leaves 2 general slots, and the
    // reservation is held back rather than lent out while the hook lane is idle.
    expect(activeCount(CommandLane.CronNested)).toBe(2);
    expect(activeCount(HOOK_LANE)).toBe(0);

    cronGate.resolve();
    await flushMicrotasks();
  });

  it("leaves lanes outside any pool unconstrained", async () => {
    setCommandLaneConcurrency(CommandLane.Main, 3);
    setCommandLanePool("isolated-agent", {
      budget: 1,
      lanes: [CommandLane.CronNested],
      reservations: {},
    });

    const gate = createDeferred();
    for (let i = 0; i < 3; i++) {
      void enqueueCommandInLane(CommandLane.Main, async () => {
        await gate.promise;
      });
    }
    await flushMicrotasks();

    expect(activeCount(CommandLane.Main)).toBe(3);

    gate.resolve();
    await flushMicrotasks();
  });
});
