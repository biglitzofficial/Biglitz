import type { Role } from "@biglitz/shared";
import type { EmployeeDoc } from "./types.js";
import { forbidden } from "./http.js";

/** The authenticated person, re-read from Firestore on every call (claims are only a convenience). */
export interface Actor {
  id: string;
  emp: EmployeeDoc;
}

const has = (a: Actor, role: Role): boolean => a.emp.roles.includes(role);

export const isSuperAdmin = (a: Actor): boolean => has(a, "superAdmin");
export const isAdminOf = (a: Actor, unit: string): boolean =>
  isSuperAdmin(a) || (has(a, "admin") && a.emp.adminBusinessIds.includes(unit));
export const isAnyAdmin = (a: Actor): boolean => isSuperAdmin(a) || has(a, "admin");
export const isManager = (a: Actor): boolean => has(a, "manager");

/** Can this actor see/manage (non-money) data of `target` per the role hierarchy. */
export function canManage(a: Actor, target: EmployeeDoc): boolean {
  if (isSuperAdmin(a)) return true;
  if (isAdminOf(a, target.businessId)) return true;
  if (isManager(a) && target.managerId === a.id) return true;
  return false;
}

export const canView = (a: Actor, target: EmployeeDoc): boolean => a.id === target.employeeId || canManage(a, target);

/** Salary, bank, documents: Super Admin, Admin of the unit, or the person themself (Managers never). */
export const canViewPay = (a: Actor, target: EmployeeDoc): boolean =>
  a.id === target.employeeId || isAdminOf(a, target.businessId);

export function requireAdminOf(a: Actor, unit: string): void {
  if (!isAdminOf(a, unit)) throw forbidden("Only an Admin of this business unit can do that.");
}

export function requireManage(a: Actor, target: EmployeeDoc): void {
  if (!canManage(a, target)) throw forbidden("That employee is outside your scope.");
}

export function requireSuperAdmin(a: Actor): void {
  if (!isSuperAdmin(a)) throw forbidden("Only the Super Admin can do that.");
}

/** Approve payroll: Super Admin, or Admin with `canApprovePayroll` for that unit. */
export function canApprovePayroll(a: Actor, unit: string): boolean {
  return isSuperAdmin(a) || (isAdminOf(a, unit) && a.emp.canApprovePayrollFor.includes(unit));
}

/** Business units an actor administers; null = all (Super Admin). */
export function adminUnits(a: Actor): string[] | null {
  if (isSuperAdmin(a)) return null;
  return has(a, "admin") ? a.emp.adminBusinessIds : [];
}
