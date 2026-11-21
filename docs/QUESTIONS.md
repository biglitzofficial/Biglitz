# Questions for Boobalan

Defaults from spec Section 16 awaiting confirmation:

1. Missing punch-out -> present but not on time (8.1).
2. Partial-month salary formula for joiners/leavers (8.3).
3. Advance larger than salary -> net 0, rest carried forward (8.3).
4. Round-robin when nobody eligible -> normal order + Manager alerted (10.4).
5. Monthly rewards -> one ranking across all units (8.8).
6. Count-type categories (InBody, Ice bath, Steam) not in incentive for v1 (8.6).
7. GPS accuracy limit 100 m (8.1).

Gaps found while reading the spec:

8. Section 8.1 says "punch-out time >= shift end" for on-time, but 8.8 says rewards/streak depend on on-time days; confirm that early leave breaks the streak (spec implies yes).
9. Section 7.4: "login disabled from the next day" - confirm it means the day after the exit date (test 17 implies yes).
10. Payslip PDF "generated after both are approved" (8.6) but salary is paid on the 5th and incentive on the 10th - confirm staff see no PDF until the incentive is approved.

11. Unit GPS coordinates (lat/lng) for BM, F6G1, F6G2, GZ, FB are not in the spec. Seeded as null; punch-in is blocked for a unit until set.
12. Default shift for all seeded units is 09:30-22:00 (the spec example). Confirm per unit.

Assumptions made while building (each is a one-line change if you decide otherwise):

13. Badge criteria (spec names only): Never late = at least one present day this month and no late day; Full attendance = every eligible day of a finished month present (1.0); 30-day streak = on-time streak of 30 or more; No unapproved leave 100 = 100 consecutive eligible days with no absence or late leave application.
14. An approved half-day leave does not break the on-time streak.
15. Monthly rewards for month M (5000/3000/1000) are added as bonus lines to M's payroll draft. If that draft is already submitted/approved they are not added; they stay visible on the Achievements screen.
16. A lead whose source has no pool (and no "all" pool) stays unassigned and is visible to the unit's Managers.
17. A monthly recurring task on day 31 falls back to the month's last day in shorter months.
18. The "all units" leaderboard is served by the API; Firestore rules limit direct reads to the user's own unit.
19. A payroll line for someone with zero attendance still gets the 2 free-leave bonus days from the spec formula (P + (32-D)*E/D), exactly as written.
20. Admin reports (Section 11.3) are computed from the same day-level data as payroll; the attendance trend counts a person as present for any day with a punch-in.
21. The app has no offline punching: GPS and a live camera selfie are always required online (spec 11.1.2). The camera/GPS code is isolated in apps/web/src/lib/device.ts so it can be swapped for a native shell later.
22. Lead intake bursts are applied one at a time per pool within an API instance (verified: 100 simultaneous leads spread evenly over 50 staff in about 6 s). Run a single API instance on Railway unless you need more.
23. **Staff fines / penalties** are not in the master spec. Today only Admins/Super Admin can deduct money via Payroll → draft → "Salary adjustment (Deduct)". Confirm: (a) Is that the fine feature? (b) Should Managers also add fines for their team? (c) Should fines be a separate record (amount, date, reason) deducted automatically like advances, instead of a one-off payroll adjustment?
