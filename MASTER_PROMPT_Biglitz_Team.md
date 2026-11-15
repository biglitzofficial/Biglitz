# MASTER PROMPT — Biglitz Team (HR, Payroll, Attendance, Tasks, Leads)

> **For Suthiks (Cursor):** Save this file in the repo as `docs/MASTER_SPEC.md`. Add a Cursor rule (`.cursor/rules/spec.mdc`, always applied) that says: *"docs/MASTER\_SPEC.md is the single source of truth. Never invent a business rule. If something is not specified, stop and list it as a question for Boobalan."* Then give Cursor the prompt in Section 0 and build phase by phase (Section 14). Do not start a phase until the previous phase's acceptance tests pass.

Owner: Boobalan (Super Admin) · Version 1.0 · 15 Nov 2026

---

## 0\. Prompt to paste into Cursor (Agent mode)

```
You are a senior software architect and full-stack engineer. You are building a production
HR, payroll, attendance, task and lead-management app called "Biglitz Team" for a group of
small businesses in Tirupur, Tamil Nadu, India.

docs/MASTER_SPEC.md is the complete and only specification. Read all of it before writing code.

Rules for how you work:
1. Follow the spec exactly. Never invent, guess or "improve" a business rule. If a rule is
   missing or two rules conflict, stop and write the question in docs/QUESTIONS.md.
2. Build in the phase order of Section 14. At the end of each phase, run every acceptance
   test listed for that phase and show the results. Do not move on while any test fails.
3. All money, salary, incentive and score calculations run ONLY on the server (backend),
   never in the browser. The client only displays results.
4. Write unit tests for every calculation in Section 8 using the exact examples given.
5. TypeScript strict mode everywhere. Validate every API input with zod. No "any".
6. All times are stored as UTC timestamps and all business-day logic uses Asia/Kolkata.
7. All money is stored as integer paise. Convert to rupees only for display.
8. Every create/update/delete of HR or money data writes an audit log entry.
9. Before writing code for a phase, write a short plan (files, collections, endpoints,
   tests) and wait for confirmation.
Start with Phase 0.
```

---

## 1\. What we are building

One app for all of Boobalan's businesses. Each staff member uses it daily on an Android phone to punch in and out, see tasks and leads, enter daily sales, apply for leave, and see their earnings, rank and payslips. Managers, Admins and the Super Admin use it to assign work, approve leave, run payroll and see performance dashboards.

The app must **motivate** staff: at punch-out they see what they earned today; every day they see salary building up, their discipline rank and streaks.

**First release covers five business units:**

| Business unit | Code | Example employee ID |
| :---- | :---- | :---- |
| Boys Mobiles Head Office | BM | 26BM001 |
| FITO6 Fitness Studio 1 | F6G1 | 26F6G1001 |
| FITO6 Fitness Studio 2 | F6G2 | 26F6G2001 |
| Gyroz Studio | GZ | 26GZ001 |
| FitoBowl | FB | 26FB001 |

More business units (for example Casifly, code CF) are added later from the app. Nothing may be hard-coded per business; every business-specific value is a setting.

**Out of scope for v1:** franchise stores (separate project on hold), PF, ESI, professional tax, TDS, iOS testing, native app store release, Tamil language.

---

## 2\. Tech stack (decided — do not change)

