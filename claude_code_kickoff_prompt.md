# Claude Code Kickoff Prompt — Trucking Cost Calculator v2.0

Copy everything below the line into Claude Code as your first message, with
PRD_trucking_calculator_v2.md placed in the repo root.

---

Read PRD_trucking_calculator_v2.md in the repo root completely before writing any code. It is the single source of truth — it encodes a validated Google Sheets prototype including bugs already found and design decisions already made. Do not "improve" decisions marked as validated (cost formulas in §2, table-first lookup in §3.2, ruled-out providers in §4.4) without asking me first.

## Confirmed business facts (treat as ground truth)

- The entire fleet is uniform: 5-axle tractor-trailer, 40 t GVW, Euro 6. Toll vehicle profile is ONE global config entry, never per-variant (PRD §4.3).
- Fleet variants differ only in monthly leasing cost: standard cooler €2,750 / mega COOL €4,500 / mega curtain €3,200.
- Users are Polish; number inputs must accept comma as decimal separator. All money is EUR, 2 decimals.
- Month denominator is fixed at 30 days for all prorations. Not calendar-aware. Do not change.

## Stack

React + TypeScript + Vite + Tailwind frontend; Node/Fastify backend; SQLite for now via a repository layer that lets us swap to Postgres later without rewriting queries; simple email+password auth with roles dispatcher / finance / admin. Single docker-compose for local dev.

## Build order — one phase per session, stop after each for my review

**Phase 1 — Domain core (no UI, no API).**
Implement the cost calculation engine as a pure, fully-typed module: fuel, tolls, fleet, drivers, overhead, ferries/tunnels, total, optional P&L (PRD §2). Write unit tests that reproduce the validated reference case from the prototype: route WAW-PRG, 680 km, 1 day, 1 driver, tolls €137.00, fuel consumption 28 L/100 km at €1.40/L must yield fuel €266.56 and (with the old €3,500 fleet cost and €1,122 overhead) match the prototype totals. Then parameterize with current config values. If any test disagrees with the PRD formulas, the PRD wins — flag it, don't silently adjust.

**Phase 2 — Data layer + migrations + seed.**
Schema per PRD §5.2 including route_country_toll with status estimate|verified and the calculations snapshot column. Write the import script skeleton for the v1 Google Sheet export (I will provide CSVs of the Trasy and Konfiguracja tabs) and the 113-airport dataset.

**Phase 3 — HERE integration (server-side only).**
Routing proxy per PRD §4: transportMode=truck, via waypoints, spans=countryCode, return=summary,polyline,tolls. Use the official @here/flexpolyline package — do NOT hand-roll the polyline decoder (PRD §4.2 documents the version-byte bug that bit us). ISO alpha-3→alpha-2 mapping. Toll estimates parsed per country, stored as status=estimate with the vehicle profile snapshot. API key comes from environment variable only; assert at startup that it is set; it must never reach the client bundle. Verify current HERE parameter names against their docs before implementing — do not trust the PRD's indicative spellings blindly.

**Phase 4 — Calculator screen.**
Mirror the validated sheet layout (PRD §5.3). Table-first lookup with explicit confirmation before any HERE call; on route-not-found, reset ALL derived fields before repopulating (PRD §5.4 — this was a real stale-toll bug in v1). Route status indicator: from database / from HERE unverified / new route. Fleet variant is a select, never free text.

**Phase 5 — Route DB screen, verification workflow, config screen, history.**
Toll estimate→verified promotion with audit fields; "estimates pending" filter; finance-editable config; calculation history with frozen snapshots.

## Rules

- After each phase: run tests, show me a summary of what was built and any deviations from the PRD, then STOP and wait.
- Every failure state gets an explicit user-facing message — no silent errors, no raw exception text in the UI (the v1 sheet's #ERROR! cascades are exactly what we're escaping).
- Ask rather than assume whenever the PRD and my instructions seem to conflict.

Start with Phase 1 now.
