/** All money is integer paise. Percentages are basis points (1.5% = 150 bps). */

export const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

export interface RoundedRupee {
  /** Paise, a whole multiple of 100. */
  paise: number;
  /** rounded - original, in paise. Stored on the payslip line. */
  diffPaise: number;
}

/** Round to the nearest rupee, half up. Only call this at the final step. */
export function roundToRupee(paise: number): RoundedRupee {
  const rupees = Math.floor(paise / PAISE_PER_RUPEE + 0.5);
  const rounded = rupees * PAISE_PER_RUPEE;
  return { paise: rounded, diffPaise: rounded - paise };
}

/** paise * bps / 10000 without rounding (round only at the final step). */
export function applyBps(paise: number, bps: number): number {
  return (paise * bps) / 10_000;
}

export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}

export function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: paise % PAISE_PER_RUPEE === 0 ? 0 : 2,
  }).format(paiseToRupees(paise));
}
