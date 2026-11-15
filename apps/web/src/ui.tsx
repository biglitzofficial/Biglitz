import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "./lib/api";

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");

export function Card({ children, className = "", onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const base = `rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 ${className}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`${base} block w-full text-left active:bg-slate-50`}>
      {children}
    </button>
  ) : (
    <div className={base}>{children}</div>
  );
}

export function Btn({
  children,
  onClick,
  type = "button",
  kind = "primary",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  kind?: "primary" | "ghost" | "danger" | "success";
  disabled?: boolean;
  className?: string;
}) {
  const colors = {
    primary: "bg-amber-500 text-slate-900 hover:bg-amber-400",
    ghost: "bg-slate-100 text-slate-800 hover:bg-slate-200",
    danger: "bg-red-600 text-white hover:bg-red-500",
    success: "bg-emerald-600 text-white hover:bg-emerald-500",
  }[kind];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl px-4 py-3 text-sm font-semibold transition disabled:opacity-50 ${colors} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-500";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} ${props.className ?? ""}`} rows={props.rows ?? 3} />;
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-200">{message}</div>;
}
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "ok" }) {
  const c = { info: "bg-sky-50 text-sky-800 ring-sky-200", warn: "bg-amber-50 text-amber-900 ring-amber-200", ok: "bg-emerald-50 text-emerald-800 ring-emerald-200" }[tone];
  return <div className={`rounded-xl p-3 text-sm ring-1 ${c}`}>{children}</div>;
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "red" | "amber" | "blue" }) {
  const c = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-900",
    blue: "bg-sky-100 text-sky-800",
  }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <p className="p-6 text-center text-sm text-slate-500">{label}</p>;
}

export function PageTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h1 className="text-lg font-bold text-slate-900">{children}</h1>
      {right}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-3 flex gap-1 overflow-x-auto rounded-xl bg-slate-200 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${value === t.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, onClick, tone }: { label: string; value: ReactNode; sub?: string; onClick?: () => void; tone?: "red" | "green" }) {
  const color = tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : "text-slate-900";
  return (
    <Card onClick={onClick}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </Card>
  );
}

/** Loads data on mount / when deps change; exposes reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const stable = useCallback(fn, deps);
  useEffect(() => {
    let live = true;
    setLoading(true);
    stable()
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e.message : errMsg(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [stable, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

/** Wraps a loaded screen body: spinner / error / content. */
export function Async<T>({ state, children }: { state: { data: T | null; error: string | null; loading: boolean }; children: (d: T) => ReactNode }) {
  if (state.error) return <ErrorBox message={state.error} />;
  if (state.loading && !state.data) return <Spinner />;
  if (!state.data) return null;
  return <>{children(state.data)}</>;
}

/** Runs an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errMsg(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-500" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
