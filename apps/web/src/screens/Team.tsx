import { useState } from "react";
import { get, post, put } from "../lib/api";
import { inr, monthIST, monthLabel, prettyDate, shiftMonth, timeIST, todayIST } from "../lib/format";
import type { BusinessUnit, Employee, LeaderRow, LeaveRequest, Slab, TodayRow } from "../lib/types";
import { go, useRoute } from "../router";
import { isAdminish, useMe } from "../auth";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Modal, Notice, PageTitle, Select, Stat, Tabs, Textarea, useAction, useLoad } from "../ui";
import { CalendarView } from "./Attendance";
import { LeadList } from "./Leads";
import { AddTask, TaskList } from "./Tasks";
import { showValue } from "./Sales";

type TeamTab = "today" | "people" | "tasks" | "leads" | "sales" | "leave" | "pools" | "ranking";
const TABS: Array<{ id: TeamTab; label: string }> = [
  { id: "today", label: "Today" },
  { id: "people", label: "People" },
  { id: "tasks", label: "Tasks" },
  { id: "leads", label: "Leads" },
  { id: "sales", label: "Sales" },
  { id: "leave", label: "Leave" },
  { id: "pools", label: "Pools" },
  { id: "ranking", label: "Ranking" },
];

function useUnits() {
  return useLoad(() => get<{ units: BusinessUnit[] }>("/api/units"), []);
}

function UnitPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const me = useMe();
  const units = useUnits();
  if (!isAdminish(me) || (units.data?.units.length ?? 0) < 2) return null;
  return (
    <div className="mb-3">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All my units</option>
        {units.data?.units.map((u) => (
          <option key={u.code} value={u.code}>
            {u.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---------- Today ----------
const STATE_TONE = { present: "green", onLeave: "blue", absent: "red", notYet: "slate" } as const;
type Filter = "all" | "present" | "late" | "absent" | "onLeave" | "sales";

function TeamToday() {
  const [unit, setUnit] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const d = useLoad(() => get<{ summary: { total: number; present: number; late: number; absent: number; onLeave: number; salesNotReported: number }; team: TodayRow[] }>("/api/dashboard/today", { unit: unit || undefined }), [unit]);
  return (
    <div>
      <UnitPicker value={unit} onChange={setUnit} />
      <Async state={d}>
        {({ summary: s, team }) => {
          const rows = team.filter((r) => {
            switch (filter) {
              case "present": return r.punchedIn;
              case "late": return r.late;
              case "absent": return r.state === "absent";
              case "onLeave": return r.state === "onLeave";
              case "sales": return r.requiresSales && !r.salesReported;
              default: return true;
            }
          });
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Present" value={`${s.present}/${s.total}`} tone="green" onClick={() => setFilter("present")} />
                <Stat label="Late" value={s.late} tone={s.late ? "red" : undefined} onClick={() => setFilter("late")} />
                <Stat label="Absent" value={s.absent} tone={s.absent ? "red" : undefined} onClick={() => setFilter("absent")} />
                <Stat label="On leave" value={s.onLeave} onClick={() => setFilter("onLeave")} />
                <Stat label="Sales not in" value={s.salesNotReported} onClick={() => setFilter("sales")} />
                <Stat label="Everyone" value={s.total} onClick={() => setFilter("all")} />
              </div>
              {filter !== "all" && <Notice>Showing filtered list. Tap "Everyone" to clear.</Notice>}
              <div className="space-y-2">
                {rows.map((r) => (
                  <Card key={r.employeeId} onClick={() => go(`/team/emp/${r.employeeId}`)}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-slate-500">
                          {r.punchedIn ? `In ${timeIST(r.punchInAt)}${r.punchedOut ? " · out" : ""}` : "Not punched in"}
                          {r.requiresSales && !r.salesReported ? " · sales pending" : ""}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        {r.late && <Badge tone="amber">Late</Badge>}
                        <Badge tone={STATE_TONE[r.state]}>{r.state === "notYet" ? "not yet" : r.state === "onLeave" ? "on leave" : r.state}</Badge>
                      </div>
                    </div>
                  </Card>
                ))}
                {rows.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nobody here.</p>}
              </div>
            </div>
          );
        }}
      </Async>
    </div>
  );
}

// ---------- People (Manager team roster — view only; create/edit is Admin) ----------
function TeamPeople() {
  const me = useMe();
  const [q, setQ] = useState("");
  const [assigning, setAssigning] = useState(false);
  const d = useLoad(() => get<{ employees: Employee[] }>("/api/employees"), []);
  return (
    <div className="space-y-3">
      <Input placeholder="Search name or ID" value={q} onChange={(e) => setQ(e.target.value)} />
      <Btn onClick={() => setAssigning(true)} className="w-full">
        + Assign task
      </Btn>
      <Async state={d}>
        {({ employees }) => {
          const needle = q.trim().toLowerCase();
          const list = employees
            .filter((e) => e.employeeId !== me.employee.employeeId && e.status !== "exited")
            .filter((e) => !needle || e.name.toLowerCase().includes(needle) || e.employeeId.toLowerCase().includes(needle) || e.designation.toLowerCase().includes(needle));
          return (
            <div className="space-y-2">
              {list.map((e) => (
                <Card key={e.employeeId} onClick={() => go(`/team/emp/${e.employeeId}`)}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{e.name}</div>
                      <div className="text-xs text-slate-500">
                        {e.designation} · {e.employeeId} · {e.businessId}
                        {e.status === "pending" ? " · pending" : ""}
                      </div>
                    </div>
                    <Badge tone={e.status === "active" ? "green" : "slate"}>{e.status}</Badge>
                  </div>
                </Card>
              ))}
              {list.length === 0 && <p className="p-4 text-center text-sm text-slate-500">No one on your team yet.</p>}
            </div>
          );
        }}
      </Async>
      {assigning && d.data && (
        <AddTask team={d.data.employees} allowRepeat onClose={() => setAssigning(false)} onSaved={() => go("/team/tasks")} />
      )}
    </div>
  );
}

// ---------- Tasks ----------
function TeamTasks() {
  const [assigning, setAssigning] = useState(false);
  const d = useLoad(() => get<{ members: Array<{ employeeId: string; name: string; todayDone: number; todayTotal: number; pending: number; overdue: number; completedThisMonth: number }>; noTaskNow: Array<{ employeeId: string; name: string }> }>("/api/tasks/team"), []);
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees"), []);
  return (
    <div className="space-y-3">
      <Btn onClick={() => setAssigning(true)} className="w-full">
        + Assign task
      </Btn>
      <Async state={d}>
        {({ members, noTaskNow }) => (
          <div className="space-y-3">
            {noTaskNow.length > 0 && (
              <Notice tone="warn">
                <b>No task right now:</b>{" "}
                {noTaskNow.map((n, i) => (
                  <button key={n.employeeId} type="button" className="underline" onClick={() => go(`/team/emp/${n.employeeId}`)}>
                    {n.name}
                    {i < noTaskNow.length - 1 ? ", " : ""}
                  </button>
                ))}
              </Notice>
            )}
            {members.map((m) => (
              <Card key={m.employeeId} onClick={() => go(`/team/emp/${m.employeeId}?tab=tasks`)}>
                <div className="flex items-center justify-between">
                  <div className="font-medium">{m.name}</div>
                  <div className="text-sm text-slate-600">
                    Today {m.todayDone}/{m.todayTotal} · Pending {m.pending} · <span className={m.overdue ? "font-semibold text-red-600" : ""}>Overdue {m.overdue}</span> · Month done {m.completedThisMonth}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
      {assigning && team.data && (
        <AddTask team={team.data.employees} allowRepeat onClose={() => setAssigning(false)} onSaved={d.reload} />
      )}
    </div>
  );
}

// ---------- Leads ----------
function TeamLeads() {
  const [emp, setEmp] = useState("");
  const counts = useLoad(
    () => get<{ counts: { todayFollowUps: number; overdue: number; total: number; closedWon: number; lost: number; open: number; closedValueThisMonthPaise: number } }>("/api/leads/dashboard", { employeeId: emp || undefined }),
    [emp],
  );
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees"), []);
  return (
    <div className="space-y-3">
      <Select value={emp} onChange={(e) => setEmp(e.target.value)}>
        <option value="">Whole team</option>
        {team.data?.employees.filter((e) => e.status === "active").map((e) => (
          <option key={e.employeeId} value={e.employeeId}>
            {e.name}
          </option>
        ))}
      </Select>
      <Async state={counts}>
        {({ counts: c }) => (
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Follow-ups today" value={c.todayFollowUps} />
            <Stat label="Overdue" value={c.overdue} tone={c.overdue ? "red" : undefined} />
            <Stat label="Open" value={c.open} />
            <Stat label="Won" value={c.closedWon} tone="green" />
            <Stat label="Lost" value={c.lost} />
            <Stat label="Won this month" value={inr(c.closedValueThisMonthPaise)} />
          </div>
        )}
      </Async>
      <LeadList key={emp} {...(emp ? { employeeId: emp } : {})} />
    </div>
  );
}

// ---------- Sales ----------
function TeamSales() {
  const [unit, setUnit] = useState("");
  const [scope, setScope] = useState<"today" | "month">("today");
  const units = useUnits();
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees"), []);
  const d = useLoad(
    () => get<{ byUnit: Record<string, Record<string, number>>; byEmployee: Record<string, number> }>("/api/sales/team", { unit: unit || undefined, ...(scope === "today" ? { date: todayIST() } : { month: monthIST() }) }),
    [unit, scope],
  );
  const name = (id: string) => team.data?.employees.find((e) => e.employeeId === id)?.name ?? id;
  return (
    <div>
      <UnitPicker value={unit} onChange={setUnit} />
      <Tabs<"today" | "month">
        tabs={[
          { id: "today", label: "Today" },
          { id: "month", label: "This month" },
        ]}
        value={scope}
        onChange={setScope}
      />
      <Async state={d}>
        {(s) => (
          <div className="space-y-3">
            {Object.entries(s.byUnit).map(([u, cats]) => {
              const unitDoc = units.data?.units.find((x) => x.code === u);
              return (
                <Card key={u}>
                  <h2 className="mb-1 font-semibold">{unitDoc?.name ?? u}</h2>
                  {Object.entries(cats).map(([cid, v]) => {
                    const c = unitDoc?.salesCategories.find((x) => x.id === cid);
                    return (
                      <div key={cid} className="flex justify-between text-sm">
                        <span>{c?.name ?? cid}</span>
                        <span className="font-semibold">{c ? showValue(c, v) : v}</span>
                      </div>
                    );
                  })}
                </Card>
              );
            })}
            <Card>
              <h2 className="mb-1 font-semibold">By person (amount sales)</h2>
              {Object.entries(s.byEmployee).sort(([, a], [, b]) => b - a).map(([id, v]) => (
                <button key={id} type="button" onClick={() => go(`/team/emp/${id}?tab=sales`)} className="flex w-full justify-between py-0.5 text-sm">
                  <span>{name(id)}</span>
                  <span className="font-semibold">{inr(v)}</span>
                </button>
              ))}
              {Object.keys(s.byEmployee).length === 0 && <p className="text-sm text-slate-500">No sales entries.</p>}
            </Card>
          </div>
        )}
      </Async>
    </div>
  );
}

// ---------- Leave approvals ----------
export function TeamLeave() {
  const d = useLoad(() => get<{ requests: LeaveRequest[] }>("/api/leave/pending"), []);
  const [note, setNote] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const decide = (id: string, decision: "approved" | "rejected") =>
    run(async () => {
      await post(`/api/leave/${id}/decision`, { decision, note: note[id] ?? "" });
      d.reload();
    });
  return (
    <div className="space-y-2">
      <ErrorBox message={error} />
      <Async state={d}>
        {({ requests }) => (
          <>
            {requests.length === 0 && <p className="p-4 text-center text-sm text-slate-500">No pending leave requests.</p>}
            {requests.map((r) => (
              <Card key={r.id}>
                <div className="font-medium">
                  {r.employeeName} · {prettyDate(r.dateIST)} · {r.type === "half" ? "Half" : "Full"}
                </div>
                <div className="text-sm text-slate-600">{r.reason}</div>
                {r.lateApplication && <Notice tone="warn">Late application (under 2 days). Approving it still counts as absent for discipline.</Notice>}
                <div className="mt-2 flex gap-2">
                  <Input placeholder="Note (optional)" value={note[r.id] ?? ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
                  <Btn kind="success" disabled={busy} onClick={() => void decide(r.id, "approved")} className="!px-3">
                    Approve
                  </Btn>
                  <Btn kind="danger" disabled={busy} onClick={() => void decide(r.id, "rejected")} className="!px-3">
                    Reject
                  </Btn>
                </div>
              </Card>
            ))}
          </>
        )}
      </Async>
    </div>
  );
}

// ---------- Pools ----------
interface Pool {
  id: string;
  businessId: string;
  source: string;
  staffOrder: string[];
  skipAbsent: boolean;
}
const SOURCES = ["all", "manual", "leadSheet", "whatsapp", "ads", "other"];

function PoolEditor({ pool, units, onClose, onSaved }: { pool: Pool | null; units: BusinessUnit[]; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const [businessId, setBusinessId] = useState(pool?.businessId ?? me.employee.businessId);
  const [source, setSource] = useState(pool?.source ?? "all");
  const [order, setOrder] = useState<string[]>(pool?.staffOrder ?? []);
  const [skipAbsent, setSkip] = useState(pool?.skipAbsent ?? true);
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees", { unit: businessId }), [businessId]);
  const { busy, error, run } = useAction();
  const candidates = (team.data?.employees ?? []).filter((e) => e.status === "active" && e.businessId === businessId);
  const toggle = (id: string) => setOrder(order.includes(id) ? order.filter((x) => x !== id) : [...order, id]);
  const save = () =>
    run(async () => {
      const body = { businessId, source, staffOrder: order, skipAbsent };
      if (pool) await put(`/api/lead-pools/${pool.id}`, body);
      else await post("/api/lead-pools", body);
      onSaved();
      onClose();
    });
  return (
    <Modal title={pool ? "Edit pool" : "New pool"} onClose={onClose}>
      <Field label="Business unit">
        <Select value={businessId} disabled={!!pool} onChange={(e) => { setBusinessId(e.target.value); setOrder([]); }}>
          {units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Lead source">
        <Select value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All sources" : s}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Staff in the pool (tap in the order for rotation)">
        <div className="space-y-1">
          {candidates.map((e) => (
            <button key={e.employeeId} type="button" onClick={() => toggle(e.employeeId)} className={`flex w-full justify-between rounded-lg px-3 py-2 text-sm ${order.includes(e.employeeId) ? "bg-amber-100" : "bg-slate-100"}`}>
              <span>{e.name}</span>
              <span>{order.includes(e.employeeId) ? `#${order.indexOf(e.employeeId) + 1}` : ""}</span>
            </button>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={skipAbsent} onChange={(e) => setSkip(e.target.checked)} /> Skip people who are absent or on leave today
      </label>
      <ErrorBox message={error} />
      <Btn disabled={busy || order.length === 0} onClick={() => void save()} className="w-full">
        Save pool
      </Btn>
    </Modal>
  );
}

export function TeamPools() {
  const pools = useLoad(() => get<{ pools: Pool[] }>("/api/lead-pools"), []);
  const units = useUnits();
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees"), []);
  const [editing, setEditing] = useState<Pool | "new" | null>(null);
  const name = (id: string) => team.data?.employees.find((e) => e.employeeId === id)?.name ?? id;
  return (
    <div className="space-y-2">
      <Async state={pools}>
        {({ pools: list }) => (
          <>
            {list.length === 0 && <p className="p-4 text-center text-sm text-slate-500">No pools yet. Leads from a source with no pool stay unassigned.</p>}
            {list.map((p) => (
              <Card key={p.id} onClick={() => setEditing(p)}>
                <div className="font-medium">
                  {p.businessId} · {p.source === "all" ? "All sources" : p.source}
                </div>
                <div className="text-sm text-slate-600">{p.staffOrder.map(name).join(" → ")}</div>
              </Card>
            ))}
          </>
        )}
      </Async>
      <Btn onClick={() => setEditing("new")} className="w-full">
        + New pool
      </Btn>
      {editing && units.data && <PoolEditor pool={editing === "new" ? null : editing} units={units.data.units} onClose={() => setEditing(null)} onSaved={pools.reload} />}
    </div>
  );
}

// ---------- Ranking ----------
function TeamRanking() {
  const me = useMe();
  const [unit, setUnit] = useState(me.employee.businessId);
  const units = useUnits();
  const d = useLoad(() => get<{ month: string; entries: LeaderRow[] }>("/api/leaderboard", { unit }), [unit]);
  return (
    <div>
      {isAdminish(me) && (
        <div className="mb-3">
          <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {units.data?.units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <Async state={d}>
        {(r) => (
          <Card>
            <div className="mb-2 text-xs text-slate-500">{monthLabel(r.month)}</div>
            {r.entries.map((e) => (
              <button key={e.employeeId} type="button" onClick={() => go(`/team/emp/${e.employeeId}`)} className="flex w-full justify-between py-1 text-sm">
                <span>
                  #{e.rank} {e.name}
                </span>
                <span>
                  {e.score} · 🔥{e.streak}
                </span>
              </button>
            ))}
            {r.entries.length === 0 && <p className="text-sm text-slate-500">No ranking yet.</p>}
          </Card>
        )}
      </Async>
    </div>
  );
}

// ---------- Team shell ----------
export function Team({ tab }: { tab: string }) {
  const active = (TABS.some((t) => t.id === tab) ? tab : "today") as TeamTab;
  return (
    <div>
      <PageTitle>My team</PageTitle>
      <Tabs<TeamTab> tabs={TABS} value={active} onChange={(t) => go(`/team/${t}`)} />
      {active === "today" && <TeamToday />}
      {active === "people" && <TeamPeople />}
      {active === "tasks" && <TeamTasks />}
      {active === "leads" && <TeamLeads />}
      {active === "sales" && <TeamSales />}
      {active === "leave" && <TeamLeave />}
      {active === "pools" && <TeamPools />}
      {active === "ranking" && <TeamRanking />}
    </div>
  );
}

// ---------- Employee drill-in ----------
type EmpTab = "attendance" | "tasks" | "leads" | "sales" | "target";

interface SalesMonth {
  entries: Array<{ dateIST: string; values: Record<string, number>; amountTotalPaise: number; noSales: boolean }>;
  totalsByCategory: Record<string, number>;
  amountTotalPaise: number;
}

function SalesCorrection({ employee, unit, onClose, onSaved }: { employee: Employee; unit: BusinessUnit; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayIST());
  const cats = unit.salesCategories.filter((c) => c.active);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const save = () =>
    run(async () => {
      await post("/api/sales/correct", { employeeId: employee.employeeId, dateIST: date, values: Object.fromEntries(cats.map((c) => [c.id, Number(vals[c.id] || 0)])), reason });
      onSaved();
      onClose();
    });
  return (
    <Modal title={`Correct sales: ${employee.name}`} onClose={onClose}>
      <Field label="Date">
        <Input type="date" max={todayIST()} value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      {cats.map((c) => (
        <Field key={c.id} label={c.type === "amount" ? `${c.name} (₹)` : `${c.name} (count)`}>
          <Input inputMode="numeric" value={vals[c.id] ?? ""} onChange={(e) => setVals({ ...vals, [c.id]: e.target.value.replace(/\D/g, "") })} />
        </Field>
      ))}
      <Field label="Reason (required)">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Btn disabled={busy || !reason.trim()} onClick={() => void save()} className="w-full">
        Save correction
      </Btn>
    </Modal>
  );
}

function EmpSales({ employee }: { employee: Employee }) {
  const [month, setMonth] = useState(monthIST());
  const [correcting, setCorrecting] = useState(false);
  const d = useLoad(() => get<SalesMonth>("/api/sales", { employeeId: employee.employeeId, month }), [employee.employeeId, month]);
  const unit = useLoad(() => get<{ unit: BusinessUnit }>(`/api/units/${employee.businessId}`), [employee.businessId]);
  const cat = (id: string) => unit.data?.unit.salesCategories.find((c) => c.id === id);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Btn kind="ghost" onClick={() => setMonth(shiftMonth(month, -1))} className="!px-3 !py-2">‹</Btn>
        <b>{monthLabel(month)}</b>
        <Btn kind="ghost" disabled={month >= monthIST()} onClick={() => setMonth(shiftMonth(month, 1))} className="!px-3 !py-2">›</Btn>
      </div>
      <Async state={d}>
        {(s) => (
          <>
            <Card>
              <div className="text-xs text-slate-500">Month total (amount sales)</div>
              <div className="text-xl font-bold">{inr(s.amountTotalPaise)}</div>
              {Object.entries(s.totalsByCategory).map(([id, v]) => {
                const c = cat(id);
                return (
                  <div key={id} className="flex justify-between text-sm">
                    <span>{c?.name ?? id}</span>
                    <span>{c ? showValue(c, v) : v}</span>
                  </div>
                );
              })}
            </Card>
            {s.entries.map((e) => (
              <Card key={e.dateIST}>
                <div className="flex justify-between text-sm">
                  <span>{prettyDate(e.dateIST)}</span>
                  <span className="font-semibold">{e.noSales ? "No sales" : inr(e.amountTotalPaise)}</span>
                </div>
              </Card>
            ))}
          </>
        )}
      </Async>
      <Btn kind="ghost" onClick={() => setCorrecting(true)} className="w-full">
        Correct a sales entry
      </Btn>
      {correcting && unit.data && <SalesCorrection employee={employee} unit={unit.data.unit} onClose={() => setCorrecting(false)} onSaved={d.reload} />}
    </div>
  );
}

export function SlabEditor({ slabs, onChange }: { slabs: Slab[]; onChange: (s: Slab[]) => void }) {
  const set = (i: number, patch: Partial<Slab>) => onChange(slabs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2">
      {slabs.map((s, i) => (
        <div key={i} className="flex items-end gap-2">
          <Field label="From achievement %">
            <Input inputMode="decimal" value={String(s.fromAchievementPct)} onChange={(e) => set(i, { fromAchievementPct: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })} />
          </Field>
          <Field label="Rate %">
            <Input inputMode="decimal" value={String(s.rateBps / 100)} onChange={(e) => set(i, { rateBps: Math.round((Number(e.target.value.replace(/[^\d.]/g, "")) || 0) * 100) })} />
          </Field>
          <button type="button" className="pb-2 text-red-600" onClick={() => onChange(slabs.filter((_, j) => j !== i))} aria-label="Remove slab">
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="text-sm text-sky-700 underline" onClick={() => onChange([...slabs, { fromAchievementPct: 0, rateBps: 0 }])}>
        + Add slab
      </button>
    </div>
  );
}

export function EmpTarget({ employee }: { employee: Employee }) {
  const t = useLoad(() => get<{ target: { targetPaise: number | null; slabs: Slab[] } }>(`/api/employees/${employee.employeeId}/target`), [employee.employeeId]);
  const [amount, setAmount] = useState<string | null>(null);
  const [slabs, setSlabs] = useState<Slab[] | null>(null);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <Async state={t}>
      {({ target }) => {
        const amt = amount ?? (target.targetPaise === null ? "" : String(target.targetPaise / 100));
        const sl = slabs ?? target.slabs;
        return (
          <Card>
            <div className="space-y-3">
              <h2 className="font-semibold">Monthly target & incentive slabs</h2>
              <p className="text-xs text-slate-500">
                Manager, Admin or Super Admin can set these. The highest slab whose achievement % the staff reaches applies to the whole month&apos;s amount sales.
              </p>
              <Field label="Monthly sales target (₹)" hint="Leave empty if this person has no sales target / incentive.">
                <Input inputMode="numeric" value={amt} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
              </Field>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">Incentive slabs</div>
                <p className="mb-2 text-xs text-slate-500">From achievement % → incentive rate (% of month&apos;s amount sales). Defaults: 80%→1%, 100%→1.5%, 120%→2%.</p>
                <SlabEditor slabs={sl} onChange={setSlabs} />
              </div>
              <Field label="Reason for change (required)">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <ErrorBox message={error} />
              {saved && <Notice tone="ok">Target and slabs saved.</Notice>}
              <Btn
                disabled={busy || !reason.trim() || sl.length === 0}
                onClick={() =>
                  void run(async () => {
                    await put(`/api/employees/${employee.employeeId}/target`, { monthlyTargetRupees: amt === "" ? null : Number(amt), slabs: sl, reason });
                    setSaved(true);
                    setReason("");
                    t.reload();
                  })
                }
                className="w-full"
              >
                Save target & slabs
              </Btn>
            </div>
          </Card>
        );
      }}
    </Async>
  );
}

export function EmployeeDrill({ id }: { id: string }) {
  const { query } = useRoute();
  const me = useMe();
  const [tab, setTab] = useState<EmpTab>((query.get("tab") as EmpTab | null) ?? "attendance");
  const [assigning, setAssigning] = useState(false);
  const e = useLoad(() => get<{ employee: Employee }>(`/api/employees/${id}`), [id]);
  return (
    <div>
      <PageTitle right={isAdminish(me) ? <Btn kind="ghost" onClick={() => go(`/admin/employees/${id}`)} className="!px-3 !py-2">Admin</Btn> : undefined}>
        <Async state={e}>{({ employee }) => <>{employee.name}</>}</Async>
      </PageTitle>
      <div className="mb-3">
        <Btn onClick={() => setAssigning(true)} className="w-full">
          + Assign task to {e.data?.employee.name ?? "staff"}
        </Btn>
      </div>
      <Tabs<EmpTab>
        tabs={[
          { id: "attendance", label: "Attendance" },
          { id: "tasks", label: "Tasks" },
          { id: "leads", label: "Leads" },
          { id: "sales", label: "Sales" },
          { id: "target", label: "Target & slabs" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "attendance" && <CalendarView employeeId={id} canCorrect />}
      {tab === "tasks" && <TaskList employeeId={id} canManage allowRepeat />}
      {tab === "leads" && <LeadList employeeId={id} />}
      {e.data && tab === "sales" && <EmpSales employee={e.data.employee} />}
      {e.data && tab === "target" && <EmpTarget employee={e.data.employee} />}
      {assigning && <AddTask assigneeId={id} allowRepeat onClose={() => setAssigning(false)} onSaved={() => setTab("tasks")} />}
    </div>
  );
}
