import type { BusinessUnit, SalesCategory } from "./schemas/businessUnit.js";

type CategoryDef = readonly [name: string, type: "amount" | "count"];

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

function categories(defs: readonly CategoryDef[]): SalesCategory[] {
  return defs.map(([name, type], order) => ({ id: slug(name), name, type, active: true, order }));
}

const FITO6_CATEGORIES: readonly CategoryDef[] = [
  ["New membership", "amount"],
  ["New PT", "amount"],
  ["Membership renewal", "amount"],
  ["PT renewal", "amount"],
  ["Diet plan", "amount"],
  ["InBody tests", "count"],
  ["Ice bath", "count"],
  ["Steam", "count"],
];

const UNIT_DEFS: ReadonlyArray<{ code: string; name: string; categories: readonly CategoryDef[] }> = [
  {
    code: "BM",
    name: "Boys Mobiles Head Office",
    categories: [
      ["New mobiles", "amount"],
      ["Second-hand mobiles", "amount"],
      ["Accessories", "amount"],
      ["Service", "amount"],
    ],
  },
  { code: "F6G1", name: "FITO6 Fitness Studio 1", categories: FITO6_CATEGORIES },
  { code: "F6G2", name: "FITO6 Fitness Studio 2", categories: FITO6_CATEGORIES },
  {
    code: "GZ",
    name: "Gyroz Studio",
    categories: [
      ["Shoots", "amount"],
      ["Editing", "amount"],
      ["Podcast shoots", "amount"],
    ],
  },
  {
    code: "FB",
    name: "FitoBowl",
    categories: [
      ["Confirmed food orders", "amount"],
      ["Subscriptions", "amount"],
    ],
  },
];

/**
 * Seed data for the first five units. `location` is null until Boobalan supplies the
 * coordinates; punch-in is blocked for a unit with no location. The default shift
 * 09:30-22:00 is the example given in the spec and is editable per unit.
 */
export const SEED_BUSINESS_UNITS: BusinessUnit[] = UNIT_DEFS.map((u) => ({
  name: u.name,
  code: u.code,
  active: true,
  location: null,
  defaultShift: { start: "09:30", end: "22:00" },
  salesCategories: categories(u.categories),
  holidays: [],
  idCounter: 0,
  admins: [],
}));

export const SEED_GLOBAL_SETTINGS = {
  timezone: "Asia/Kolkata",
  gpsAccuracyLimitMeters: 100,
  lateAlertMinutesAfterShiftStart: 15,
  monthlyRewardsPaise: [500_000, 300_000, 100_000],
  leaveFreeDaysPerMonth: 2,
  lostReasons: ["Price too high", "Bought elsewhere", "Not reachable", "Just enquiring", "Other"],
} as const;
