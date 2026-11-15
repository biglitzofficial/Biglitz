# Super Admin guide (one page)

**Overview (Home):** every business unit on one screen: present, late, absent, on leave, tasks done, follow-ups due, and last month's payroll status. Tap any number to open the list.

**Admins:** People → open an employee → *Roles & access*. Give the Admin role, choose the units they manage, and choose which units they may approve payroll for. Only you can do this.

**Business units:** you alone can add a new unit (More → Business units → Add). Set its location, shift and sales categories afterwards.

**Payroll approval:** Payroll → choose unit and month → review → **Approve & lock** for salary and for incentive separately. *Send back* returns it to draft. Approval locks attendance, leave and sales for that month.

**Audit log (More → Audit log):** every change to employees, salary, targets, corrections, advances, units and payroll with who, when, before/after and the reason. Only you can see it.

**First-time setup (once):**
1. Create the Firebase project (Blaze plan, budget alert ₹500) and the Railway services.
2. Set the environment variables listed in `.env.example`.
3. Run `npm run seed` with `SUPERADMIN_MOBILE` and `SUPERADMIN_PIN` set; this creates the 5 units and your Super Admin account.
4. Log in, change the PIN, set each unit's GPS location, then add Admins and staff.

**Automatic jobs (every 5 minutes dispatcher):** late alerts, morning summary, follow-up reminders, recurring tasks, nightly day close (scores, ranks, streaks), payroll draft on the 1st, monthly rewards. They are safe to re-run; nothing is duplicated.
