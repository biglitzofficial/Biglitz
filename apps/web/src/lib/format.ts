export const inr = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export const rupeesOf = (paise: number): number => Math.round(paise / 100);

const IST = "Asia/Kolkata";

export const timeIST = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: true }) : "—";

export const dateTimeIST = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });

export const todayIST = (): string => new Date().toLocaleDateString("en-CA", { timeZone: IST });
export const monthIST = (): string => todayIST().slice(0, 7);

export function prettyDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, day ?? 1)).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

export function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, 1)).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
}

export function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** IST wall-clock "YYYY-MM-DDTHH:mm" -> ISO instant. */
export const istLocalToIso = (local: string): string => new Date(`${local}:00+05:30`).toISOString();

export const waLink = (phone: string): string => `https://wa.me/91${phone.replace(/\D/g, "").slice(-10)}`;
