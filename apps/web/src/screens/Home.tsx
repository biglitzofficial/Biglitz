import { get } from "../lib/api";
import { inr, prettyDate, timeIST } from "../lib/format";
import type { AttendanceSummary, Home as HomeData } from "../lib/types";
import { go } from "../router";
import { useMe } from "../auth";
import { Async, Btn, Card, Notice, PageTitle, Stat, useLoad } from "../ui";

export function Home() {
  const me = useMe();
  const home = useLoad(() => get<HomeData>("/api/me/home"), []);
  const today = useLoad(() => get<{ attendance: AttendanceSummary }>("/api/attendance/today"), []);
  const salesOn = me.unit.hasSales && me.employee.requiresSalesEntry;

  return (
    <div className="space-y-3">
      <PageTitle>Hi, {me.employee.name.split(" ")[0]}</PageTitle>
      <p className="-mt-2 text-xs text-slate-500">
        {me.unit.name} · {home.data ? prettyDate(home.data.dateIST) : ""}
      </p>

      <Async state={today}>
        {(t) => {
          const a = t.attendance;
          return (
            <Card>
              <div className="text-xs text-slate-500">Attendance</div>
              {a.state === "notPunchedIn" && (
                <>
                  <div className="mb-3 text-lg font-semibold">You have not punched in</div>
                  <Btn onClick={() => go("/punch/in")} className="w-full">
                    Punch in
                  </Btn>
                </>
              )}
              {a.state === "punchedIn" && (
                <>
                  <div className="mb-3 text-lg font-semibold">Punched in at {timeIST(a.punchInAt ?? null)}</div>
                  <Btn kind="success" onClick={() => go("/punch/out")} className="w-full">
                    Punch out
                  </Btn>
                </>
              )}
              {a.state === "punchedOut" && (
                <div className="text-lg font-semibold">
                  {timeIST(a.punchInAt ?? null)} → {timeIST(a.punchOutAt ?? null)}
                </div>
              )}
            </Card>
          );
        }}
      </Async>

      <Async state={home}>
        {(h) => (
          <>
            {h.leave.overFree && <Notice tone="warn">You have used {h.leave.used} leave days this month. Only 2 are free; extra days reduce your salary.</Notice>}
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Tasks today" value={`${h.tasks.done}/${h.tasks.total}`} sub={h.tasks.overdue ? `${h.tasks.overdue} overdue` : `${h.tasks.pending} pending`} tone={h.tasks.overdue ? "red" : undefined} onClick={() => go("/tasks")} />
              <Stat label="Follow-ups today" value={h.followUps.today} sub={h.followUps.overdue ? `${h.followUps.overdue} overdue` : "none overdue"} tone={h.followUps.overdue ? "red" : undefined} onClick={() => go("/leads?view=today")} />
              {salesOn && <Stat label="Sales today" value={inr(h.salesTodayPaise)} onClick={() => go("/sales")} />}
              <Stat
                label="Salary so far"
                value={inr(h.salarySoFarPaise)}
                sub={h.pendingDeductionPaise ? `after −${inr(h.pendingDeductionPaise)} deduction` : "this month"}
                tone={h.pendingDeductionPaise ? "red" : undefined}
              />
              <Stat
                label="Projected salary"
                value={inr(h.projectedSalaryPaise)}
                sub={h.pendingDeductionPaise ? `after −${inr(h.pendingDeductionPaise)} deduction` : "if you stay present"}
                tone={h.pendingDeductionPaise ? "red" : undefined}
              />
              <Stat label="Leave used" value={`${h.leave.used} / ${h.leave.free} free`} tone={h.leave.overFree ? "red" : undefined} onClick={() => go("/leave")} />
              <Stat
                label="Discipline rank"
                value={h.rank ? `#${h.rank.unit}` : "—"}
                sub={h.rank ? (h.rank.gap ? `${h.rank.gap.points} pts to #${h.rank.gap.toRank}` : "You lead your unit") : "after first day close"}
                onClick={() => go("/achievements")}
              />
              <Stat label="On-time streak" value={`${h.streak} day${h.streak === 1 ? "" : "s"}`} onClick={() => go("/achievements")} />
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
