import { useState } from "react";
import { get, patch, post } from "../lib/api";
import { inr, prettyDate, dateTimeIST, todayIST, waLink } from "../lib/format";
import type { Employee, Lead, LeadStatus } from "../lib/types";
import { back, go, useRoute } from "../router";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Modal, PageTitle, Select, Tabs, Textarea, useAction, useLoad } from "../ui";
import { useMe, isManagerish } from "../auth";

type View = "today" | "overdue" | "all";
const STATUS_LABEL: Record<LeadStatus, string> = { new: "New", contacted: "Contacted", followUp: "Follow-up", closedWon: "Closed won", lost: "Lost" };
const STATUS_TONE: Record<LeadStatus, "slate" | "blue" | "amber" | "green" | "red"> = { new: "blue", contacted: "slate", followUp: "amber", closedWon: "green", lost: "red" };

export function LeadRow({ lead }: { lead: Lead }) {
  const overdue = !!lead.nextFollowUpDate && lead.nextFollowUpDate < todayIST() && lead.status !== "closedWon" && lead.status !== "lost";
  return (
    <Card onClick={() => go(`/leads/${lead.id}`)}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{lead.name}</div>
          <div className="text-sm text-slate-600">{lead.phone}</div>
        </div>
        <div className="text-right">
          <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABEL[lead.status]}</Badge>
          {lead.nextFollowUpDate && <div className={`mt-1 text-xs ${overdue ? "font-semibold text-red-600" : "text-slate-500"}`}>{prettyDate(lead.nextFollowUpDate)}</div>}
        </div>
      </div>
    </Card>
  );
}

