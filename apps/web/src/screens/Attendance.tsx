import { useState } from "react";
import { get, post } from "../lib/api";
import { istLocalToIso, monthIST, monthLabel, prettyDate, shiftMonth, timeIST, todayIST } from "../lib/format";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Modal, PageTitle, Select, Textarea, useAction, useLoad } from "../ui";

interface Day {
  date: string;
  status: string;
  lateApplication: boolean;
  present: number;
}

const COLORS: Record<string, string> = {
  onTime: "bg-emerald-500 text-white",
  present: "bg-emerald-300 text-slate-900",
  late: "bg-amber-400 text-slate-900",
  earlyLeave: "bg-amber-300 text-slate-900",
  halfDay: "bg-sky-400 text-white",
  missingPunchOut: "bg-orange-400 text-white",
  approvedLeave: "bg-violet-400 text-white",
  absent: "bg-red-500 text-white",
};
const LEGEND: Array<[string, string]> = [
  ["onTime", "On time"],
  ["late", "Late"],
  ["earlyLeave", "Early leave"],
  ["halfDay", "Half day"],
  ["missingPunchOut", "No punch-out"],
  ["approvedLeave", "Leave"],
  ["absent", "Absent"],
];

interface DayDetail {
  attendance: {
    state: string;
    punchInAt: string | null;
    punchOutAt: string | null;
    punchIn: { distanceMeters: number; accuracy: number; lat: number; lng: number; selfieUrl: string | null } | null;
    punchOut: { distanceMeters: number; accuracy: number; lat: number; lng: number; selfieUrl: string | null } | null;
    corrections: Array<{ by: string; at: string; reason: string }>;
  };
}

function PunchPin({ label, p }: { label: string; p: NonNullable<DayDetail["attendance"]["punchIn"]> }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-slate-600">{label}</div>
      {p.selfieUrl && <img src={p.selfieUrl} alt={`${label} selfie`} className="aspect-[3/4] w-full rounded-xl object-cover" />}
      <div className="text-xs text-slate-600">{Math.round(p.distanceMeters)} m from the location</div>
      <a className="text-xs text-sky-700 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${p.lat},${p.lng}`}>
        Open map pin
      </a>
    </div>
  );
}

function DayModal({ employeeId, date, canCorrect, onClose, onChanged }: { employeeId: string; date: string; canCorrect: boolean; onClose: () => void; onChanged: () => void }) {
  const d = useLoad(() => get<DayDetail>(`/api/attendance/${employeeId}/${date}`), [employeeId, date]);
  const [inT, setInT] = useState("");
  const [outT, setOutT] = useState("");
  const [mode, setMode] = useState("times");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();

  const correct = () =>
    run(async () => {
      await post("/api/attendance/correct", {
        employeeId,
        dateIST: date,
        reason,
        ...(mode === "absent" ? { markAbsent: true } : {}),
        ...(mode === "half" ? { halfDay: true } : {}),
        ...(mode === "times" && inT ? { punchInAt: istLocalToIso(`${date}T${inT}`) } : {}),
        ...(mode === "times" && outT ? { punchOutAt: istLocalToIso(`${date}T${outT}`) } : {}),
        ...(mode === "full" ? { halfDay: false } : {}),
      });
      onChanged();
      onClose();
    });

  return (
    <Modal title={prettyDate(date)} onClose={onClose}>
      {d.error ? <p className="text-sm text-slate-500">No punch record for this day.</p> : null}
      <Async state={{ data: d.data, error: null, loading: d.loading }}>
        {({ attendance: a }) => (
          <div className="space-y-3">
            <div className="text-sm">
              In {timeIST(a.punchInAt)} · Out {timeIST(a.punchOutAt)}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {a.punchIn && <PunchPin label="Punch in" p={a.punchIn} />}
              {a.punchOut && <PunchPin label="Punch out" p={a.punchOut} />}
            </div>
            {a.corrections.map((c, i) => (
              <div key={i} className="text-xs text-slate-500">
                Corrected by {c.by}: {c.reason}
              </div>
            ))}
          </div>
        )}
      </Async>
      {canCorrect && (
        <div className="space-y-3 border-t pt-3">
          <h3 className="font-semibold">Correct this day</h3>
          <Field label="What to change">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="times">Set punch times</option>
              <option value="half">Mark half day</option>
              <option value="full">Remove half day</option>
              <option value="absent">Mark absent</option>
            </Select>
          </Field>
          {mode === "times" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Punch in (IST)">
                <Input type="time" value={inT} onChange={(e) => setInT(e.target.value)} />
              </Field>
              <Field label="Punch out (IST)">
                <Input type="time" value={outT} onChange={(e) => setOutT(e.target.value)} />
              </Field>
            </div>
          )}
          <Field label="Reason (required)">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBox message={error} />
          <Btn disabled={busy || !reason.trim()} onClick={() => void correct()} className="w-full">
            Save correction
          </Btn>
        </div>
      )}
    </Modal>
  );
}

export function CalendarView({ employeeId, canCorrect = false }: { employeeId?: string; canCorrect?: boolean }) {
  const [month, setMonth] = useState(monthIST());
  const [open, setOpen] = useState<string | null>(null);
  const cal = useLoad(() => get<{ days: Day[] }>("/api/attendance/calendar", { month, employeeId }), [month, employeeId]);
  const firstWeekday = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Btn kind="ghost" onClick={() => setMonth(shiftMonth(month, -1))} className="!px-3 !py-2">
          ‹
        </Btn>
        <div className="font-semibold">{monthLabel(month)}</div>
        <Btn kind="ghost" disabled={month >= monthIST()} onClick={() => setMonth(shiftMonth(month, 1))} className="!px-3 !py-2">
          ›
        </Btn>
      </div>
      <Async state={cal}>
        {({ days }) => {
          const byDate = new Map(days.map((d) => [d.date, d]));
          const cells: Array<number | null> = [...Array<null>(firstWeekday).fill(null), ...Array.from({ length: lastDay }, (_, i) => i + 1)];
          return (
            <Card>
              <div className="mb-1 grid grid-cols-7 text-center text-xs text-slate-500">
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <div key={i}>{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((n, i) => {
                  if (n === null) return <div key={`b${i}`} />;
                  const date = `${month}-${String(n).padStart(2, "0")}`;
                  const day = byDate.get(date);
                  const cls = day ? (COLORS[day.status] ?? "bg-slate-200") : date > todayIST() ? "bg-slate-50 text-slate-300" : "bg-slate-100 text-slate-400";
                  const clickable = !!day && (!!employeeId || day.status !== "absent");
                  return (
                    <button
                      key={date}
                      type="button"
                      disabled={!clickable && !canCorrect}
                      onClick={() => setOpen(date)}
                      className={`aspect-square rounded-lg text-sm font-medium ${cls} ${day?.lateApplication ? "ring-2 ring-red-600" : ""}`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {LEGEND.map(([k, label]) => (
                  <span key={k} className="flex items-center gap-1 text-xs text-slate-600">
                    <span className={`inline-block h-3 w-3 rounded ${COLORS[k]?.split(" ")[0]}`} />
                    {label}
                  </span>
                ))}
                <Badge tone="red">red ring = late leave application</Badge>
              </div>
            </Card>
          );
        }}
      </Async>
      {open && employeeId && <DayModal employeeId={employeeId} date={open} canCorrect={canCorrect} onClose={() => setOpen(null)} onChanged={cal.reload} />}
    </div>
  );
}

export function Attendance() {
  return (
    <div>
      <PageTitle>My attendance</PageTitle>
      <CalendarView />
    </div>
  );
}
