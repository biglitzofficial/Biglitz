import { useState } from "react";
import { get, post } from "../lib/api";
import { inr, monthIST, monthLabel, prettyDate, shiftMonth, todayIST } from "../lib/format";
import type { LeaderRow, LeaveRequest } from "../lib/types";
import { go } from "../router";
import { isAdminish, isManagerish, isSuper, useAuth, useMe } from "../auth";
import { ChangePin } from "./Login";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Notice, PageTitle, Select, Tabs, Textarea, useAction, useLoad } from "../ui";

// ---------------- Leave ----------------
const LEAVE_TONE = { pending: "amber", approved: "green", rejected: "red" } as const;

export function Leave() {
  const mine = useLoad(() => get<{ requests: LeaveRequest[] }>("/api/leave/mine"), []);
  const [dates, setDates] = useState<string[]>([todayIST()]);
  const [type, setType] = useState("full");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Array<{ date: string; lateApplication: boolean }>>([]);
  const { busy, error, run } = useAction();

  const check = (next: string[]) =>
    run(async () => {
      const valid = next.filter(Boolean);
      if (!valid.length) return setPreview([]);
      const r = await post<{ days: Array<{ date: string; lateApplication: boolean }> }>("/api/leave/preview", { dates: valid, type, reason: "x" });
      setPreview(r.days);
    });

  const setDate = (i: number, v: string) => {
    const next = dates.map((d, j) => (j === i ? v : d));
    setDates(next);
    void check(next);
  };

  const apply = () =>
    run(async () => {
      await post("/api/leave/apply", { dates: dates.filter(Boolean), type, reason });
      setReason("");
      setDates([todayIST()]);
      setPreview([]);
      mine.reload();
    });

  const late = preview.filter((p) => p.lateApplication);

  return (
    <div className="space-y-3">
      <PageTitle>Leave</PageTitle>
      <Card>
        <h2 className="mb-2 font-semibold">Apply for leave</h2>
        <div className="space-y-3">
          {dates.map((d, i) => (
            <Field key={i} label={i === 0 ? "Date" : `Date ${i + 1}`}>
              <Input type="date" min={todayIST()} value={d} onChange={(e) => setDate(i, e.target.value)} />
            </Field>
          ))}
          <button type="button" className="text-sm text-sky-700 underline" onClick={() => setDates([...dates, ""])}>
            + Add another date
          </button>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="full">Full day</option>
              <option value="half">Half day</option>
            </Select>
          </Field>
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {late.length > 0 && (
            <Notice tone="warn">
              Applied less than 2 days ahead for {late.map((l) => prettyDate(l.date)).join(", ")}. Even if approved, it counts as absent for your Discipline Score.
            </Notice>
          )}
          <ErrorBox message={error} />
          <Btn disabled={busy || !reason.trim() || !dates.some(Boolean)} onClick={() => void apply()} className="w-full">
            Submit request
          </Btn>
        </div>
      </Card>
      <Async state={mine}>
        {(d) => (
          <div className="space-y-2">
            <h2 className="font-semibold">My requests</h2>
            {d.requests.length === 0 && <p className="text-sm text-slate-500">No leave requests yet.</p>}
            {d.requests.map((r) => (
              <Card key={r.id}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">
                      {prettyDate(r.dateIST)} · {r.type === "half" ? "Half day" : "Full day"}
                    </div>
                    <div className="text-sm text-slate-600">{r.reason}</div>
                  </div>
                  <div className="text-right">
                    <Badge tone={LEAVE_TONE[r.status]}>{r.status}</Badge>
                    {r.lateApplication && <div className="mt-1 text-xs text-red-600">late application</div>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}

// ---------------- Payslips ----------------
export function Payslips() {
  const list = useLoad(() => get<{ payslips: Array<{ month: string; netSalaryPaise: number; incentivePaise: number }> }>("/api/payslips"), []);
  const { error, run } = useAction();
  const open = (month: string) =>
    run(async () => {
      const r = await get<{ url: string }>(`/api/payslips/${month}/url`);
      window.open(r.url, "_blank", "noopener");
    });
  return (
    <div className="space-y-3">
      <PageTitle>Payslips</PageTitle>
      <ErrorBox message={error} />
      <Async state={list}>
        {(d) => (
          <>
            {d.payslips.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Your first payslip appears after your first payroll is approved.</p>}
            {d.payslips.map((p) => (
              <Card key={p.month} onClick={() => void open(p.month)}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{monthLabel(p.month)}</div>
                    <div className="text-sm text-slate-600">
                      Salary {inr(p.netSalaryPaise)} · Incentive {inr(p.incentivePaise)}
                    </div>
                  </div>
                  <span className="text-sm text-sky-700">Open PDF</span>
                </div>
              </Card>
            ))}
          </>
        )}
      </Async>
    </div>
  );
}

// ---------------- Achievements ----------------
const BADGE_LABEL: Record<string, string> = {
  neverLate: "🕘 Never late",
  fullAttendance: "📅 Full attendance",
  streak30: "🔥 30-day streak",
  noUnapprovedLeave100: "🛡️ 100 days, no unapproved leave",
};

interface ScoreDoc {
  score: number;
  attendancePct: number;
  punctualityPct: number;
  streak: number;
  badges: string[];
  rank: number;
  rankAll: number;
}

export function Achievements() {
  const me = useMe();
  const [scope, setScope] = useState<"unit" | "all">("unit");
  const score = useLoad(() => get<{ score: ScoreDoc | null }>("/api/me/scores"), []);
  const board = useLoad(() => get<{ month: string; entries: LeaderRow[] }>("/api/leaderboard", { scope }), [scope]);
  const lastMonth = shiftMonth(monthIST(), -1);
  const rewards = useLoad(() => get<{ rewards: { winners: Array<{ employeeId: string; name: string; rank: number; amountPaise: number }> } | null }>("/api/rewards", { month: lastMonth }), [lastMonth]);

  return (
    <div className="space-y-3">
      <PageTitle>Achievements</PageTitle>
      <Async state={score}>
        {({ score: s }) =>
          s ? (
            <Card>
              <div className="text-xs text-slate-500">Discipline Score</div>
              <div className="text-3xl font-bold">{s.score}</div>
              <div className="text-sm text-slate-600">
                Attendance {s.attendancePct}% · Punctuality {s.punctualityPct}% · Streak {s.streak}
              </div>
              <div className="mt-1 text-sm">
                Rank #{s.rank} in your unit · #{s.rankAll} overall
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {s.badges.length === 0 && <span className="text-sm text-slate-500">No badges yet. Keep going!</span>}
                {s.badges.map((b) => (
                  <Badge key={b} tone="amber">
                    {BADGE_LABEL[b] ?? b}
                  </Badge>
                ))}
              </div>
            </Card>
          ) : (
            <Notice>Your score appears after your first full day.</Notice>
          )
        }
      </Async>
      <Tabs<"unit" | "all">
        tabs={[
          { id: "unit", label: "My unit" },
          { id: "all", label: "All units" },
        ]}
        value={scope}
        onChange={setScope}
      />
      <Async state={board}>
        {(d) => (
          <Card>
            <div className="mb-2 text-xs text-slate-500">{monthLabel(d.month)}</div>
            <ol className="space-y-1">
              {d.entries.map((e) => (
                <li key={e.employeeId} className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-sm ${e.employeeId === me.employee.employeeId ? "bg-amber-100 font-semibold" : ""}`}>
                  <span>
                    #{e.rank} {e.name}
                  </span>
                  <span>{e.score}</span>
                </li>
              ))}
              {d.entries.length === 0 && <li className="text-sm text-slate-500">No ranking yet.</li>}
            </ol>
          </Card>
        )}
      </Async>
      <Async state={rewards}>
        {(d) =>
          d.rewards && (
            <Card>
              <h2 className="mb-1 font-semibold">🏆 {monthLabel(lastMonth)} winners</h2>
              {d.rewards.winners.map((w) => (
                <div key={w.employeeId} className="flex justify-between text-sm">
                  <span>
                    #{w.rank} {w.name}
                  </span>
                  <span>{inr(w.amountPaise)}</span>
                </div>
              ))}
            </Card>
          )
        }
      </Async>
    </div>
  );
}

// ---------------- Profile & More ----------------
export function Profile() {
  const me = useMe();
  const { logout } = useAuth();
  const e = me.employee;
  return (
    <div className="space-y-3">
      <PageTitle>Profile</PageTitle>
      <Card>
        <div className="text-lg font-semibold">{e.name}</div>
        <div className="text-sm text-slate-600">
          {e.employeeId} · {e.designation || e.roles.join(", ")}
        </div>
        <div className="text-sm text-slate-600">
          {me.unit.name} · Shift {e.shift.start}–{e.shift.end}
        </div>
        <div className="text-sm text-slate-600">Mobile {e.mobile}</div>
        <div className="text-sm text-slate-600">Joined {prettyDate(e.joiningDate)}</div>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Change PIN</h2>
        <ChangePin forced={false} />
      </Card>
      <Btn kind="ghost" onClick={() => void logout()} className="w-full">
        Sign out
      </Btn>
    </div>
  );
}

export function More() {
  const me = useMe();
  const items: Array<[string, string]> = [];
  if (!isSuper(me)) items.push(["/attendance", "My attendance"], ["/leave", "Leave"], ["/payslips", "Payslips"], ["/achievements", "Achievements"]);
  if (me.unit.hasSales && me.employee.requiresSalesEntry) items.push(["/sales", "Today's sales"]);
  if (isManagerish(me)) items.push(["/team/leave", "Leave approvals"], ["/team/pools", "Lead pools"]);
  if (isAdminish(me)) items.push(["/admin/employees", "Employees"], ["/admin/units", "Business units"], ["/admin/reports", "Reports"]);
  if (isSuper(me)) items.push(["/admin/audit", "Audit log"]);
  items.push(["/profile", "Profile & PIN"]);
  return (
    <div className="space-y-2">
      <PageTitle>More</PageTitle>
      {items.map(([path, label]) => (
        <Card key={path} onClick={() => go(path)}>
          <span className="font-medium">{label}</span>
        </Card>
      ))}
    </div>
  );
}
