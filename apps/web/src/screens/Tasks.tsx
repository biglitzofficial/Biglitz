import { useState } from "react";
import { get, post } from "../lib/api";
import { dateTimeIST, istLocalToIso } from "../lib/format";
import type { Task } from "../lib/types";
import { Async, Badge, Btn, Card, ErrorBox, Field, Input, Modal, PageTitle, Select, Tabs, Textarea, useAction, useLoad } from "../ui";

type Tab = "today" | "pending" | "overdue" | "done";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function AddTask({ assigneeId, allowRepeat, onClose, onSaved }: { assigneeId?: string; allowRepeat: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("normal");
  const [repeat, setRepeat] = useState("none");
  const [weekday, setWeekday] = useState("1");
  const [day, setDay] = useState("1");
  const { busy, error, run } = useAction();

  const save = () =>
    run(async () => {
      const rep =
        repeat === "weekly" ? { kind: "weekly", weekday: Number(weekday) } : repeat === "monthly" ? { kind: "monthly", day: Number(day) } : { kind: repeat };
      await post("/api/tasks", {
        title,
        description,
        ...(assigneeId ? { assigneeId } : {}),
        dueAt: due ? istLocalToIso(due) : null,
        priority,
        repeat: rep,
      });
      onSaved();
      onClose();
    });

  return (
    <Modal title="New task" onClose={onClose}>
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Details (optional)">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Due (optional)">
        <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <Field label="Priority">
        <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </Select>
      </Field>
      {allowRepeat && (
        <>
          <Field label="Repeat">
            <Select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly (day of month)</option>
              <option value="monthEnd">Month end</option>
            </Select>
          </Field>
          {repeat === "weekly" && (
            <Field label="Weekday">
              <Select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {repeat === "monthly" && (
            <Field label="Day of month" hint="If the month is shorter, the last day is used.">
              <Input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, ""))} />
            </Field>
          )}
        </>
      )}
      <ErrorBox message={error} />
      <Btn disabled={busy || !title.trim()} onClick={() => void save()} className="w-full">
        Add task
      </Btn>
    </Modal>
  );
}

export function TaskList({ employeeId, canManage, allowRepeat }: { employeeId?: string; canManage: boolean; allowRepeat: boolean }) {
  const [tab, setTab] = useState<Tab>("today");
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => get<{ tasks: Task[] }>("/api/tasks", { tab, employeeId }), [tab, employeeId]);
  const { error, run } = useAction();

  const act = (id: string, what: "done" | "reopen") => run(async () => {
    await post(`/api/tasks/${id}/${what}`);
    list.reload();
  });

  return (
    <div>
      <Tabs<Tab>
        tabs={[
          { id: "today", label: "Today" },
          { id: "pending", label: "Pending" },
          { id: "overdue", label: "Overdue" },
          { id: "done", label: "Done" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <ErrorBox message={error} />
      <Async state={list}>
        {(d) => (
          <div className="space-y-2">
            {d.tasks.length === 0 && <p className="p-4 text-center text-sm text-slate-500">No tasks here.</p>}
            {d.tasks.map((t) => (
              <Card key={t.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className={`font-medium ${t.status === "done" ? "text-slate-400 line-through" : ""}`}>{t.title}</div>
                    {t.description && <div className="text-sm text-slate-600">{t.description}</div>}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.dueAt && <Badge tone={t.status === "todo" && new Date(t.dueAt) < new Date() ? "red" : "slate"}>Due {dateTimeIST(t.dueAt)}</Badge>}
                      {t.priority === "high" && <Badge tone="amber">High</Badge>}
                      {t.repeat.kind !== "none" && <Badge tone="blue">Recurring</Badge>}
                    </div>
                  </div>
                  {t.status === "todo" ? (
                    <Btn kind="success" onClick={() => void act(t.id, "done")} className="!px-3 !py-2">
                      Done
                    </Btn>
                  ) : (
                    canManage && (
                      <Btn kind="ghost" onClick={() => void act(t.id, "reopen")} className="!px-3 !py-2">
                        Reopen
                      </Btn>
                    )
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
      <div className="mt-3">
        <Btn onClick={() => setAdding(true)} className="w-full">
          + Add task
        </Btn>
      </div>
      {adding && <AddTask {...(employeeId ? { assigneeId: employeeId } : {})} allowRepeat={allowRepeat} onClose={() => setAdding(false)} onSaved={list.reload} />}
    </div>
  );
}

export function Tasks() {
  return (
    <div>
      <PageTitle>My tasks</PageTitle>
      <TaskList canManage={false} allowRepeat={false} />
    </div>
  );
}
