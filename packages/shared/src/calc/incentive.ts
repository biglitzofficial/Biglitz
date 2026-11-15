import { z } from "zod";
import { applyBps, roundToRupee } from "./money.js";

export const slabSchema = z.object({
  /** Achievement % at which this slab starts (e.g. 80). */
  fromAchievementPct: z.number().min(0),
  /** Rate on whole-month sales in basis points (150 = 1.5%). */
  rateBps: z.number().int().min(0).max(10_000),
});
export type Slab = z.infer<typeof slabSchema>;

/** Spec 8.6 default slabs: <80% 0, 80-99.99% 1%, >=100% 1.5%. */
export const DEFAULT_SLABS: readonly Slab[] = [
  { fromAchievementPct: 0, rateBps: 0 },
  { fromAchievementPct: 80, rateBps: 100 },
  { fromAchievementPct: 100, rateBps: 150 },
];

/** Highest slab whose threshold <= achievement. */
export function slabFor(achievementPct: number, slabs: readonly Slab[]): Slab {
  let best: Slab = { fromAchievementPct: 0, rateBps: 0 };
  let bestFrom = -1;
  for (const s of slabs) {
    if (s.fromAchievementPct <= achievementPct && s.fromAchievementPct > bestFrom) {
      best = s;
      bestFrom = s.fromAchievementPct;
    }
  }
  return best;
}

export interface IncentiveResult {
  achievementPct: number;
  rateBps: number;
  /** Rounded to the rupee, half up. */
  incentivePaise: number;
  roundingDiffPaise: number;
}

/** Spec 8.6: the slab applies to the WHOLE month's amount sales. No target => 0. */
export function computeIncentive(args: {
  monthlySalesPaise: number;
  targetPaise: number | null;
  slabs: readonly Slab[];
}): IncentiveResult {
  const { monthlySalesPaise, targetPaise, slabs } = args;
  if (!targetPaise || targetPaise <= 0) {
    return { achievementPct: 0, rateBps: 0, incentivePaise: 0, roundingDiffPaise: 0 };
  }
  const achievementPct = (monthlySalesPaise / targetPaise) * 100;
  const { rateBps } = slabFor(achievementPct, slabs);
  const { paise, diffPaise } = roundToRupee(applyBps(monthlySalesPaise, rateBps));
  return { achievementPct, rateBps, incentivePaise: paise, roundingDiffPaise: diffPaise };
}