| Layer | Choice |
| :---- | :---- |
| Frontend | React \+ Vite \+ TypeScript, Tailwind CSS, installable **PWA** (manifest \+ service worker), mobile-first, Android Chrome is the target browser. English UI only. |
| Hosting (frontend) | Firebase Hosting at [**https\://team.biglitz.in**](https://team.biglitz.in) (domain DNS is on GoDaddy). |
| Backend API | Node.js \+ TypeScript (Fastify or Express) on **Railway**. Uses Firebase Admin SDK. |
| Database | Cloud Firestore. |
| Files (selfies, documents, payslip PDFs) | Cloud Storage for Firebase. **Requires the Blaze (pay-as-you-go) plan; free usage still applies on Blaze.** Set a budget alert of ₹500/month in Google Cloud Billing. |
| Auth | Firebase Authentication with **custom tokens** minted by the backend after mobile number \+ PIN check (Section 5). No SMS OTP (to avoid SMS cost). |
| Scheduled jobs | Railway cron service(s). Railway cron is evaluated in **UTC**; convert IST times (IST \= UTC+5:30). Minimum interval 5 minutes. Each cron run must exit when done and be idempotent. |
| WhatsApp alerts | Backend calls an **n8n webhook** (self-hosted n8n on Railway: `https://n8n-production-5db3.up.railway.app`); n8n sends via ChakraHQ WhatsApp templates. Backend never talks to ChakraHQ directly. |
| Lead intake | n8n calls the backend lead-intake endpoint (Section 10.4). |
| PDF | Server-side payslip PDF (e.g. pdf-lib or Puppeteer), stored in Cloud Storage. |
| Repo | GitHub, owner account boys.boobalan. |

Accounts (Firebase, Railway, GitHub) are owned by boys.boobalan; the developer works with editor access.

---

## 3\. Non-negotiable engineering rules

1. **Server is the source of truth.** Clients can read their permitted data directly from Firestore (security rules enforce scope) but every **write** that changes HR, attendance, leave, sales, payroll, incentive, leads or tasks goes through the backend API. Firestore rules deny all client writes except where Section 12 allows.  
2. **Money \= integer paise.** Percentages stored as basis points (1.5% \= 150 bps). Round only at the final step, to the nearest rupee (half up), and store the rounding difference on the payslip line.  
3. **Time:** store `Timestamp` (UTC). A "business date" is computed in Asia/Kolkata and stored as `YYYY-MM-DD` string (`dateIST`) on every attendance, sales and leave record.  
4. **Idempotency:** punch-in, punch-out, sales submit, lead intake and every cron job must be safe to repeat (use deterministic document IDs such as `{employeeId}_{dateIST}`).  
5. **Transactions:** employee ID counters, round-robin pointers, payroll locking and leave approval use Firestore transactions.  
6. **Audit log:** every change to employees, salary, targets, slabs, attendance corrections, leave decisions, sales corrections, payroll and permissions writes `auditLogs` with who, when, before, after, reason.  
7. **Locked periods:** once a month's payroll is approved and locked, attendance/leave/sales for that month cannot change. A correction after lock is recorded as an adjustment line in the next month's payroll.  
8. **Validation:** zod schemas shared between frontend and backend (shared package).  
9. **Errors:** every API error returns `{ code, message }` with a clear human message; the UI shows it. No silent failures.  
10. **Tests:** unit tests for every formula in Section 8 using the examples given; integration tests for the flows in Section 15\.  
11. **Performance:** app must work on a mid-range Android phone on 4G. Home screen loads in under 3 seconds.  
12. **Offline:** if there is no network at punch-in/out, show a clear error and retry button. Do not queue punches offline (prevents faked times).

---

## 4\. Roles, hierarchy and permissions

Hierarchy: **Staff → Manager → Admin → Super Admin.** Each level sees data of everyone below it in its scope, never above. One person may hold more than one role (e.g. a unit head is both Admin and Manager for that unit).

| Role | Who | Scope |
| :---- | :---- | :---- |
| Super Admin | Boobalan only | All business units, everything |
| Admin | Created by Super Admin | Only the business units assigned to them |
| Manager | Created by Super Admin or Admin | Only staff who report to them (`managerId`) |
| Staff | Everyone else | Only themselves |

Permission matrix (✓ \= allowed, within scope):

| Action | Super Admin | Admin | Manager | Staff |
| :---- | :---- | :---- | :---- | :---- |
| Create/edit business units & settings | ✓ | ✓ (assigned units, cannot create new units) |  |  |
| Create Admins, assign units, set Admin permissions | ✓ |  |  |  |
| Create/edit employees (incl. Managers), set salary, hours, target, slabs | ✓ | ✓ |  |  |
| Set target & incentive slabs for own team | ✓ | ✓ | ✓ |  |
| View employee documents | ✓ | ✓ |  | Own only |
| Approve/reject leave | ✓ | ✓ | ✓ |  |
| Correct attendance / sales entries (with reason) | ✓ | ✓ | ✓ |  |
| Assign tasks | ✓ | ✓ | ✓ | Self only |
| Assign leads, set round-robin pools | ✓ | ✓ | ✓ | Add own leads |
| Give salary advance | ✓ | ✓ |  |  |
| Prepare payroll | ✓ | ✓ |  |  |
| Approve & lock payroll / incentive | ✓ | Only if Super Admin granted `canApprovePayroll` for that unit |  |  |
| See other staff's salary | ✓ | ✓ |  | Never |

Staff can never see another person's salary, incentive amount, documents or leave reasons. Ranks, badges and streaks are visible to everyone in the same business unit.

---

## 5\. Login

1. Admin creates the employee with mobile number (10 digits, Indian) and a temporary 4-digit PIN.  
2. Staff opens team.biglitz.in, enters mobile \+ PIN → backend checks against stored **hash** (bcrypt/argon2) → backend mints a Firebase custom token with claims `{ employeeId, roles[], businessIds[], managerOf? }` → client calls `signInWithCustomToken`.  
3. First login forces PIN change. PIN \= exactly 4 digits; reject 0000, 1234 and the last 4 digits of the mobile number.  
4. 5 wrong PINs → account locked 15 minutes; Admin can reset PIN.  
5. Inactive (exited) employees cannot log in.  
6. Role/scope changes take effect at next token refresh; backend re-checks roles from Firestore on every API call (claims are a convenience, not the authority).  
7. Session stays logged in on the phone (Firebase persistence) until logout or PIN reset.

---

## 6\. Business unit settings

Each business unit document holds:

- `name`, `code` (unique, uppercase, 2–6 chars, letters/digits), `active`  
- `location`: lat, lng, `radiusMeters` (allowed 100–200)  
- `defaultShift`: start time, end time (e.g. 09:30–22:00)  
- `salesCategories[]`: `{ id, name, type: "amount" | "count", active, order }`  
- `holidays[]` (for display only in v1; pay rules do not use them)  
- `idCounter` (running number, see 7.1)  
- `admins[]`

Initial sales categories (seed data):

| Unit | Categories (type) |
| :---- | :---- |
| BM | New mobiles (amount), Second-hand mobiles (amount), Accessories (amount), Service (amount) |
| F6G1, F6G2 | New membership (amount), New PT (amount), Membership renewal (amount), PT renewal (amount), Diet plan (amount), InBody tests (count), Ice bath (count), Steam (count) |
| FB | Confirmed food orders (amount), Subscriptions (amount) |
| GZ | Shoots (amount), Editing (amount), Podcast shoots (amount) |

Categories can be added, renamed, reordered or deactivated later. Deactivated categories keep their history.

---

## 7\. Employees

### 7.1 Employee ID (fixed rule)

`employeeId = YY + businessCode + NNN`

- `YY` \= last two digits of the **date of joining** year.  
- `businessCode` \= the unit code.  
- `NNN` \= the unit's running number, zero-padded to 3 digits (4+ digits once it passes 999). It **never resets** — not each year, not ever — so it also shows how many people the unit has hired in total.  
- Example: BM hires its 14th person in 2025 → `25BM014`; the next hire in 2026 → `26BM015`.  
- Generated in a Firestore transaction by incrementing the unit's `idCounter`. IDs are never reused, even after exit or deletion.  
- Back-dated joining dates are allowed (YY follows the joining date entered).

### 7.2 Employee fields

Name, mobile (unique across the whole app), photo, business unit, role(s), designation, `managerId`, date of joining, date of exit (nullable), status (active / exited), **own shift** (start, end — defaults to unit shift, editable per employee), committed monthly salary (paise), monthly sales target (paise, nullable), incentive slabs (Section 8.6), bank account details (account holder, account number, IFSC), PIN hash.

### 7.3 Documents

- **Aadhaar card is mandatory** — an employee cannot be saved as active without it (front and back, image or PDF).  
- Any number of optional supporting documents, each uploaded with a **remark** describing it (e.g. "Bank passbook", "Offer letter").  
- Stored in Cloud Storage under `employees/{employeeId}/documents/`. Max 10 MB per file; JPG, PNG, PDF only.  
- Visible only to Super Admin, Admins of that unit, and the employee themself. Never to Managers or other staff. Download links are short-lived signed URLs from the backend.  
- Store only the last 4 digits of Aadhaar as text; never store the full number as a field.

### 7.4 Exit

Admin sets date of exit → login disabled from the next day; the employee is removed from lead pools and task assignment; their open leads are reassigned (Manager chooses); final payroll computed for the partial month (8.3) and their incentive is still paid on the 10th.

---

## 8\. Business rules and formulas (implement exactly; unit-test with these examples)

### 8.1 Attendance (punch-in / punch-out)

- **Punch-in:** allowed only if the phone's GPS position is within the unit's `radiusMeters` of the unit location (haversine distance) and GPS `accuracy` ≤ 100 m. A **live selfie** from the camera (no gallery upload) is required. Server records server time (never trust device time), lat, lng, accuracy, distance, selfie path.  
- One punch-in and one punch-out per employee per `dateIST`. Second punch-in on the same day is rejected with a message.  
- **Punch-out:** same GPS rule and selfie. Before punch-out the **daily sales entry** (8.5) must be submitted (staff in units with sales categories). After punch-out, show the "Today you earned" screen (8.8).  
- **On time:** punch-in time ≤ employee's shift start (exact to the minute, **no grace**; 09:30:59 counts as 09:30, 09:31 is late) **and** punch-out time ≥ employee's shift end.  
- **Early leave:** punch-out before shift end → not an on-time day.  
- **Missing punch-out (default — confirm with Boobalan):** if no punch-out by 23:59 IST, the day is marked `present, missingPunchOut` (counts as present, not on-time). Manager can correct with a reason.  
- **Half day:** set only by an approved half-day leave request, or by a Manager/Admin attendance correction. Counts 0.5 present and is never an on-time day.  
- **Absent:** no punch-in and no approved full-day leave for that date.  
- Mock-location limitation: a web app cannot reliably detect Android mock-location apps. Mitigations in v1: live selfie with server timestamp, accuracy check, Manager can see each punch's map pin and selfie. (A later Android wrapper via Capacitor can add mock-location detection — do not build now, but keep the camera/GPS code in one module so it can be swapped.)

### 8.2 Leave

- Staff apply in the app: date(s), full day or half day, reason.  
- **2-day rule:** if applied at least **2 calendar days before** the leave date (apply date ≤ leave date − 2, compared on `dateIST`) **and approved** → **approved leave**. If applied 1 day before, same day, or not applied → counts as **absent** for discipline (even if a Manager approves it, it is marked `lateApplication`).  
- Approved by the employee's Manager, or any Admin of the unit, or Super Admin. Approver sees the 2-day status before deciding.  
- For **payroll**, every leave day — approved or not — counts as a leave day (8.3).  
- For **discipline score**, approved leave days are removed from working days (they do not hurt the score); all other non-present days count as absent.

### 8.3 Salary (monthly, paid on the 5th)

Definitions for a calendar month:

- `D` \= days in the month (28–31)  
- `E` \= eligible days \= days from max(1st of month, joining date) to min(last day of month, exit date), inclusive. `E = D` for a full month.  
- `P` \= days present within the eligible days (half day \= 0.5)  
- `L` \= leave days \= `E − P` (approved and unapproved both count)  
- `perDay` \= committed monthly salary ÷ 30 (always 30, whatever the month)

**Full month (E \= D):** `Salary = committed + (2 − L) × perDay`

- Zero leave → 2 days extra. 2 leave → exactly committed salary. Each leave beyond 2 → one day's pay less. Same result in 28-, 30- and 31-day months.

**General formula (works for full and partial months):** `payableDays = P + (32 − D) × E ÷ D` `Salary = perDay × payableDays` (floor at 0\)

Unit-test examples (committed ₹15,000, perDay ₹500):

| Month days D | Leave L | Payable days | Salary |
| :---- | :---- | :---- | :---- |
| 28, 30 or 31 | 0 | 32 | ₹16,000 |
| 28, 30 or 31 | 1 | 31 | ₹15,500 |
| 28, 30 or 31 | 2 | 30 | ₹15,000 |
| 28, 30 or 31 | 4 | 28 | ₹14,000 |
| 30, joined on 16th (E \= 15), present 15 | 0 | 16 | ₹8,000 |
| 31, joined on 17th (E \= 15), present 15 | 0 | 15.484 | ₹7,742 (rounded) |

(Partial-month proration is a default — list it in QUESTIONS.md for Boobalan to confirm.)

**Deductions:**

- No PF, ESI, professional tax or TDS.  
- **Salary advance:** Admin records an advance (amount, date, note) any time. The **full** outstanding advance is deducted from the next salary run. If the salary is smaller than the advance, deduct up to the salary (net \= 0\) and carry the rest to the next month (default — confirm).  
- Adjustments: Admin can add a positive or negative adjustment line with a mandatory reason.

`Net salary = Salary − advance recovery ± adjustments`, rounded to the nearest rupee.

### 8.4 Payroll run

1. On the 1st of each month at 06:00 IST, a cron job creates a **draft payroll** for the previous month for each unit (status `draft`).  
2. Admin reviews per employee: present days, leave days, payable days, salary, advance recovery, adjustments, net. Admin can edit attendance (with reason) → draft recalculates.  
3. Admin submits → status `submitted`.  
4. Super Admin (or an Admin with `canApprovePayroll` for that unit) approves → status `approved`, month **locked**.  
5. System generates **salary bank transfer list** (CSV: name, account number, IFSC, amount) for payment on the 5th, and the salary part of each payslip.  
6. Status `paid` is set manually after the bank transfer.

### 8.5 Daily sales entry (at punch-out)

- Screen lists every active category of the staff member's unit, in order. Each needs a value: amount in ₹ (whole rupees, ≥ 0\) or count (integer ≥ 0).  
- A **"No sales today"** button sets every category to 0 after a confirmation dialog ("Confirm: no sales today?"). The zeros are saved as real data.  
- Punch-out is blocked until the entry is submitted.  
- One entry per employee per `dateIST`. Staff can edit their own entry until 23:59 IST that day; after that only Manager/Admin can correct it (with reason, audited).  
- Staff in units or roles with no sales categories skip this step (setting per employee: `requiresSalesEntry`, default true when the unit has categories).

### 8.6 Incentive (monthly, paid on the 10th)

- Every sales staff member has a **monthly target** (₹) and **incentive slabs**, set by their Manager or an Admin. Whatever they set is final.  
- `Monthly sales` \= sum of all **amount-type** category values for the month. Count-type categories are **not** included in incentive in v1.  
- `Achievement %` \= monthly sales ÷ target × 100\.  
- Slabs: ordered list of `{ fromAchievementPct, ratePctOfSales }`. The highest slab whose `fromAchievementPct` ≤ achievement applies to the **whole** month's sales.  
- Default slabs (pre-filled, editable per employee):

| Achievement | Incentive |
| :---- | :---- |
| below 80% | 0% |
| 80% to 99.99% | 1% of monthly sales |
| 100% and above | 1.5% of monthly sales |

Unit-test examples (target ₹3,00,000):

- Sales ₹3,20,000 → 106.67% → 1.5% → **₹4,800**  
- Sales ₹2,50,000 → 83.33% → 1% → **₹2,500**  
- Sales ₹2,00,000 → 66.67% → 0% → **₹0**  
- Sales ₹2,40,000 → exactly 80% → 1% → **₹2,400**

Flow: incentive draft is created with the payroll draft; approved separately; paid on the **10th** with its own bank transfer list. Staff who exit before the 10th are still paid their incentive. **One payslip per month** shows both salary (paid 5th) and incentive (paid 10th); the payslip PDF is generated after both are approved.

### 8.7 Discipline score and rank

For a month (or month-to-date, up to yesterday):

- `Working days` \= eligible days so far − approved leave days (full \= 1, half \= 0.5)  
- `Attendance %` \= days present ÷ working days × 100  
- `Punctuality %` \= on-time days ÷ days present × 100 (0 if no days present)  
- `Discipline Score` \= (Attendance % \+ Punctuality %) ÷ 2, one decimal place  
- **Rank** by Discipline Score only (sales never affect rank). Ties: longer current on-time streak first, then earlier average punch-in time.  
- Ranks shown within each business unit and across all units.

Test: 26 working days, present 25, on-time 24 → Attendance 96.2, Punctuality 96.0 → **96.1**. Present 23, on-time 20 → 88.5 and 87.0 → **87.7**.

### 8.8 Motivation features

- **"Today you earned"** (after punch-out): today's earned salary \= perDay (half day \= perDay ÷ 2\) \+ today's incentive estimate (incentive rate currently reached × today's amount sales). Label the incentive part "estimated".  
- **Salary so far this month:** perDay × days present to date.  
- **Projected salary this month:** the 8.3 formula assuming the employee is present every remaining day of the month. Below it: "Leave days used: X of 2 free" (red when above 2).  
- **On-time streak:** consecutive on-time working days (approved leave days don't break it; absent or late breaks it).  
- **Badges** (computed nightly): "Never late this month", "Full attendance month", "30-day on-time streak", "100 days without unapproved leave".  
- **Monthly rewards:** top 3 Discipline Scores win ₹5,000 / ₹3,000 / ₹1,000 (default: one ranking across all units — confirm). Shown on an Achievements screen; payout is recorded as a bonus line in the next payroll.

---

## 9\. Tasks

- Fields: title, description, assignee, assignedBy, business unit, due date/time, priority (low/normal/high), status (todo / done), repeat (none / daily / weekly on chosen weekday / monthly on day N / month-end), createdAt, doneAt.  
- Managers/Admins assign to anyone in scope; staff can create **self-assigned** tasks.  
- Recurring tasks: a nightly cron (00:05 IST) creates the next occurrence; the template stays. Example seeds: "Morning report 9:30 AM" (daily), "Stock audit" (weekly Friday).  
- Overdue \= not done and past due. Staff mark done; Manager can reopen.  
- Staff dashboard: today's tasks (done / total), pending, overdue, completed this month.  
- Manager dashboard: same per team member \+ **"No task right now"** list (punched-in staff with zero open tasks).  
- WhatsApp alert to the assignee when a task is assigned (via n8n).

---

## 10\. Leads (CRM)

### 10.1 Lead fields

Name, phone (normalised to `+91XXXXXXXXXX`), interest/notes, source (manual, lead sheet, WhatsApp, ads, other), business unit, assignee, status, temperature (hot/warm/cold, for Follow-up), `nextFollowUpDate` (dateIST), closed value (₹, required for Closed won), lost reason (required for Lost), history (every status change with who/when/note).

### 10.2 Status flow

`New → Contacted → Follow-up (Hot / Warm / Cold) → Closed won (sale value) | Lost (reason)` Lost reasons (editable list): Price too high, Bought elsewhere, Not reachable, Just enquiring, Other (note required).

### 10.3 Follow-up

Staff tap a lead → change status → set next follow-up date. On that date the lead appears in **Today's leads**; past dates show in **Overdue follow-ups**. Leads dashboard counts: today's follow-ups, overdue, total, closed won, lost, open (not closed), closed value this month.

### 10.4 Automatic intake \+ round-robin

- `POST /api/leads/intake` (called by n8n). Auth: header `X-Intake-Secret` (env var). Body: name, phone, source, businessCode, poolId (optional), notes, externalId (optional, for idempotency).  
- **Dedup:** if an open or closed lead with the same normalised phone exists in that business unit → do not create a new lead; add a history note "Enquired again via {source}", reset status to Follow-up if it was Lost, and alert its current assignee.  
- **Round-robin pools:** a pool \= business unit \+ source (or "all sources") \+ ordered list of staff, set by a Manager/Admin. Each pool keeps a pointer. A new lead goes to the next staff member in order (transaction updates the pointer).  
- **Skip absent:** staff who are not punched in today, are on leave, or have punched out are skipped (setting per pool, default ON). If nobody is eligible: the lead goes to the next person in normal order anyway and the pool's Manager is alerted (default — confirm).  
- Assignee gets a WhatsApp alert with name, phone and source.

---

## 11\. Screens

### 11.1 Staff (Android phone)

1. **Home:** big Punch in / Punch out button with today's state; today's tasks (done/total); today's follow-ups; today's sales; salary so far this month; discipline rank in unit \+ gap to next rank ("0.8 points to \#2"); on-time streak.  
2. **Tasks:** Today / Pending / Overdue / Done tabs; add self task.  
3. **Leads:** Today's leads, Overdue, All (filter by status); add lead; lead detail with status change and next follow-up date.  
4. **Punch-out flow:** sales entry (or "No sales today") → selfie → "Today you earned" screen.  
5. **Attendance calendar:** colours for on-time, late/early, half day, approved leave, absent, missing punch-out.  
6. **Leave:** apply (shows whether it meets the 2-day rule), status list.  
7. **Payslips:** monthly PDF list.  
8. **Achievements:** badges, streak, unit leaderboard (rank \+ name \+ score only), monthly winners.  
9. **Profile:** employee ID, own details, own documents (view), change PIN, logout.

### 11.2 Manager

Team Today (who punched in, late, absent, on leave, not reported sales), team tasks, team leads and follow-ups, team sales by category (today / month), leave approvals, attendance & sales corrections, round-robin pool setup, targets & slabs for team, team discipline ranking.

### 11.3 Admin (phone and laptop)

Everything a Manager sees for all assigned units, plus: employees (create/edit/exit, documents, salary, shift, PIN reset), business unit settings and categories, salary advances, payroll draft → submit, incentive draft → submit, payroll approval if permitted, reports (payroll cost per unit, attendance trend, discipline ranking, sales by category, leads funnel).

### 11.4 Super Admin

All units on one screen: present / late / absent / on leave counts per unit today, tasks done vs assigned, follow-ups due, today's sales by unit and category, payroll status per unit; create Admins and assign units and permissions; approve payroll and incentive; audit log viewer.

Every list supports search; every number on a dashboard opens the underlying list.

---

## 12\. Data model (Firestore) and security

Suggested collections (adjust names if needed, keep the shape):

Firestore security rules cannot hide individual fields, so data with different visibility lives in **separate documents**:

```
businessUnits/{code}
employees/{employeeId}                      // profile, roles, scope, managerId, shift (no money, no bank, no PIN)
employeePay/{employeeId}                    // committed salary, bank details   -> self + Admin/Super Admin only
employeeTargets/{employeeId}                // monthly target, incentive slabs  -> self + Manager + Admin/Super Admin
leaderboards/{unitCode}_{YYYY-MM}           // public fields only: name, photo, score, rank, streak, badges
employees/{employeeId}/documents/{docId}
authPins/{employeeId}                       // pinHash, failedAttempts, lockedUntil  (backend only)
attendance/{employeeId}_{dateIST}           // punchIn, punchOut, gps, selfies, status, onTime, halfDay, corrections[]
leaveRequests/{id}
dailySales/{employeeId}_{dateIST}           // values per categoryId, noSales flag, submittedAt, corrections[]
tasks/{id}
leads/{id}
leads/{id}/history/{id}
leadPools/{id}                              // unit, source, staff order, pointer, skipAbsent
advances/{id}
payrollRuns/{unitCode}_{YYYY-MM}            // status, totals, approvals
payrollRuns/{runId}/lines/{employeeId}      // all inputs + outputs of 8.3/8.6, rounding
payslips/{employeeId}_{YYYY-MM}             // pdf path
scores/{employeeId}_{YYYY-MM}               // discipline score, rank, streak, badges (nightly)
notificationsLog/{id}
jobRuns/{jobName}_{slot}                    // cron idempotency
auditLogs/{id}
settings/global
```

Security rules (deny by default):

- Staff read: own `employees`, `employeePay`, `employeeTargets`, attendance, sales, leave, tasks, leads, payslips, scores; their unit's `leaderboards` docs. Never another person's `employees` doc.  
- Manager read: `employees`, `employeeTargets`, attendance, sales, leave, tasks, leads and scores of employees whose `managerId` is them. **Never `employeePay`.**  
- Admin read: everything within assigned units except `authPins`.  
- Super Admin read: everything except `authPins`.  
- **No client writes to any collection in v1.** All writes go through the backend API. Selfie and document uploads use short-lived signed upload URLs issued by the backend.  
- Storage rules: deny by default; access only via backend signed URLs.

---

## 13\. Scheduled jobs (Railway cron, UTC shown with IST)

Railway runs one cron schedule per service, in UTC, minimum every 5 minutes. Use **one dispatcher cron service** scheduled `*/5 * * * *` that checks the job table below (in IST) and runs every job that is due and has not yet run for that slot (record each run in `jobRuns/{jobName}_{slot}` so a job never runs twice).

| Job | When (IST) | What it does |
| :---- | :---- | :---- |
| Late punch-in alerts | Every 5 min, 05:30–14:00 | For each employee whose own shift start \+ 15 min has passed today and who has not punched in and is not on approved leave: WhatsApp their Manager. Once per employee per day. |
| Morning summary | 09:45 daily | WhatsApp to Super Admin and each Admin: present / late / absent / on leave per unit |
| Follow-up reminder | 10:00 daily | WhatsApp each staff member their count of today's and overdue follow-ups |
| Recurring tasks | 00:05 daily | Create next occurrences |
| Day close | 00:15 daily | Finalise yesterday: absent, missing punch-out, streaks, badges, discipline scores, leaderboards, overdue follow-up flags |
| Payroll & incentive draft | 06:00 on the 1st | Create drafts for the previous month |
| Monthly rewards | 06:30 on the 1st | Compute top 3, create bonus lines in the new drafts |

All jobs idempotent and logged.

---

## 14\. Delivery phases (each ends with its acceptance tests passing and a demo link)

**Phase 0 — Setup (day 1):** repo, monorepo (web, api, shared), Firebase project on Blaze with budget alert, Firestore, Storage, Hosting on team.biglitz.in, Railway API service \+ one dispatcher cron service (every 5 min), env vars, CI (lint, typecheck, tests), seed script for the 5 units and categories.

**Phase 1 — Foundation (days 1–3):** login (mobile \+ PIN, custom token), roles and scope, business units, employees with ID generation, documents upload, attendance punch in/out with GPS \+ selfie, Today screens for Staff/Manager/Admin/Super Admin, audit log.

**Phase 2 — Daily work (days 3–5):** daily sales entry at punch-out with "No sales today", tasks (incl. recurring), leads with follow-ups, intake endpoint, round-robin pools, dedup, WhatsApp alerts via n8n, dashboards for tasks/leads/sales.

**Phase 3 — Leave and motivation (days 5–6):** leave with 2-day rule, half day, attendance calendar, discipline score, ranks, streaks, badges, "Today you earned", salary so far.

**Phase 4 — Payroll and incentive (days 6–8):** advances, payroll draft/submit/approve/lock, incentive slabs and approval, bank transfer CSVs, payslip PDF, monthly rewards.

**Phase 5 — Hardening (days 8–10):** full test run, security rules tests (Firebase emulator), load test with 50 users, bug fixes, user guide (1 page per role).

**Go-live plan:** Phases 1–3 go live for daily use as soon as they pass. Payroll runs in **parallel** with the current manual method for one full month; go live for pay only when net pay matches for every employee.

---

## 15\. Acceptance tests (must all pass)

1. Create BM employee joining 2026 when BM counter is 14 → ID `26BM015`; counter becomes 15; two simultaneous creates never get the same ID.  
2. Back-dated joiner (2025) in the same unit → `25BM016`.  
3. Punch-in 120 m from location with radius 100 m → rejected with distance shown. At 80 m → accepted.  
4. Shift 09:30–22:00: punch-in 09:30:45 → on time; 09:31:00 → late. Punch-out 21:55 → not on time.  
5. Second punch-in same day → rejected.  
6. Punch-out without sales entry → blocked. "No sales today" → all categories saved as 0\.  
7. Leave applied on the 10th for the 12th and approved → approved leave; applied on the 11th for the 12th → late application, counts absent for discipline.  
8. Salary examples in 8.3 → exact amounts.  
9. Advance ₹3,000 with salary ₹15,000 → net ₹12,000. Advance ₹20,000 with salary ₹15,000 → net ₹0, carry ₹5,000.  
10. Incentive examples in 8.6 → exact amounts.  
11. Discipline examples in 8.7 → 96.1 and 87.7; tie broken by streak.  
12. Round-robin with order A → B → C, B on leave: leads go A, C, A, C. Same phone again → no new lead, history note added, assignee alerted.  
13. Staff cannot read another staff member's employee doc, salary, documents or payslip; a Manager cannot read `employeePay` of their team (rules tests in the Firebase emulator).  
14. Manager cannot see staff outside their team; Admin cannot see units not assigned.  
15. After payroll approval, editing that month's attendance via API → rejected with "Month locked".  
16. Every cron job run twice in a row → no duplicates.  
17. Exited employee cannot log in the day after exit date.

---

## 16\. Defaults chosen in this spec — confirm with Boobalan (write answers in QUESTIONS.md)

1. Missing punch-out → present but not on time (8.1).  
2. Partial-month salary formula for joiners/leavers (8.3).  
3. Advance larger than salary → net 0, rest carried forward (8.3).  
4. Round-robin when nobody eligible → normal order \+ Manager alerted (10.4).  
5. Monthly rewards → one ranking across all units (8.8).  
6. Count-type categories (InBody, Ice bath, Steam) not in incentive for v1 (8.6).  
7. GPS accuracy limit 100 m (8.1).

---

## 17\. Definition of done

- All acceptance tests pass; unit-test coverage of `/shared/calc` \= 100%.  
- Works on two different Android phones in Chrome, installed as PWA.  
- Seed data loaded for the 5 units; Boobalan can log in as Super Admin.  
- Every screen in Section 11 exists and shows real data.  
- A one-page guide per role (Staff, Manager, Admin, Super Admin).  
- No open items in QUESTIONS.md.