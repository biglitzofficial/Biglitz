import { AuthProvider, isAdminish, isManagerish, isSuper, useAuth, useMe } from "./auth";
import { go, useRoute } from "./router";
import { Spinner } from "./ui";
import { ChangePin, Login } from "./screens/Login";
import { Home } from "./screens/Home";
import { Punch } from "./screens/Punch";
import { SalesToday } from "./screens/Sales";
import { Tasks } from "./screens/Tasks";
import { LeadDetail, Leads } from "./screens/Leads";
import { Attendance } from "./screens/Attendance";
import { Achievements, Leave, More, Payslips, Profile } from "./screens/Me";
import { EmployeeDrill, Team } from "./screens/Team";
import { Audit, EmployeeAdmin, Employees, Overview, Units } from "./screens/Admin";
import { Payroll, Reports } from "./screens/Payroll";

function navFor(me: ReturnType<typeof useMe>): Array<{ path: string; label: string; icon: string; match: string }> {
  const home = { path: "/", label: "Home", icon: "🏠", match: "" };
  const more = { path: "/more", label: "More", icon: "☰", match: "more" };
  const team = { path: "/team/today", label: "Team", icon: "👥", match: "team" };
  if (isSuper(me)) return [{ ...home, label: "Overview" }, team, { path: "/admin/payroll", label: "Payroll", icon: "💰", match: "admin/payroll" }, { path: "/admin/employees", label: "People", icon: "🧑‍💼", match: "admin/employees" }, more];
  if (isAdminish(me)) return [home, team, { path: "/admin/employees", label: "People", icon: "🧑‍💼", match: "admin/employees" }, { path: "/admin/payroll", label: "Payroll", icon: "💰", match: "admin/payroll" }, more];
  if (isManagerish(me)) return [home, team, { path: "/tasks", label: "My tasks", icon: "✅", match: "tasks" }, { path: "/leads", label: "Leads", icon: "📞", match: "leads" }, more];
  return [home, { path: "/tasks", label: "Tasks", icon: "✅", match: "tasks" }, { path: "/leads", label: "Leads", icon: "📞", match: "leads" }, { path: "/attendance", label: "Attendance", icon: "📅", match: "attendance" }, more];
}

function sideFor(me: ReturnType<typeof useMe>): Array<{ path: string; label: string; icon: string; match: string }> {
  const items = [
    { path: "/", label: isSuper(me) ? "Overview" : "My home", icon: "🏠", match: "" },
    { path: "/team/today", label: "Team today", icon: "👥", match: "team" },
    { path: "/admin/employees", label: "People", icon: "🧑‍💼", match: "admin/employees" },
    { path: "/admin/payroll", label: "Payroll", icon: "💰", match: "admin/payroll" },
    { path: "/admin/reports", label: "Reports", icon: "📊", match: "admin/reports" },
    { path: "/admin/units", label: "Business units", icon: "🏪", match: "admin/units" },
  ];
  if (isSuper(me)) items.push({ path: "/admin/audit", label: "Audit log", icon: "🧾", match: "admin/audit" });
  items.push({ path: "/profile", label: "Profile & PIN", icon: "⚙️", match: "profile" });
  return items;
}

function Denied() {
  return <p className="p-6 text-center text-sm text-slate-500">You do not have access to this page.</p>;
}

function Shell() {
  const me = useMe();
  const route = useRoute();
  const [a = "", b, c] = route.parts;
  const key = route.parts.join("/");
  const mgr = isManagerish(me);
  const adm = isAdminish(me);

  let screen;
  switch (a) {
    case "":
      screen = isSuper(me) ? <Overview /> : <Home />;
      break;
    case "punch":
      screen = <Punch kind={b === "out" ? "out" : "in"} />;
      break;
    case "tasks":
      screen = <Tasks />;
      break;
    case "leads":
      screen = b ? <LeadDetail id={b} /> : <Leads />;
      break;
    case "sales":
      screen = <SalesToday />;
      break;
    case "attendance":
      screen = <Attendance />;
      break;
    case "leave":
      screen = <Leave />;
      break;
    case "payslips":
      screen = <Payslips />;
      break;
    case "achievements":
      screen = <Achievements />;
      break;
    case "profile":
      screen = <Profile />;
      break;
    case "more":
      screen = <More />;
      break;
    case "team":
      screen = !mgr ? <Denied /> : b === "emp" && c ? <EmployeeDrill key={c} id={c} /> : <Team tab={b ?? "today"} />;
      break;
    case "admin":
      if (!adm) screen = <Denied />;
      else if (b === "employees") screen = c ? <EmployeeAdmin key={c} id={c} /> : <Employees />;
      else if (b === "units") screen = <Units />;
      else if (b === "payroll") screen = <Payroll />;
      else if (b === "reports") screen = <Reports />;
      else if (b === "audit") screen = isSuper(me) ? <Audit /> : <Denied />;
      else screen = <Denied />;
      break;
    default:
      screen = <Denied />;
  }

  const nav = navFor(me);
  const hideNav = a === "punch";
  const side = sideFor(me);
  return (
    <div className={`min-h-screen bg-slate-100 pb-20 ${adm ? "md:pb-0" : ""}`}>
      <header className="sticky top-0 z-20 bg-slate-900 px-4 py-3 text-white">
        <div className={`mx-auto flex max-w-xl items-center justify-between ${adm ? "md:max-w-none" : "md:max-w-3xl"}`}>
          <button type="button" onClick={() => go("/")} className="font-bold text-amber-400">
            Biglitz Team
          </button>
          <span className="text-xs text-slate-300">
            {me.employee.name} · {me.unit.code}
          </span>
        </div>
      </header>
      <div className={adm ? "md:flex" : ""}>
        {adm && (
          <aside className="hidden min-h-[calc(100vh-3rem)] w-56 shrink-0 border-r bg-white md:block">
            <nav className="sticky top-12 space-y-1 p-3">
              {side.map((n) => {
                const active = n.match === "" ? key === "" : key === n.match || key.startsWith(`${n.match}/`);
                return (
                  <button
                    key={n.path}
                    type="button"
                    onClick={() => go(n.path)}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${active ? "bg-amber-100 font-semibold text-amber-800" : "text-slate-700 hover:bg-slate-100"}`}
                  >
                    <span>{n.icon}</span>
                    {n.label}
                  </button>
                );
              })}
            </nav>
          </aside>
        )}
        <main key={key} className={`mx-auto w-full max-w-xl p-4 ${adm ? "md:mx-0 md:max-w-6xl md:p-6" : "md:max-w-3xl"}`}>
          {screen}
        </main>
      </div>
      {!hideNav && (
        <nav className={`fixed inset-x-0 bottom-0 z-10 border-t bg-white pb-[env(safe-area-inset-bottom)] ${adm ? "md:hidden" : ""}`}>
          <div className="mx-auto flex max-w-xl">
            {nav.map((n) => {
              const active = n.match === "" ? key === "" : key === n.match || key.startsWith(`${n.match}/`);
              return (
                <button key={n.label} type="button" onClick={() => go(n.path)} className={`flex flex-1 flex-col items-center py-2 text-xs ${active ? "font-semibold text-amber-600" : "text-slate-500"}`}>
                  <span className="text-lg leading-none">{n.icon}</span>
                  {n.label}
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}

function Gate() {
  const { me, ready } = useAuth();
  if (!ready) return <Spinner label="Starting…" />;
  if (!me) return <Login />;
  if (me.mustChangePin) return <ChangePin forced />;
  return <Shell />;
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
