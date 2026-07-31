/**
 * `hooks.maxConcurrent` sets the width of the hook-dispatch lane.
 *
 * The capacity group guarantees a hook can always START under cron saturation.
 * That is a latency guarantee, not a throughput one: at the default width of
 * one, hook agent runs still serialize against each other, so a deployment
 * driving autonomous work through `/hooks/agent` gets no parallelism from the
 * group alone. This knob buys that parallelism WITHOUT raising the aggregate
 * cap — it moves slots across the partition rather than adding them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

function hooksConfig(maxConcurrent?: number): OpenClawConfig {
  return {
    hooks: { enabled: true, token: "t", ...(maxConcurrent === undefined ? {} : { maxConcurrent }) },
  } as unknown as OpenClawConfig;
}

function publish(config: OpenClawConfig): void {
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("hooks.maxConcurrent", () => {
  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    const { resetSessionSuspensionStateForTest } =
      await import("../agents/session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
  });

  it("defaults to one-wide, preserving pre-knob behaviour exactly", () => {
    expect(resolveGatewayLaneConcurrency(hooksConfig()).hookDispatch).toBe(1);
  });

  it("stays zero when hooks are disabled, whatever the width says", () => {
    const cfg = { hooks: { enabled: false, maxConcurrent: 4 } } as unknown as OpenClawConfig;
    expect(resolveGatewayLaneConcurrency(cfg).hookDispatch).toBe(0);
  });

  it("honours a configured width", () => {
    expect(resolveGatewayLaneConcurrency(hooksConfig(4)).hookDispatch).toBe(4);
  });

  it("clamps a width that would starve cron, instead of failing publication", () => {
    // `installCommandLaneGroup` THROWS when reservations exceed the budget, and
    // that throw would abort publication of the whole lane configuration. A
    // mis-set hook width must not be able to take the cron lanes down with it.
    expect(resolveGatewayLaneConcurrency(hooksConfig(99)).hookDispatch).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    );
    // Exactly the budget is still clamped: cron keeps a slot for the same
    // reason hooks are guaranteed one.
    expect(
      resolveGatewayLaneConcurrency(hooksConfig(DEFAULT_CRON_MAX_CONCURRENT_RUNS)).hookDispatch,
    ).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
  });

  it("clamps a non-positive width up to one rather than wedging the lane", () => {
    // Zero is rejected by the schema, but a zero-width lane inside a group
    // would be undispatchable while still holding membership — strictly worse
    // than not installing the group. Defend in the resolver too.
    expect(resolveGatewayLaneConcurrency(hooksConfig(0)).hookDispatch).toBe(1);
    expect(resolveGatewayLaneConcurrency(hooksConfig(-3)).hookDispatch).toBe(1);
  });

  it("runs hooks concurrently up to the width without raising the aggregate cap", async () => {
    const width = 4;
    publish(hooksConfig(width));

    // Saturate the hook lane past its width.
    const hookGates = Array.from({ length: width + 1 }, () => gate());
    const hookRuns = hookGates.map((g) =>
      enqueueCommandInLane(CommandLane.HookDispatch, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    // The point of the knob: hooks no longer serialize.
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).activeCount).toBe(width);
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).queuedCount).toBe(1);

    // Cron gets the rest of the budget and no more — the reservation is
    // non-borrowable, so the hook slots are gone whether or not hooks use them.
    const cronGates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
    const cronRuns = cronGates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - width,
    );

    // The invariant the whole design rests on: partitioned, never added.
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).groupActive).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );

    for (const g of [...hookGates, ...cronGates]) {
      g.release();
    }
    await Promise.all([...hookRuns, ...cronRuns]);
  });

  it("withholds the full reserved width from cron even while hooks are idle", async () => {
    const width = 3;
    publish(hooksConfig(width));

    const cronGates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
    const cronRuns = cronGates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    // This is the cost of the knob, stated as a test so nobody can raise the
    // width believing it is free.
    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - width,
    );
    expect(getCommandLaneSnapshot(CommandLane.CronNested).blockedBy).toBe("sibling-reservation");

    for (const g of cronGates) {
      g.release();
    }
    await Promise.all(cronRuns);
  });
});