function AddLead({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const { busy, error, run } = useAction();
  const [dup, setDup] = useState<string | null>(null);
  const save = () =>
    run(async () => {
      const r = await post<{ deduplicated: boolean }>("/api/leads", { name, phone, notes, source: "manual" });
      if (r.deduplicated) setDup("This phone number already exists in your business unit, so no new lead was created.");
      else {
        onSaved();
        onClose();
      }
    });
  return (
    <Modal title="New lead" onClose={onClose}>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Phone">
        <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Notes">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorBox message={error ?? dup} />
      <Btn disabled={busy || !name.trim() || !phone.trim()} onClick={() => void save()} className="w-full">
        Add lead
      </Btn>
    </Modal>
  );
}

export function LeadList({ employeeId, initialView = "all" }: { employeeId?: string; initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => get<{ leads: Lead[] }>("/api/leads", { view, search: search || undefined, employeeId }), [view, search, employeeId]);
  return (
    <div>
      <Tabs<View>
        tabs={[
          { id: "today", label: "Today" },
          { id: "overdue", label: "Overdue" },
          { id: "all", label: "All" },
        ]}
        value={view}
        onChange={setView}
      />
      <div className="mb-3">
        <Input placeholder="Search name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Async state={list}>
        {(d) => (
          <div className="space-y-2">
            {d.leads.length === 0 && <p className="p-4 text-center text-sm text-slate-500">No leads here.</p>}
            {d.leads.map((l) => (
              <LeadRow key={l.id} lead={l} />
            ))}
          </div>
        )}
      </Async>
      {!employeeId && (
        <div className="mt-3">
          <Btn onClick={() => setAdding(true)} className="w-full">
            + Add lead
          </Btn>
        </div>
      )}
      {adding && <AddLead onClose={() => setAdding(false)} onSaved={list.reload} />}
    </div>
  );
}

export function Leads() {
  const { query } = useRoute();
  const v = query.get("view");
  return (
    <div>
      <PageTitle>My leads</PageTitle>
      <LeadList initialView={v === "today" || v === "overdue" ? v : "all"} />
    </div>
  );
}

interface LeadDetailData {
  lead: Lead;
  history: Array<{ at: string; by: string; status: string; note: string }>;
}

export function LeadDetail({ id }: { id: string }) {
  const me = useMe();
  const d = useLoad(() => get<LeadDetailData>(`/api/leads/${id}`), [id]);
  const reasons = useLoad(() => get<{ reasons: string[] }>("/api/settings/lost-reasons"), []);
  const team = useLoad(() => (isManagerish(me) ? get<{ employees: Employee[] }>("/api/employees") : Promise.resolve({ employees: [] as Employee[] })), []);
  const [status, setStatus] = useState<LeadStatus>("contacted");
  const [temperature, setTemperature] = useState("warm");
  const [next, setNext] = useState("");
  const [value, setValue] = useState("");
  const [lostReason, setLostReason] = useState("");
  const [note, setNote] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const { busy, error, run } = useAction();

  const save = () =>
    run(async () => {
      await patch(`/api/leads/${id}`, {
        status,
        note,
        ...(status === "followUp" ? { temperature, nextFollowUpDate: next || null } : {}),
        ...(status === "closedWon" ? { closedValueRupees: Number(value || 0) } : {}),
        ...(status === "lost" ? { lostReason } : {}),
      });
      setNote("");
      d.reload();
    });

  const reassign = () =>
    run(async () => {
      await post(`/api/leads/${id}/reassign`, { assigneeId: assignTo });
      d.reload();
    });

  return (
    <div className="space-y-3">
      <PageTitle right={<button onClick={back} className="text-sm text-slate-500 underline">Back</button>}>Lead</PageTitle>
      <Async state={d}>
        {({ lead, history }) => (
          <>
            <Card>
              <div className="text-lg font-semibold">{lead.name}</div>
              <div className="text-sm text-slate-600">{lead.phone}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <a href={`tel:${lead.phone}`} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">
                  Call
                </a>
                <a href={waLink(lead.phone)} target="_blank" rel="noreferrer" className="rounded-xl bg-green-500 px-4 py-2 text-sm font-semibold text-white">
                  WhatsApp
                </a>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABEL[lead.status]}</Badge>
                {lead.temperature && <Badge tone="amber">{lead.temperature}</Badge>}
                <Badge>{lead.source}</Badge>
                {lead.nextFollowUpDate && <Badge tone="blue">Next {prettyDate(lead.nextFollowUpDate)}</Badge>}
                {lead.closedValuePaise !== null && <Badge tone="green">{inr(lead.closedValuePaise)}</Badge>}
                {lead.lostReason && <Badge tone="red">{lead.lostReason}</Badge>}
              </div>
              {lead.notes && <p className="mt-2 text-sm text-slate-600">{lead.notes}</p>}
            </Card>

            <Card>
              <h2 className="mb-2 font-semibold">Update status</h2>
              <div className="space-y-3">
                <Field label="Status">
                  <Select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
                    {(Object.keys(STATUS_LABEL) as LeadStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {status === "followUp" && (
                  <>
                    <Field label="Interest">
                      <Select value={temperature} onChange={(e) => setTemperature(e.target.value)}>
                        <option value="hot">Hot</option>
                        <option value="warm">Warm</option>
                        <option value="cold">Cold</option>
                      </Select>
                    </Field>
                    <Field label="Next follow-up date">
                      <Input type="date" min={todayIST()} value={next} onChange={(e) => setNext(e.target.value)} />
                    </Field>
                  </>
                )}
                {status === "closedWon" && (
                  <Field label="Sale value (₹)">
                    <Input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} />
                  </Field>
                )}
                {status === "lost" && (
                  <Field label="Reason">
                    <Select value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                      <option value="">Choose…</option>
                      {(reasons.data?.reasons ?? []).map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label={lostReason === "Other" ? "Note (required)" : "Note"}>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                <ErrorBox message={error} />
                <Btn disabled={busy} onClick={() => void save()} className="w-full">
                  Save
                </Btn>
              </div>
            </Card>

            {isManagerish(me) && (
              <Card>
                <h2 className="mb-2 font-semibold">Reassign</h2>
                <div className="flex gap-2">
                  <Select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">Choose person…</option>
                    {(team.data?.employees ?? [])
                      .filter((e) => e.status === "active")
                      .map((e) => (
                        <option key={e.employeeId} value={e.employeeId}>
                          {e.name} ({e.employeeId})
                        </option>
                      ))}
                  </Select>
                  <Btn kind="ghost" disabled={busy || !assignTo} onClick={() => void reassign()}>
                    Assign
                  </Btn>
                </div>
              </Card>
            )}

            <Card>
              <h2 className="mb-2 font-semibold">History</h2>
              {history.length === 0 && <p className="text-sm text-slate-500">No updates yet.</p>}
              <ul className="space-y-2">
                {history.map((h, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-xs text-slate-500">{dateTimeIST(h.at)} · </span>
                    <b>{STATUS_LABEL[h.status as LeadStatus] ?? h.status}</b>
                    {h.note && <span className="text-slate-600"> — {h.note}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
