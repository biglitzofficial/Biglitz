import bcrypt from "bcryptjs";
import { Timestamp } from "firebase-admin/firestore";
import { DEFAULT_SLABS, SEED_BUSINESS_UNITS, SEED_GLOBAL_SETTINGS, businessUnitSchema, dateIST, mobileSchema, pinSchema } from "@biglitz/shared";
import { db } from "../firebase.js";
import type { EmployeeDoc } from "../types.js";

/**
 * Idempotent seed: creates each unit only if missing (never resets idCounter or overwrites edits),
 * creates settings/global if missing, and - if SUPERADMIN_MOBILE and SUPERADMIN_PIN are set - the Super Admin
 * (Boobalan) with must-change-PIN on first login.
 */
async function main(): Promise<void> {
  const firestore = db();
  for (const unit of SEED_BUSINESS_UNITS) {
    const data = businessUnitSchema.parse(unit);
    const ref = firestore.collection("businessUnits").doc(data.code);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return console.log(`= ${data.code} already exists, left unchanged`);
      tx.set(ref, data);
      console.log(`+ ${data.code} created`);
    });
  }
  const settingsRef = firestore.collection("settings").doc("global");
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(settingsRef);
    if (snap.exists) return console.log("= settings/global already exists");
    tx.set(settingsRef, SEED_GLOBAL_SETTINGS);
    console.log("+ settings/global created");
  });

  const mobile = process.env["SUPERADMIN_MOBILE"];
  const pin = process.env["SUPERADMIN_PIN"];
  if (mobile && pin) {
    mobileSchema.parse(mobile);
    pinSchema.parse(pin);
    const id = "SA001";
    const empRef = firestore.collection("employees").doc(id);
    if ((await empRef.get()).exists) return console.log("= Super Admin already exists");
    const now = new Date();
    const emp: EmployeeDoc = {
      employeeId: id,
      name: process.env["SUPERADMIN_NAME"] ?? "Boobalan",
      mobile,
      photoPath: null,
      businessId: "BM",
      roles: ["superAdmin"],
      designation: "Super Admin",
      managerId: null,
      joiningDate: dateIST(now),
      exitDate: null,
      status: "active",
      shift: { start: "09:30", end: "22:00" },
      requiresSalesEntry: false,
      adminBusinessIds: SEED_BUSINESS_UNITS.map((u) => u.code),
      canApprovePayrollFor: SEED_BUSINESS_UNITS.map((u) => u.code),
      createdAt: Timestamp.fromDate(now),
    };
    const batch = firestore.batch();
    batch.set(empRef, emp);
    batch.set(firestore.collection("employeePay").doc(id), { committedPaise: 0, bank: null, aadhaarLast4: null });
    batch.set(firestore.collection("employeeTargets").doc(id), { targetPaise: null, slabs: [...DEFAULT_SLABS] });
    batch.set(firestore.collection("authPins").doc(id), { pinHash: await bcrypt.hash(pin, 10), failedAttempts: 0, lockedUntil: null, mustChangePin: true });
    batch.set(firestore.collection("mobileIndex").doc(mobile), { employeeId: id });
    await batch.commit();
    console.log("+ Super Admin SA001 created (must change PIN on first login)");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
