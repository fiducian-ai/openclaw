// Resolves hook-dispatch runtime limits from config.
import type { OpenClawConfig } from "./types.js";

/**
 * Default width of the hook-dispatch lane.
 *
 * One-wide by default: the capacity group's guarantee is that a hook can always
 * START under cron saturation. Running several hook agents at once is a
 * deployment choice with a real cost — the reservation is non-borrowable, so
 * every slot a hook holds in reserve is a slot cron inner work can never use,
 * idle or not. Deployments that do not ask for it keep today's behaviour.
 */
export const DEFAULT_HOOK_DISPATCH_MAX_CONCURRENT = 1;

/**
 * Resolves hook-dispatch concurrency, flooring finite values and clamping to at
 * least one. A zero or negative width would make the lane undispatchable while
 * still holding a group membership, which is strictly worse than not installing
 * the group at all — `hooks.enabled: false` is the supported way to opt out.
 */
export function resolveHookDispatchMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.hooks?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_HOOK_DISPATCH_MAX_CONCURRENT;
}
