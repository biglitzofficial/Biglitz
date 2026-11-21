import { useRef, useState } from "react";
import { MapPicker, mapsEnabled } from "../MapPicker";
import { get, patch, post, put, uploadToSignedUrl } from "../lib/api";
import { inr, prettyDate, todayIST, dateTimeIST } from "../lib/format";
import type { BusinessUnit, Employee, Role, SalesCategory } from "../lib/types";
import { back, go } from "../router";
import { isSuper, useMe } from "../auth";
import { AddTask } from "./Tasks";
import { EmpTarget, Penalties } from "./Team";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Modal, Notice, PageTitle, Select, Stat, Textarea, useAction, useLoad } from "../ui";

const useUnits = () => useLoad(() => get<{ units: BusinessUnit[] }>("/api/units"), []);

// ================= Employees list =================
const STATUS_TONE = { active: "green", pending: "amber", exited: "slate" } as const;

export function Employees() {
  const me = useMe();
  const units = useUnits();
  const [unit, setUnit] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => get<{ employees: Employee[] }>("/api/employees", { unit: unit || undefined, search: search || undefined }), [unit, search]);
  return (
    <div className="space-y-3">
      <PageTitle right={<Btn onClick={() => setCreating(true)} className="!px-3 !py-2">+ New</Btn>}>Employees</PageTitle>
      <div className="flex gap-2">
        <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">All units</option>
          {units.data?.units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </Select>
        <Input placeholder="Search name, ID, mobile" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Async state={list}>
        {({ employees }) => (
          <div className="space-y-2">
            {employees.map((e) => (
              <Card key={e.employeeId} onClick={() => go(`/admin/employees/${e.employeeId}`)}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{e.name}</div>
                    <div className="text-xs text-slate-500">
                      {e.employeeId} · {e.businessId} · {e.roles.join(", ")}
                    </div>
                  </div>
                  <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
      {creating && units.data && <CreateEmployee units={units.data.units} isSuperAdmin={isSuper(me)} onClose={() => setCreating(false)} onCreated={(id) => go(`/admin/employees/${id}`)} />}
    </div>
  );
}

function BankFields({ v, set }: { v: { holder: string; number: string; ifsc: string }; set: (v: { holder: string; number: string; ifsc: string }) => void }) {
  return (
    <>
      <Field label="Account holder name">
        <Input value={v.holder} onChange={(e) => set({ ...v, holder: e.target.value })} />
      </Field>
      <Field label="Account number">
        <Input inputMode="numeric" value={v.number} onChange={(e) => set({ ...v, number: e.target.value.replace(/\D/g, "") })} />
      </Field>
      <Field label="IFSC">
        <Input value={v.ifsc} onChange={(e) => set({ ...v, ifsc: e.target.value.toUpperCase() })} />
      </Field>
    </>
  );
}

function CreateEmployee({ units, isSuperAdmin, onClose, onCreated }: { units: BusinessUnit[]; isSuperAdmin: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: "", mobile: "", tempPin: "", businessId: units[0]?.code ?? "", designation: "", joiningDate: todayIST(), salary: "", target: "", aadhaar: "", requiresSales: true, isManager: false, isAdmin: false });
  const [bank, setBank] = useState({ holder: "", number: "", ifsc: "" });
  const [adminUnits, setAdminUnits] = useState<string[]>([]);
  const [managerId, setManagerId] = useState("");
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees", { unit: f.businessId }), [f.businessId]);
  const { busy, error, run } = useAction();
  const managers = (team.data?.employees ?? []).filter((e) => e.roles.some((r) => r === "manager" || r === "admin") && e.status !== "exited");
  const unit = units.find((u) => u.code === f.businessId);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });

  const save = () =>
    run(async () => {
      const roles: Role[] = ["staff", ...(f.isManager ? (["manager"] as Role[]) : []), ...(f.isAdmin ? (["admin"] as Role[]) : [])];
      const r = await post<{ employee: Employee }>("/api/employees", {
        name: f.name,
        mobile: f.mobile,
        tempPin: f.tempPin,
        businessId: f.businessId,
        roles,
        designation: f.designation,
        managerId: managerId || null,
        joiningDate: f.joiningDate,
        committedSalaryRupees: Number(f.salary || 0),
        monthlyTargetRupees: f.target ? Number(f.target) : null,
        requiresSalesEntry: f.requiresSales,
        ...(f.aadhaar ? { aadhaarLast4: f.aadhaar } : {}),
        ...(bank.number ? { bank: { accountHolder: bank.holder, accountNumber: bank.number, ifsc: bank.ifsc } } : {}),
        ...(f.isAdmin ? { adminBusinessIds: adminUnits, canApprovePayrollFor: [] } : {}),
      });
      onCreated(r.employee.employeeId);
      onClose();
    });

  return (
    <Modal title="New employee" onClose={onClose}>
      <Field label="Business unit">
        <Select value={f.businessId} onChange={(e) => set("businessId", e.target.value)}>
          {units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Full name">
        <Input value={f.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Mobile (10 digits)">
        <Input inputMode="numeric" maxLength={10} value={f.mobile} onChange={(e) => set("mobile", e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field label="Temporary PIN (4 digits)" hint="The employee must change it on first login.">
        <Input inputMode="numeric" maxLength={4} value={f.tempPin} onChange={(e) => set("tempPin", e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field label="Designation">
        <Input value={f.designation} onChange={(e) => set("designation", e.target.value)} />
      </Field>
      <Field label="Reports to">
        <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">No manager</option>
          {managers.map((m) => (
            <option key={m.employeeId} value={m.employeeId}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Joining date">
        <Input type="date" value={f.joiningDate} onChange={(e) => set("joiningDate", e.target.value)} />
      </Field>
      <Field label="Committed monthly salary (₹)">
        <Input inputMode="numeric" value={f.salary} onChange={(e) => set("salary", e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field label="Monthly sales target (₹, optional)">
        <Input inputMode="numeric" value={f.target} onChange={(e) => set("target", e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field label="Aadhaar last 4 digits">
        <Input inputMode="numeric" maxLength={4} value={f.aadhaar} onChange={(e) => set("aadhaar", e.target.value.replace(/\D/g, ""))} />
      </Field>
      <BankFields v={bank} set={setBank} />
      {unit && unit.salesCategories.some((c) => c.active) && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.requiresSales} onChange={(e) => set("requiresSales", e.target.checked)} /> Must submit daily sales
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.isManager} onChange={(e) => set("isManager", e.target.checked)} /> Is a Manager
      </label>
      {isSuperAdmin && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.isAdmin} onChange={(e) => set("isAdmin", e.target.checked)} /> Is an Admin
          </label>
          {f.isAdmin && (
            <Field label="Units this Admin manages">
              <div className="flex flex-wrap gap-2">
                {units.map((u) => (
                  <button key={u.code} type="button" onClick={() => setAdminUnits(adminUnits.includes(u.code) ? adminUnits.filter((x) => x !== u.code) : [...adminUnits, u.code])} className={`rounded-lg px-3 py-1.5 text-sm ${adminUnits.includes(u.code) ? "bg-amber-400" : "bg-slate-100"}`}>
                    {u.code}
                  </button>
                ))}
              </div>
            </Field>
          )}
        </>
      )}
      <Notice>The employee stays "pending" until both Aadhaar sides are uploaded. Then activate them.</Notice>
      <ErrorBox message={error} />
      <Btn disabled={busy || !f.name || f.mobile.length !== 10 || f.tempPin.length !== 4} onClick={() => void save()} className="w-full">
        Create employee
      </Btn>
    </Modal>
  );
}

// ================= Employee admin detail =================
interface Pay {
  committedPaise: number;
  bank: { accountHolder: string; accountNumber: string; ifsc: string } | null;
  aadhaarLast4: string | null;
}
interface DocRow {
  docId: string;
  kind: string;
  remark: string;
  contentType: string;
}

function Documents({ id, onChanged }: { id: string; onChanged: () => void }) {
  const docs = useLoad(() => get<{ documents: DocRow[] }>(`/api/employees/${id}/documents`), [id]);
  const [kind, setKind] = useState("aadhaarFront");
  const [remark, setRemark] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();

  const upload = () =>
    run(async () => {
      const f = file.current?.files?.[0];
      if (!f) throw new Error("Choose a file first.");
      if (!["image/jpeg", "image/png", "application/pdf"].includes(f.type)) throw new Error("Only JPG, PNG or PDF files are allowed.");
      if (f.size > 10 * 1024 * 1024) throw new Error("File must be 10 MB or smaller.");
      const slot = await post<{ docId: string; uploadUrl: string }>(`/api/employees/${id}/documents/upload-url`, { kind, remark, contentType: f.type, sizeBytes: f.size, fileName: f.name });
      await uploadToSignedUrl(slot.uploadUrl, f, f.type);
      await post(`/api/employees/${id}/documents/register`, { docId: slot.docId });
      if (file.current) file.current.value = "";
      setRemark("");
      docs.reload();
      onChanged();
    });

  const view = (docId: string) =>
    run(async () => {
      const r = await get<{ url: string }>(`/api/employees/${id}/documents/${docId}/url`);
      window.open(r.url, "_blank", "noopener");
    });

  return (
    <Card>
      <h2 className="mb-2 font-semibold">Documents</h2>
      <Async state={docs}>
        {({ documents }) => (
          <div className="mb-3 space-y-1">
            {documents.length === 0 && <p className="text-sm text-slate-500">No documents uploaded.</p>}
            {documents.map((d) => (
              <button key={d.docId} type="button" onClick={() => void view(d.docId)} className="flex w-full justify-between rounded-lg bg-slate-100 px-3 py-2 text-sm">
                <span>
                  {d.kind === "aadhaarFront" ? "Aadhaar front" : d.kind === "aadhaarBack" ? "Aadhaar back" : `Other${d.remark ? `: ${d.remark}` : ""}`}
                </span>
                <span className="text-sky-700">View</span>
              </button>
            ))}
          </div>
        )}
      </Async>
      <div className="space-y-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="aadhaarFront">Aadhaar front</option>
          <option value="aadhaarBack">Aadhaar back</option>
          <option value="other">Other document</option>
        </Select>
        {kind === "other" && <Input placeholder="Remark (required)" value={remark} onChange={(e) => setRemark(e.target.value)} />}
        <input ref={file} type="file" accept="image/jpeg,image/png,application/pdf" className="block w-full text-sm" />
        <ErrorBox message={error} />
        <Btn kind="ghost" disabled={busy} onClick={() => void upload()} className="w-full">
          {busy ? "Uploading…" : "Upload"}
        </Btn>
      </div>
    </Card>
  );
}

function AssignTaskCard({ employee }: { employee: Employee }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Assign task</h2>
      <p className="mb-2 text-xs text-slate-500">Give this person a one-off or recurring task.</p>
      <Btn onClick={() => setOpen(true)} className="w-full">
        + Assign task to {employee.name}
      </Btn>
      {open && <AddTask assigneeId={employee.employeeId} allowRepeat onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />}
    </Card>
  );
}

function Advances({ id }: { id: string }) {
  const list = useLoad(() => get<{ advances: Array<{ id: string; amountPaise: number; recoveredPaise: number; date: string; note: string }> }>("/api/advances", { employeeId: id }), [id]);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Salary advances</h2>
      <Async state={list}>
        {({ advances }) => (
          <div className="mb-3 space-y-1">
            {advances.length === 0 && <p className="text-sm text-slate-500">No advances.</p>}
            {advances.map((a) => (
              <div key={a.id} className="flex justify-between text-sm">
                <span>
                  {prettyDate(a.date)} {a.note && `· ${a.note}`}
                </span>
                <span>
                  {inr(a.amountPaise)} <span className="text-xs text-slate-500">(recovered {inr(a.recoveredPaise)})</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Async>
      <div className="flex gap-2">
        <Input inputMode="numeric" placeholder="Amount ₹" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
        <Input placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <Btn
          kind="ghost"
          disabled={busy || !amount}
          onClick={() =>
            void run(async () => {
              await post("/api/advances", { employeeId: id, amountRupees: Number(amount), date: todayIST(), note });
              setAmount("");
              setNote("");
              list.reload();
            })
          }
        >
          Add
        </Btn>
      </div>
      <ErrorBox message={error} />
    </Card>
  );
}

export function EmployeeAdmin({ id }: { id: string }) {
  const me = useMe();
  const emp = useLoad(() => get<{ employee: Employee }>(`/api/employees/${id}`), [id]);
  const pay = useLoad(() => get<{ pay: Pay }>(`/api/employees/${id}/pay`), [id]);
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees"), []);
  const [edit, setEdit] = useState<{ name: string; designation: string; salary: string; managerId: string; aadhaar: string; requiresSales: boolean; start: string; end: string } | null>(null);
  const [bank, setBank] = useState<{ holder: string; number: string; ifsc: string } | null>(null);
  const [reason, setReason] = useState("");
  const [tempPin, setTempPin] = useState("");
  const [exit, setExit] = useState(false);
  const { busy, error, run } = useAction();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <PageTitle right={<button onClick={back} className="text-sm text-slate-500 underline">Back</button>}>Employee</PageTitle>
      <Async state={emp}>
        {({ employee: e }) => {
          const p = pay.data?.pay;
          const f = edit ?? { name: e.name, designation: e.designation, salary: p ? String(p.committedPaise / 100) : "", managerId: e.managerId ?? "", aadhaar: p?.aadhaarLast4 ?? "", requiresSales: e.requiresSalesEntry, start: e.shift.start, end: e.shift.end };
          const b = bank ?? { holder: p?.bank?.accountHolder ?? "", number: p?.bank?.accountNumber ?? "", ifsc: p?.bank?.ifsc ?? "" };
          const managers = (team.data?.employees ?? []).filter((m) => m.businessId === e.businessId && m.roles.some((r) => r === "manager" || r === "admin") && m.employeeId !== e.employeeId);
          return (
            <>
              <Card>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-lg font-semibold">{e.name}</div>
                    <div className="text-sm text-slate-600">
                      {e.employeeId} · {e.businessId} · {e.mobile}
                    </div>
                    <div className="text-sm text-slate-600">Joined {prettyDate(e.joiningDate)}{e.exitDate ? ` · Exit ${prettyDate(e.exitDate)}` : ""}</div>
                  </div>
                  <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn kind="ghost" onClick={() => go(`/team/emp/${id}`)} className="!px-3 !py-2">
                    Attendance & work
                  </Btn>
                  {e.status === "pending" && (
                    <Btn
                      kind="success"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await post(`/api/employees/${id}/activate`);
                          emp.reload();
                          setMsg("Employee activated.");
                        })
                      }
                      className="!px-3 !py-2"
                    >
                      Activate
                    </Btn>
                  )}
                  {e.status !== "exited" && (
                    <Btn kind="danger" onClick={() => setExit(true)} className="!px-3 !py-2">
                      Record exit
                    </Btn>
                  )}
                </div>
              </Card>
              {msg && <Notice tone="ok">{msg}</Notice>}
              <ErrorBox message={error} />

              <Card>
                <h2 className="mb-2 font-semibold">Details</h2>
                <div className="space-y-3">
                  <Field label="Name">
                    <Input value={f.name} onChange={(ev) => setEdit({ ...f, name: ev.target.value })} />
                  </Field>
                  <Field label="Designation">
                    <Input value={f.designation} onChange={(ev) => setEdit({ ...f, designation: ev.target.value })} />
                  </Field>
                  <Field label="Reports to">
                    <Select value={f.managerId} onChange={(ev) => setEdit({ ...f, managerId: ev.target.value })}>
                      <option value="">No manager</option>
                      {managers.map((m) => (
                        <option key={m.employeeId} value={m.employeeId}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Shift start">
                      <Input type="time" value={f.start} onChange={(ev) => setEdit({ ...f, start: ev.target.value })} />
                    </Field>
                    <Field label="Shift end">
                      <Input type="time" value={f.end} onChange={(ev) => setEdit({ ...f, end: ev.target.value })} />
                    </Field>
                  </div>
                  <Field label="Committed monthly salary (₹)">
                    <Input inputMode="numeric" value={f.salary} onChange={(ev) => setEdit({ ...f, salary: ev.target.value.replace(/\D/g, "") })} />
                  </Field>
                  <Field label="Aadhaar last 4">
                    <Input inputMode="numeric" maxLength={4} value={f.aadhaar} onChange={(ev) => setEdit({ ...f, aadhaar: ev.target.value.replace(/\D/g, "") })} />
                  </Field>
                  <BankFields v={b} set={setBank} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={f.requiresSales} onChange={(ev) => setEdit({ ...f, requiresSales: ev.target.checked })} /> Must submit daily sales
                  </label>
                  <Field label="Reason for change (required, audited)">
                    <Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} />
                  </Field>
                  <Btn
                    disabled={busy || !reason.trim() || (!edit && !bank)}
                    onClick={() =>
                      void run(async () => {
                        await patch(`/api/employees/${id}`, {
                          name: f.name,
                          designation: f.designation,
                          managerId: f.managerId || null,
                          shift: { start: f.start, end: f.end },
                          committedSalaryRupees: Number(f.salary || 0),
                          requiresSalesEntry: f.requiresSales,
                          ...(f.aadhaar.length === 4 ? { aadhaarLast4: f.aadhaar } : {}),
                          ...(b.number ? { bank: { accountHolder: b.holder, accountNumber: b.number, ifsc: b.ifsc } } : {}),
                          reason,
                        });
                        setReason("");
                        setEdit(null);
                        setBank(null);
                        emp.reload();
                        pay.reload();
                        setMsg("Saved.");
                      })
                    }
                    className="w-full"
                  >
                    Save changes
                  </Btn>
                </div>
              </Card>

              <Documents id={id} onChanged={() => setMsg(null)} />
              <Advances id={id} />
              <Penalties id={id} />

              <Card>
                <h2 className="mb-2 font-semibold">Reset PIN</h2>
                <div className="flex gap-2">
                  <Input inputMode="numeric" maxLength={4} placeholder="New temporary PIN" value={tempPin} onChange={(ev) => setTempPin(ev.target.value.replace(/\D/g, ""))} />
                  <Btn
                    kind="ghost"
                    disabled={busy || tempPin.length !== 4}
                    onClick={() =>
                      void run(async () => {
                        await post(`/api/employees/${id}/reset-pin`, { tempPin });
                        setTempPin("");
                        setMsg("PIN reset. Tell the employee their temporary PIN; they must change it on login.");
                      })
                    }
                  >
                    Reset
                  </Btn>
                </div>
              </Card>

              <EmpTarget employee={e} />
              <AssignTaskCard employee={e} />
              {isSuper(me) && <SuperAdminRoles employee={e} onSaved={emp.reload} />}
              {exit && <ExitModal employee={e} onClose={() => setExit(false)} onDone={emp.reload} />}
            </>
          );
        }}
      </Async>
    </div>
  );
}

function SuperAdminRoles({ employee, onSaved }: { employee: Employee; onSaved: () => void }) {
  const units = useUnits();
  const [roles, setRoles] = useState<Role[]>(employee.roles);
  const [adminUnits, setAdminUnits] = useState<string[]>(employee.adminBusinessIds);
  const [approve, setApprove] = useState<string[]>(employee.canApprovePayrollFor);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const toggleRole = (r: Role) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);
  const toggle = (list: string[], set: (v: string[]) => void, c: string) => set(list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Roles & access (Super Admin)</h2>
      <div className="mb-2 flex gap-2">
        {(["staff", "manager", "admin"] as Role[]).map((r) => (
          <button key={r} type="button" onClick={() => toggleRole(r)} className={`rounded-lg px-3 py-1.5 text-sm ${roles.includes(r) ? "bg-amber-400" : "bg-slate-100"}`}>
            {r}
          </button>
        ))}
      </div>
      {roles.includes("admin") && (
        <>
          <Field label="Units this Admin manages">
            <div className="flex flex-wrap gap-2">
              {units.data?.units.map((u) => (
                <button key={u.code} type="button" onClick={() => toggle(adminUnits, setAdminUnits, u.code)} className={`rounded-lg px-3 py-1.5 text-sm ${adminUnits.includes(u.code) ? "bg-amber-400" : "bg-slate-100"}`}>
                  {u.code}
                </button>
              ))}
            </div>
          </Field>
          <Field label="May approve payroll for">
            <div className="flex flex-wrap gap-2">
              {units.data?.units.map((u) => (
                <button key={u.code} type="button" onClick={() => toggle(approve, setApprove, u.code)} className={`rounded-lg px-3 py-1.5 text-sm ${approve.includes(u.code) ? "bg-amber-400" : "bg-slate-100"}`}>
                  {u.code}
                </button>
              ))}
            </div>
          </Field>
        </>
      )}
      <div className="mt-2 space-y-2">
        <Input placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBox message={error} />
        <Btn
          disabled={busy || !reason.trim() || roles.length === 0}
          onClick={() =>
            void run(async () => {
              await patch(`/api/employees/${employee.employeeId}`, { roles, adminBusinessIds: adminUnits, canApprovePayrollFor: approve, reason });
              setReason("");
              onSaved();
            })
          }
          className="w-full"
        >
          Save roles
        </Btn>
      </div>
    </Card>
  );
}

function ExitModal({ employee, onClose, onDone }: { employee: Employee; onClose: () => void; onDone: () => void }) {
  const team = useLoad(() => get<{ employees: Employee[] }>("/api/employees", { unit: employee.businessId }), [employee.businessId]);
  const [date, setDate] = useState(todayIST());
  const [reassign, setReassign] = useState("");
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Modal title={`Record exit: ${employee.name}`} onClose={onClose}>
      <Notice tone="warn">After the exit date this person can no longer log in. Salary is prorated automatically.</Notice>
      <Field label="Last working day">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Reassign open leads to" hint="Required only if they have open leads.">
        <Select value={reassign} onChange={(e) => setReassign(e.target.value)}>
          <option value="">Choose…</option>
          {(team.data?.employees ?? []).filter((e) => e.status === "active" && e.employeeId !== employee.employeeId).map((e) => (
            <option key={e.employeeId} value={e.employeeId}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Reason (required)">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Btn
        kind="danger"
        disabled={busy || !reason.trim()}
        onClick={() =>
          void run(async () => {
            await post(`/api/employees/${employee.employeeId}/exit`, { exitDate: date, reason, ...(reassign ? { leadReassignTo: reassign } : {}) });
            onDone();
            onClose();
          })
        }
        className="w-full"
      >
        Confirm exit
      </Btn>
    </Modal>
  );
}

// ================= Business units =================
function UnitEditor({ unit, onSaved }: { unit: BusinessUnit; onSaved: () => void }) {
  const [name, setName] = useState(unit.name);
  const [active, setActive] = useState(unit.active);
  const [lat, setLat] = useState(unit.location ? String(unit.location.lat) : "");
  const [lng, setLng] = useState(unit.location ? String(unit.location.lng) : "");
  const [radius, setRadius] = useState(unit.location ? String(unit.location.radiusMeters) : "100");
  const [start, setStart] = useState(unit.defaultShift.start);
  const [end, setEnd] = useState(unit.defaultShift.end);
  const [cats, setCats] = useState<SalesCategory[]>(unit.salesCategories);
  const [holidays, setHolidays] = useState(unit.holidays);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  const setCat = (i: number, p: Partial<SalesCategory>) => setCats(cats.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const addCat = () => setCats([...cats, { id: `cat${Date.now().toString(36)}`, name: "", type: "amount", active: true, order: cats.length }]);

  const save = () =>
    run(async () => {
      await patch(`/api/units/${unit.code}`, {
        name,
        active,
        defaultShift: { start, end },
        ...(lat && lng ? { location: { lat: Number(lat), lng: Number(lng), radiusMeters: Number(radius) } } : {}),
        salesCategories: cats.map((c, i) => ({ ...c, order: i })),
        holidays,
        reason,
      });
      setReason("");
      setSaved(true);
      onSaved();
    });

  const useMyLocation = () =>
    navigator.geolocation.getCurrentPosition((p) => {
      setLat(String(p.coords.latitude));
      setLng(String(p.coords.longitude));
    });

  const [mapText, setMapText] = useState("");
  const [mapMsg, setMapMsg] = useState<string | null>(null);
  /** Reads coordinates from a Google Maps link ("@11.1,77.3", "!3d..!4d..", "?q=lat,lng") or pasted "lat, lng". */
  const applyMapText = (text: string) => {
    setMapText(text);
    const t = decodeURIComponent(text.trim());
    const m =
      /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(t) ??
      /@(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(t) ??
      /[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(t) ??
      /^\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*$/.exec(t);
    if (m?.[1] && m[2]) {
      setLat(m[1]);
      setLng(m[2]);
      setMapMsg(`Location set: ${m[1]}, ${m[2]}. Check it with "Open in Google Maps", then Save.`);
    } else if (t) {
      setMapMsg(/goo\.gl|maps\.app/.test(t) ? "Short links cannot be read. Open the link, then copy the full address-bar link, or long-press the pin and copy the coordinates." : "Could not find coordinates in that text.");
    } else setMapMsg(null);
  };

  return (
    <Card>
      <h2 className="mb-2 font-semibold">
        {unit.name} ({unit.code})
      </h2>
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
        </label>
        <Field label="Google Maps location (paste a Maps link or coordinates)">
          <Input placeholder="https://www.google.com/maps/@11.1085,77.3411,17z   or   11.1085, 77.3411" value={mapText} onChange={(e) => applyMapText(e.target.value)} />
        </Field>
        {mapMsg && <p className="text-xs text-slate-600">{mapMsg}</p>}
        {mapsEnabled && (
          <div>
            <div className="mb-1 text-xs text-slate-600">Click the map (or drag the pin) on the shop entrance.</div>
            <MapPicker
              lat={lat ? Number(lat) : null}
              lng={lng ? Number(lng) : null}
              radius={Number(radius) || 100}
              onPick={(la, lo) => {
                setLat(String(la));
                setLng(String(lo));
              }}
            />
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Latitude">
            <Input value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Longitude">
            <Input value={lng} onChange={(e) => setLng(e.target.value)} />
          </Field>
          <Field label="Radius (100-200 m)">
            <Input inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ""))} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <button type="button" onClick={useMyLocation} className="text-sm text-sky-700 underline">
            Use my current location
          </button>
          <a href="https://www.google.com/maps" target="_blank" rel="noreferrer" className="text-sm text-sky-700 underline">
            Open Google Maps to find the shop
          </a>
          {lat && lng && (
            <a href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer" className="text-sm text-sky-700 underline">
              Open in Google Maps (check pin)
            </a>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Default shift start">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Default shift end">
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-slate-600">Sales categories</div>
          <div className="space-y-2">
            {cats.map((c, i) => (
              <div key={c.id} className="flex items-center gap-2">
                <Input placeholder="Name" value={c.name} onChange={(e) => setCat(i, { name: e.target.value })} />
                <Select value={c.type} onChange={(e) => setCat(i, { type: e.target.value as "amount" | "count" })} className="!w-28">
                  <option value="amount">₹ amount</option>
                  <option value="count">Count</option>
                </Select>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={c.active} onChange={(e) => setCat(i, { active: e.target.checked })} /> on
                </label>
              </div>
            ))}
          </div>
          <button type="button" onClick={addCat} className="mt-1 text-sm text-sky-700 underline">
            + Add category
          </button>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-slate-600">Holidays</div>
          {holidays.map((h, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <Input type="date" value={h.date} onChange={(e) => setHolidays(holidays.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
              <Input placeholder="Name" value={h.name} onChange={(e) => setHolidays(holidays.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <button type="button" className="text-red-600" onClick={() => setHolidays(holidays.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setHolidays([...holidays, { date: todayIST(), name: "" }])} className="text-sm text-sky-700 underline">
            + Add holiday
          </button>
        </div>

        <Field label="Reason for change (required)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        {saved && <Notice tone="ok">Saved.</Notice>}
        <Btn disabled={busy || !reason.trim()} onClick={() => void save()} className="w-full">
          Save unit
        </Btn>
      </div>
    </Card>
  );
}

function LostReasons() {
  const r = useLoad(() => get<{ reasons: string[] }>("/api/settings/lost-reasons"), []);
  const [text, setText] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Card>
      <h2 className="mb-2 font-semibold">Lead "Lost" reasons</h2>
      <Async state={r}>
        {({ reasons }) => (
          <div className="space-y-2">
            <Textarea rows={6} value={text ?? reasons.join("\n")} onChange={(e) => setText(e.target.value)} />
            <p className="text-xs text-slate-500">One reason per line. "Other" is always kept.</p>
            <ErrorBox message={error} />
            <Btn
              kind="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await put("/api/settings/lost-reasons", { reasons: (text ?? reasons.join("\n")).split("\n").map((s) => s.trim()).filter(Boolean) });
                  setText(null);
                  r.reload();
                })
              }
            >
              Save reasons
            </Btn>
          </div>
        )}
      </Async>
    </Card>
  );
}

export function Units() {
  const me = useMe();
  const units = useUnits();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="space-y-3">
      <PageTitle>Business units</PageTitle>
      <Async state={units}>
        {({ units: list }) => (
          <>
            {list.map((u) => (
              <UnitEditor key={u.code} unit={u} onSaved={units.reload} />
            ))}
          </>
        )}
      </Async>
      <LostReasons />
      {isSuper(me) && (
        <Card>
          <h2 className="mb-2 font-semibold">Add a business unit</h2>
          <div className="flex gap-2">
            <Input placeholder="Code (e.g. XY)" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="!w-28" />
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Btn
              kind="ghost"
              disabled={busy || !code || !name}
              onClick={() =>
                void run(async () => {
                  await post("/api/units", { code, name });
                  setCode("");
                  setName("");
                  units.reload();
                })
              }
            >
              Add
            </Btn>
          </div>
          <ErrorBox message={error} />
        </Card>
      )}
    </div>
  );
}

// ================= Audit log =================
export function Audit() {
  const [entity, setEntity] = useState("");
  const [entityId, setEntityId] = useState("");
  const logs = useLoad(() => get<{ logs: Array<{ id: string; at: string; actorId: string; action: string; entity: string; entityId: string; reason?: string; before: unknown; after: unknown }> }>("/api/audit", { entity: entity || undefined, entityId: entityId || undefined, limit: "100" }), [entity, entityId]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <PageTitle>Audit log</PageTitle>
      <div className="flex gap-2">
        <Input placeholder="Entity (e.g. employees)" value={entity} onChange={(e) => setEntity(e.target.value)} />
        <Input placeholder="Entity ID" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
      </div>
      <Async state={logs}>
        {({ logs: l }) => (
          <div className="space-y-2">
            {l.map((x) => (
              <Card key={x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>
                <div className="flex justify-between text-sm">
                  <b>{x.action}</b>
                  <span className="text-xs text-slate-500">{dateTimeIST(x.at)}</span>
                </div>
                <div className="text-xs text-slate-600">
                  {x.actorId} → {x.entity}/{x.entityId}
                  {x.reason ? ` · ${x.reason}` : ""}
                </div>
                {open === x.id && (
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs">{JSON.stringify({ before: x.before, after: x.after }, null, 2)}</pre>
                )}
              </Card>
            ))}
            {l.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nothing logged.</p>}
          </div>
        )}
      </Async>
    </div>
  );
}

// ================= Super Admin overview =================
interface OverviewUnit {
  unit: string;
  name: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  tasks: { assigned: number; done: number };
  followUpsDue: number;
  salesByCategory: Record<string, number>;
  payroll: { month: string; salary: string; incentive: string } | null;
}

export function Overview() {
  const d = useLoad(() => get<{ dateIST: string; units: OverviewUnit[] }>("/api/dashboard/overview"), []);
  return (
    <div className="space-y-3">
      <PageTitle>All business units</PageTitle>
      <Async state={d}>
        {({ units }) => (
          <div className="space-y-3">
            {units.map((u) => (
              <Card key={u.unit}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-semibold">{u.name}</h2>
                  {u.payroll && (
                    <button type="button" onClick={() => go(`/admin/payroll?unit=${u.unit}&month=${u.payroll?.month}`)}>
                      <Badge tone={u.payroll.salary === "draft" ? "amber" : "green"}>
                        Payroll {u.payroll.salary}/{u.payroll.incentive}
                      </Badge>
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <Stat label="Present" value={u.present} tone="green" onClick={() => go(`/team/today`)} />
                  <Stat label="Late" value={u.late} tone={u.late ? "red" : undefined} onClick={() => go(`/team/today`)} />
                  <Stat label="Absent" value={u.absent} tone={u.absent ? "red" : undefined} onClick={() => go(`/team/today`)} />
                  <Stat label="Leave" value={u.onLeave} onClick={() => go(`/team/leave`)} />
                </div>
                <div className="mt-2 text-sm text-slate-600">
                  Tasks {u.tasks.done}/{u.tasks.assigned} · Follow-ups due {u.followUpsDue}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
