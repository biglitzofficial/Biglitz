import { useState } from "react";
import { get, post } from "../lib/api";
import { inr } from "../lib/format";
import type { SalesCategory } from "../lib/types";
import { Async, Btn, Card, ErrorBox, Field, Input, Notice, PageTitle, useAction, useLoad } from "../ui";

interface TodaySales {
  dateIST: string;
  categories: SalesCategory[];
  required: boolean;
  entry: { values: Record<string, number>; amountTotalPaise: number; noSales: boolean } | null;
}

/** Display a stored value: paise for amount categories, plain count otherwise. */
export const showValue = (c: Pick<SalesCategory, "type">, v: number): string => (c.type === "amount" ? inr(v) : String(v));

export function SalesForm({ data, onSaved }: { data: TodaySales; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.categories.map((c) => [c.id, data.entry ? String(c.type === "amount" ? Math.round((data.entry.values[c.id] ?? 0) / 100) : (data.entry.values[c.id] ?? 0)) : ""])),
  );
  const { busy, error, run } = useAction();

  const save = (noSales: boolean) =>
    run(async () => {
      const values = noSales ? {} : Object.fromEntries(data.categories.map((c) => [c.id, Number(vals[c.id] || 0)]));
      await post("/api/sales/today", { values, noSales });
      onSaved();
    });

  return (
    <div className="space-y-3">
      {data.categories.map((c) => (
        <Field key={c.id} label={c.type === "amount" ? `${c.name} (₹)` : `${c.name} (count)`}>
          <Input inputMode="numeric" value={vals[c.id] ?? ""} onChange={(e) => setVals({ ...vals, [c.id]: e.target.value.replace(/\D/g, "") })} placeholder="0" />
        </Field>
      ))}
      <ErrorBox message={error} />
      <div className="flex gap-2">
        <Btn disabled={busy} onClick={() => void save(false)} className="flex-1">
          Save sales
        </Btn>
        <Btn kind="ghost" disabled={busy} onClick={() => void save(true)}>
          No sales today
        </Btn>
      </div>
    </div>
  );
}

export function SalesToday() {
  const s = useLoad(() => get<TodaySales>("/api/sales/today"), []);
  return (
    <div>
      <PageTitle>Today's sales</PageTitle>
      <Async state={s}>
        {(d) =>
          d.categories.length === 0 ? (
            <Notice>Your business unit has no sales categories.</Notice>
          ) : (
            <div className="space-y-3">
              {d.entry && (
                <Card>
                  <div className="text-xs text-slate-500">Submitted today</div>
                  {d.categories.map((c) => (
                    <div key={c.id} className="flex justify-between text-sm">
                      <span>{c.name}</span>
                      <span className="font-semibold">{showValue(c, d.entry?.values[c.id] ?? 0)}</span>
                    </div>
                  ))}
                </Card>
              )}
              <Card>
                <SalesForm data={d} onSaved={s.reload} />
              </Card>
              <p className="text-xs text-slate-500">You can edit today's entry until midnight. After that, ask your Manager.</p>
            </div>
          )
        }
      </Async>
    </div>
  );
}
