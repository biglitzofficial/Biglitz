/** `YY + businessCode + NNN` (spec 7.1). NNN is zero-padded to 3 digits, 4+ once past 999. */
export function formatEmployeeId(joiningDate: string, businessCode: string, counter: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) throw new Error("Invalid joining date");
  if (!Number.isInteger(counter) || counter < 1) throw new Error("Counter must be a positive integer");
  return `${joiningDate.slice(2, 4)}${businessCode}${String(counter).padStart(3, "0")}`;
}

/** Spec 5.3: exactly 4 digits; reject 0000, 1234 and the last 4 digits of the mobile number. */
export function validatePin(pin: string, mobile: string): { ok: true } | { ok: false; message: string } {
  if (!/^\d{4}$/.test(pin)) return { ok: false, message: "PIN must be exactly 4 digits." };
  if (pin === "0000" || pin === "1234") return { ok: false, message: "That PIN is too easy to guess. Choose another." };
  if (pin === mobile.slice(-4)) return { ok: false, message: "PIN cannot be the last 4 digits of your mobile number." };
  return { ok: true };
}

/** Indian mobile: 10 digits starting 6-9. */
export const MOBILE_REGEX = /^[6-9]\d{9}$/;

/** Normalise any Indian phone input to `+91XXXXXXXXXX`, or null if invalid. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return MOBILE_REGEX.test(ten) ? `+91${ten}` : null;
}
