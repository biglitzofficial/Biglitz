import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { SEED_BUSINESS_UNITS, SEED_GLOBAL_SETTINGS } from "@biglitz/shared";
import bcrypt from "bcryptjs";
import { Timestamp } from "firebase-admin/firestore";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { createMemoryNotifier } from "../src/services/notifier.js";
import type { AppContext } from "../src/context.js";
import type { EmployeeDoc } from "../src/types.js";

export const PROJECT = "demo-biglitz";
/** Boys Mobiles test location. */
export const BM_LOC = { lat: 11.1085, lng: 77.3411 };
const M_PER_DEG_LAT = 111_195;
/** A GPS position `meters` north of BM (accuracy 20 m). */
export const gpsAt = (meters: number, loc = BM_LOC) => ({ lat: loc.lat + meters / M_PER_DEG_LAT, lng: loc.lng, accuracy: 20 });

/** IST wall-clock "YYYY-MM-DD HH:mm[:ss]" -> Date. */
export function ist(s: string): Date {
  const [d = "", t = "00:00:00"] = s.split(" ");
  const [y = 0, mo = 1, da = 1] = d.split("-").map(Number);
  const [h = 0, mi = 0, se = 0] = t.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h, mi, se) - 330 * 60_000);
}

export class FakeFiles {
  readonly present = new Set<string>();
  readonly saved = new Map<string, Uint8Array>();
  async uploadUrl(path: string): Promise<string> {
    return `https://upload.test/${path}`;
  }
  async exists(path: string): Promise<boolean> {
    return this.present.has(path) || this.saved.has(path);
  }
  async downloadUrl(path: string): Promise<string> {
    return `https://download.test/${path}`;
  }
  async save(path: string, data: Uint8Array): Promise<void> {
    this.saved.set(path, data);
  }
  /** Simulates the client finishing a signed-URL upload. */
  put(path: string): void {
    this.present.add(path);
  }
}

export interface Harness {
  ctx: AppContext;
  app: ReturnType<typeof buildApp>;
  files: FakeFiles;
  notifier: ReturnType<typeof createMemoryNotifier>;
  setNow(d: Date | string): void;
  now(): Date;
  reset(): Promise<void>;
  /** Calls the API. `as` = employeeId (fake token). Returns status + parsed json. */
  call(method: string, url: string, opts?: { as?: string | null; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; raw: string }>;
}

export function createHarness(): Harness {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  const db = getFirestore();
  let current = ist("2026-11-16 09:00:00");
  const files = new FakeFiles();
  const notifier = createMemoryNotifier();
  const ctx: AppContext = {
    env: loadEnv({ NODE_ENV: "test", INTAKE_SECRET: "s3cret" }),
    db,
    tokens: {
      mint: async (uid) => `tok:${uid}`,
      verify: async (t) => {
        if (!t.startsWith("tok:")) throw new Error("bad token");
        return t.slice(4);
      },
    },
    files,
    notifier,
    clock: () => current,
    bcryptCost: 4,
  };
  const app = buildApp(ctx);
  return {
    ctx,
    app,
    files,
    notifier,
    setNow: (d) => {
      current = typeof d === "string" ? ist(d) : d;
    },
    now: () => current,
    async reset() {
      const host = process.env["FIRESTORE_EMULATOR_HOST"] ?? "127.0.0.1:8081";
      await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
      files.present.clear();
      files.saved.clear();
      notifier.events.length = 0;
    },
    async call(method, url, opts = {}) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: { ...(opts.as ? { authorization: `Bearer tok:${opts.as}` } : {}), ...(opts.headers ?? {}) },
        ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
      });
      let body: unknown = null;
      try {
        body = res.json();
      } catch {
        body = null;
      }
      return { status: res.statusCode, body, raw: res.body };
    },
  };
}

/** Seeds the 5 units (BM gets a location) and settings, and a Super Admin SA001. */
export async function seedBasics(h: Harness): Promise<void> {
  const { db } = h.ctx;
  for (const u of SEED_BUSINESS_UNITS) {
    await db.collection("businessUnits").doc(u.code).set(u.code === "BM" ? { ...u, location: { ...BM_LOC, radiusMeters: 100 } } : u);
  }
  await db.collection("settings").doc("global").set(SEED_GLOBAL_SETTINGS);
  await addRawEmployee(h, { employeeId: "SA001", name: "Boobalan", mobile: "9000000001", roles: ["superAdmin"], businessId: "BM", adminBusinessIds: SEED_BUSINESS_UNITS.map((u) => u.code), canApprovePayrollFor: SEED_BUSINESS_UNITS.map((u) => u.code), pin: "7391", requiresSalesEntry: false });
}

/** Inserts an active employee directly (bypassing the API) - for fixtures only. */
export async function addRawEmployee(
  h: Harness,
  e: Partial<EmployeeDoc> & { employeeId: string; name: string; mobile: string; pin?: string; committedPaise?: number },
): Promise<void> {
  const { db } = h.ctx;
  const doc: EmployeeDoc = {
    photoPath: null,
    businessId: "BM",
    roles: ["staff"],
    designation: "",
    managerId: null,
    joiningDate: "2026-01-01",
    exitDate: null,
    status: "active",
    shift: { start: "09:30", end: "22:00" },
    requiresSalesEntry: true,
    adminBusinessIds: [],
    canApprovePayrollFor: [],
    createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    ...e,
  };
  const { pin, committedPaise, ...rest } = { ...doc, pin: e.pin, committedPaise: e.committedPaise } as EmployeeDoc & { pin?: string; committedPaise?: number };
  await db.collection("employees").doc(doc.employeeId).set(rest);
  await db.collection("employeePay").doc(doc.employeeId).set({ committedPaise: committedPaise ?? 1_500_000, bank: { accountHolder: doc.name, accountNumber: "123456789012", ifsc: "SBIN0001234" }, aadhaarLast4: "1234" });
  await db.collection("employeeTargets").doc(doc.employeeId).set({ targetPaise: 30_000_000, slabs: [{ fromAchievementPct: 0, rateBps: 0 }, { fromAchievementPct: 80, rateBps: 100 }, { fromAchievementPct: 100, rateBps: 150 }] });
  await db.collection("authPins").doc(doc.employeeId).set({ pinHash: await bcrypt.hash(pin ?? "4821", 4), failedAttempts: 0, lockedUntil: null, mustChangePin: false });
  await db.collection("mobileIndex").doc(doc.mobile).set({ employeeId: doc.employeeId });
}
