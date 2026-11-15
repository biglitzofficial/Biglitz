import { useState } from "react";
import { ApiError, download, get, post } from "../lib/api";
import { inr, monthIST, monthLabel, shiftMonth } from "../lib/format";
import type { BusinessUnit, PartStatus, PayrollLine, PayrollRun } from "../lib/types";
import { go, useRoute } from "../router";
import { showValue } from "./Sales";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Modal, Notice, PageTitle, Select, Stat, Textarea, useAction, useLoad } from "../ui";

const PART_TONE: Record<PartStatus, "slate" | "amber" | "blue" | "green"> = { draft: "slate", submitted: "amber", approved: "blue", paid: "green" };

interface RunData {
  run: PayrollRun;
  lines: PayrollLine[];
  canApprove: boolean;
}

function AdjustModal({ unit, month, lines, onClose, onSaved }: { unit: string; month: string; lines: PayrollLine[]; onClose: () => void; onSaved: () => void }) {
  const [emp, setEmp] = useState(lines[0]?.employeeId ?? "");
  const [amount, setAmount] = useState("");
  const [sign, setSign] = useState("+");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Modal title="Add adjustment" onClose={onClose}>
      <Field label="Employee">
        <Select value={emp} onChange={(e) => setEmp(e.target.value)}>
          {lines.map((l) => (
            <option key={l.employeeId} value={l.employeeId}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-2">
        <Select value={sign} onChange={(e) => setSign(e.target.value)} className="!w-24">
          <option value="+">+ Add</option>
          <option value="-">− Deduct</option>
        </Select>
        <Input inputMode="numeric" placeholder="Amount ₹" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
      </div>
      <Field label="Reason (required)">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Btn
        disabled={busy || !amount || !reason.trim()}
        onClick={() =>
          void run(async () => {
            await post(`/api/payroll/${unit}/${month}/adjustments`, { employeeId: emp, amountRupees: (sign === "-" ? -1 : 1) * Number(amount), reason });
            onSaved();
            onClose();
          })
        }
        className="w-full"
      >
        Save
      </Btn>
    </Modal>
  );
}

function PartPanel({ part, data, unit, month, onChanged }: { part: "salary" | "incentive"; data: RunData; unit: string; month: string; onChanged: () => void }) {
  const status = part === "salary" ? data.run.salaryStatus : data.run.incentiveStatus;
  const { busy, error, run } = useAction();
  const act = (what: "submit" | "approve" | "reopen" | "paid") =>
    run(async () => {
      await post(`/api/payroll/${unit}/${month}/${what}`, { part });
      onChanged();
    });
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{part === "salary" ? "Salary" : "Incentive"}</h2>
        <Badge tone={PART_TONE[status]}>{status}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        {status === "draft" && (
          <Btn kind="ghost" disabled={busy} onClick={() => void act("submit")} className="!px-3 !py-2">
            Submit for approval
          </Btn>
        )}
        {status === "submitted" && data.canApprove && (
          <>
            <Btn kind="success" disabled={busy} onClick={() => void act("approve")} className="!px-3 !py-2">
              Approve & lock
            </Btn>
            <Btn kind="ghost" disabled={busy} onClick={() => void act("reopen")} className="!px-3 !py-2">
              Send back
            </Btn>
          </>
        )}
        {status === "submitted" && !data.canApprove && <span className="text-sm text-slate-500">Waiting for approval by the Super Admin.</span>}
        {(status === "approved" || status === "paid") && (
          <Btn kind="ghost" disabled={busy} onClick={() => void run(() => download(`/api/payroll/${unit}/${month}/transfer.csv?part=${part}`, `${unit}_${month}_${part}.csv`))} className="!px-3 !py-2">
            Download bank CSV
          </Btn>
        )}
        {status === "approved" && (
          <Btn kind="success" disabled={busy} onClick={() => void act("paid")} className="!px-3 !py-2">
            Mark as paid
          </Btn>
        )}
        {status === "approved" && data.canApprove && (
          <Btn kind="ghost" disabled={busy} onClick={() => void act("reopen")} className="!px-3 !py-2">
            Reopen
          </Btn>
        )}
      </div>
      <ErrorBox message={error} />
    </Card>
  );
}

export function Payroll() {
  const { query } = useRoute();
  const units = useLoad(() => get<{ units: BusinessUnit[] }>("/api/units"), []);
  const [unit, setUnit] = useState(query.get("unit") ?? "");
  const [month, setMonth] = useState(query.get("month") ?? shiftMonth(monthIST(), -1));
  const [adjusting, setAdjusting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const activeUnit = unit || units.data?.units[0]?.code || "";
  const data = useLoad(
    async () => {
      if (!activeUnit) return null;
      try {
        return await get<RunData>(`/api/payroll/${activeUnit}/${month}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { missing: true } as const;
        throw e;
      }
    },
    [activeUnit, month],
  );
  const { busy, error, run } = useAction();

  return (
    <div className="space-y-3">
      <PageTitle>Payroll</PageTitle>
      <div className="flex gap-2">
        <Select value={activeUnit} onChange={(e) => setUnit(e.target.value)}>
          {units.data?.units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </Select>
        <Btn kind="ghost" onClick={() => setMonth(shiftMonth(month, -1))} className="!px-3">
          ‹
        </Btn>
        <div className="flex items-center whitespace-nowrap text-sm font-semibold">{monthLabel(month)}</div>
        <Btn kind="ghost" disabled={month >= shiftMonth(monthIST(), -1)} onClick={() => setMonth(shiftMonth(month, 1))} className="!px-3">
          ›
        </Btn>
      </div>
      <ErrorBox message={error} />
      <Async state={data}>
        {(d) => {
          if (!d) return null;
          if ("missing" in d) {
            return (
              <Card>
                <p className="mb-3 text-sm text-slate-600">No payroll draft for {monthLabel(month)} yet. It is created automatically on the 1st; you can also create it now.</p>
                <Btn
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await post(`/api/payroll/${activeUnit}/${month}/draft`);
                      data.reload();
                    })
                  }
                  className="w-full"
                >
                  Create draft
                </Btn>
              </Card>
            );
          }
          const reload = data.reload;
          const locked = d.run.locked;
          return (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Employees" value={d.run.totals.employees} />
                <Stat label="Net salary" value={inr(d.run.totals.salaryNetPaise)} />
                <Stat label="Incentive" value={inr(d.run.totals.incentivePaise)} />
              </div>
              {locked && <Notice tone="ok">This month is locked (approved). Attendance, leave and sales for it can no longer change.</Notice>}
              <PartPanel part="salary" data={d} unit={activeUnit} month={month} onChanged={reload} />
              <PartPanel part="incentive" data={d} unit={activeUnit} month={month} onChanged={reload} />
              <div className="flex gap-2">
                {!locked && (
                  <>
                    <Btn kind="ghost" onClick={() => setAdjusting(true)} className="flex-1">
                      + Adjustment
                    </Btn>
                    <Btn
                      kind="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await post(`/api/payroll/${activeUnit}/${month}/recalc`);
                          reload();
                        })
                      }
                      className="flex-1"
                    >
                      Recalculate
                    </Btn>
                  </>
                )}
              </div>
              <div className="space-y-2">
                {d.lines.map((l) => (
                  <Card key={l.employeeId} onClick={() => setOpen(open === l.employeeId ? null : l.employeeId)}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-slate-500">
                          {l.employeeId} · present {l.P}/{l.E} days
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold">{inr(l.netSalaryPaise)}</div>
                        <div className="text-xs text-slate-500">+ incentive {inr(l.incentive.incentivePaise)}</div>
                      </div>
                    </div>
                    {open === l.employeeId && (
                      <div className="mt-2 space-y-0.5 border-t pt-2 text-sm text-slate-700">
                        <Row k="Committed salary" v={inr(l.committedPaise)} />
                        <Row k={`Days: P ${l.P}, D ${l.D}, E ${l.E}`} v={`payable ${l.payableDays}`} />
                        <Row k="Salary before deductions" v={inr(l.salaryPaise)} />
                        <Row k="Advance recovered" v={`− ${inr(l.advanceRecoveredPaise)}`} />
                        {l.advanceCarriedPaise > 0 && <Row k="Advance carried forward" v={inr(l.advanceCarriedPaise)} />}
                        {l.adjustments.map((a, i) => (
                          <Row key={i} k={`${a.kind === "bonus" ? "Bonus" : "Adjustment"}: ${a.reason}`} v={inr(a.amountPaise)} />
                        ))}
                        <Row k="Net salary" v={inr(l.netSalaryPaise)} bold />
                        <Row k={`Sales ${inr(l.incentive.monthlySalesPaise)}${l.incentive.targetPaise ? ` of ${inr(l.incentive.targetPaise)} (${l.incentive.achievementPct}%)` : ""}`} v={`${l.incentive.rateBps / 100}%`} />
                        <Row k="Incentive" v={inr(l.incentive.incentivePaise)} bold />
                        {!l.bank && <p className="text-xs text-red-600">Bank details missing: the bank CSV cannot be downloaded until this is fixed.</p>}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
              {adjusting && <AdjustModal unit={activeUnit} month={month} lines={d.lines} onClose={() => setAdjusting(false)} onSaved={reload} />}
            </>
          );
        }}
      </Async>
      <button type="button" onClick={() => go("/admin/employees")} className="text-sm text-slate-500 underline">
        Manage employees & advances
      </button>
    </div>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

// ================= Reports =================
interface Report {
  month: string;
  units: string[];
  payrollCost: Array<{ unit: string; salaryNetPaise: number; incentivePaise: number; status: string }>;
  attendanceTrend: Array<{ date: string; present: number; late: number; absent: number; onLeave: number }>;
  ranking: Array<{ employeeId: string; name: string; rank: number; score: number; unit: string }>;
  salesByCategory: Record<string, Record<string, number>>;
  funnel: { new: number; contacted: number; followUp: number; closedWon: number; lost: number };
}

function Bar({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="w-24 shrink-0 truncate text-slate-600">{label}</div>
      <div className="h-4 flex-1 rounded bg-slate-100">
        <div className="h-4 rounded bg-amber-400" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
      </div>
      <div className="w-24 shrink-0 text-right font-medium">{text}</div>
    </div>
  );
}

export function Reports() {
  const units = useLoad(() => get<{ units: BusinessUnit[] }>("/api/units"), []);
  const [unit, setUnit] = useState("");
  const [month, setMonth] = useState(monthIST());
  const r = useLoad(() => get<Report>("/api/reports", { unit: unit || undefined, month }), [unit, month]);
  return (
    <div className="space-y-3">
      <PageTitle>Reports</PageTitle>
      <div className="flex gap-2">
        <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">All my units</option>
          {units.data?.units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </Select>
        <Btn kind="ghost" onClick={() => setMonth(shiftMonth(month, -1))} className="!px-3">
          ‹
        </Btn>
        <div className="flex items-center whitespace-nowrap text-sm font-semibold">{monthLabel(month)}</div>
        <Btn kind="ghost" disabled={month >= monthIST()} onClick={() => setMonth(shiftMonth(month, 1))} className="!px-3">
          ›
        </Btn>
      </div>
      <Async state={r}>
        {(d) => {
          const maxCost = Math.max(0, ...d.payrollCost.map((c) => c.salaryNetPaise + c.incentivePaise));
          const maxDay = Math.max(1, ...d.attendanceTrend.map((t) => t.present + t.absent + t.onLeave));
          const funnel = Object.entries(d.funnel);
          const maxF = Math.max(1, ...funnel.map(([, v]) => v));
          return (
            <>
              <Card>
                <h2 className="mb-2 font-semibold">Payroll cost per unit</h2>
                <div className="space-y-1">
                  {d.payrollCost.map((c) => (
                    <Bar key={c.unit} label={`${c.unit} (${c.status})`} value={c.salaryNetPaise + c.incentivePaise} max={maxCost} text={inr(c.salaryNetPaise + c.incentivePaise)} />
                  ))}
                </div>
              </Card>
              <Card>
                <h2 className="mb-2 font-semibold">Attendance trend</h2>
                <div className="flex h-32 items-end gap-0.5">
                  {d.attendanceTrend.map((t) => (
                    <div key={t.date} className="flex flex-1 flex-col justify-end" title={`${t.date}: ${t.present} present, ${t.late} late, ${t.absent} absent, ${t.onLeave} leave`}>
                      <div className="bg-red-400" style={{ height: `${(t.absent / maxDay) * 100}%` }} />
                      <div className="bg-violet-400" style={{ height: `${(t.onLeave / maxDay) * 100}%` }} />
                      <div className="bg-emerald-400" style={{ height: `${(t.present / maxDay) * 100}%` }} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-xs text-slate-500">Green present · Violet leave · Red absent (per day)</div>
              </Card>
              <Card>
                <h2 className="mb-2 font-semibold">Discipline ranking</h2>
                {d.ranking.slice(0, 15).map((e) => (
                  <button key={`${e.unit}${e.employeeId}`} type="button" onClick={() => go(`/team/emp/${e.employeeId}`)} className="flex w-full justify-between py-0.5 text-sm">
                    <span>
                      #{e.rank} {e.name} <span className="text-xs text-slate-500">{e.unit}</span>
                    </span>
                    <span>{e.score}</span>
                  </button>
                ))}
                {d.ranking.length === 0 && <p className="text-sm text-slate-500">No ranking yet.</p>}
              </Card>
              <Card>
                <h2 className="mb-2 font-semibold">Sales by category</h2>
                {Object.entries(d.salesByCategory).map(([u, cats]) => {
                  const unitDoc = units.data?.units.find((x) => x.code === u);
                  return (
                    <div key={u} className="mb-2">
                      <div className="text-xs font-semibold text-slate-500">{unitDoc?.name ?? u}</div>
                      {Object.entries(cats).map(([c, v]) => {
                        const cat = unitDoc?.salesCategories.find((x) => x.id === c);
                        return (
                          <div key={c} className="flex justify-between text-sm">
                            <span>{cat?.name ?? c}</span>
                            <span>{cat ? showValue(cat, v) : v}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {Object.keys(d.salesByCategory).length === 0 && <p className="text-sm text-slate-500">No sales this month.</p>}
              </Card>
              <Card>
                <h2 className="mb-2 font-semibold">Leads funnel</h2>
                <div className="space-y-1">
                  {funnel.map(([k, v]) => (
                    <Bar key={k} label={k} value={v} max={maxF} text={String(v)} />
                  ))}
                </div>
              </Card>
            </>
          );
        }}
      </Async>
    </div>
  );
}
