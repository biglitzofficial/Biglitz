import { describe, expect, it } from "vitest";
import { applyBps, paiseToRupees, pctToBps, roundToRupee, rupeesToPaise } from "./money.js";

describe("money", () => {
  it("converts rupees and paise", () => {
    expect(rupeesToPaise(15000)).toBe(1_500_000);
    expect(paiseToRupees(1_500_000)).toBe(15000);
  });

  it("rounds half up and records the difference", () => {
    expect(roundToRupee(774_193.5 + 0)).toEqual({ paise: 774_200, diffPaise: 6.5 });
    expect(roundToRupee(150)).toEqual({ paise: 200, diffPaise: 50 });
    expect(roundToRupee(149)).toEqual({ paise: 100, diffPaise: -49 });
    expect(roundToRupee(1_500_000)).toEqual({ paise: 1_500_000, diffPaise: 0 });
  });

  it("applies basis points", () => {
    expect(pctToBps(1.5)).toBe(150);
    expect(applyBps(32_000_000, 150)).toBe(480_000);
  });
});
