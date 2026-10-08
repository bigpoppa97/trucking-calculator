# PRD: Trucking Cost Calculator — Web Application
## Version 2.0 — Based on Validated Google Sheets Prototype

---

## 1. Context & Background

### 1.1 What this is
A web application for calculating break-even costs and P&L margins for individual freight orders on airport-to-airport trucking routes across Central and Eastern Europe.

### 1.2 Why v2.0 exists
Version 1 was implemented as a Google Sheets workbook with Apps Script (HERE API integration). It is **fully functional and validated in production use**. This PRD describes its evolution into a web application. The Sheets prototype proved the business logic; this document encodes everything learned, including bugs found and design decisions validated.

**Reasons for migrating from Sheets to web app:**
- HERE API key is exposed in Apps Script source to anyone with sheet access → must be server-side
- Locale-dependent formula bugs (Polish locale uses `;` separators; `setFormula()` vs `setFormulaLocal()` caused silent `#ERROR!` failures)
- Script-written values silently overwrite formulas (C17 toll cell), creating stale-data hazards
- Free-text vs dropdown mismatches broke calculations (e.g. "Standard" vs "standard cooler" → `#N/A` cascading to total)
- No audit trail of who calculated what, when
- Multi-user concurrent editing risks in Sheets

### 1.3 Users
- **Dispatchers / operations managers** — calculate break-even before quoting a price; several times daily
- **Finance team** — update monthly overhead figures; review margins

---

## 2. Core Domain Logic (VALIDATED — do not change without business sign-off)

### 2.1 Cost components

Order total cost = Fuel + Highways + Fleet + Drivers + Overhead + Ferries/Tunnels

| Component | Formula | Notes |
|---|---|---|
| **Fuel** | `total_km × (consumption/100) × fuel_price` | Defaults: 28 L/100km, €1.40/L. Both configurable. |
| **Highways (tolls)** | `Σ toll_per_country` from route DB | **MANUAL VALUES ONLY** — see §4.3 |
| **Fleet (tabor)** | `(order_days / month_days) × monthly_fleet_cost` | Per fleet variant, see §2.2 |
| **Drivers** | `order_days × 160 × driver_count` | Rate €160/day configurable; drivers ∈ {1, 2} |
| **Overhead (inne)** | `(order_days / month_days) × monthly_overhead` | Static monthly figure set by finance (currently ~€3,012/month — confirm current value at build time; the config value is the source of truth) |
| **Ferries/Tunnels** | Manual EUR input per order | e.g. Helsinki ferry €220, Mont Blanc €450 |

**P&L (optional):** if revenue entered → `profit = revenue − total_cost`, `margin % = profit / revenue`.

**Denominator convention:** `month_days` config entry, finance-editable, integer 1–31, default **24**. Not calendar-aware. *(Revised 2026-07 by business sign-off; the original v2.0 decision fixed it at 30.)* Saved calculation snapshots are frozen and unaffected by later changes.

### 2.2 Fleet variants

| Variant | Monthly cost (EUR) |
|---|---|
| standard cooler | 2,750 |
| mega COOL | 4,500 |
| mega curtain | 3,200 |

Selectable per order via dropdown. Costs editable in admin config. More variants may be added later — model as a table, not an enum.

### 2.3 Tracked countries
Km and tolls are tracked per-country for: **EE, LV, LT, PL, DE, CZ, SK, HU, AT**. Other countries encountered on a route (e.g. FI) are displayed but not stored in dedicated columns. Schema must allow adding tracked countries without migration pain — use a normalized `route_country_km` table, not wide columns.

---

## 3. Route Management (the heart of the app)

### 3.1 Route identity
- Route ID format: hyphen-separated IATA codes, 2+ stops: `WAW-FRA`, `WAW-BER-FRA`, `TLL-RIX-WAW-BUD`
- Validation regex: `^[A-Z]{3}(-[A-Z]{3})+$`
- Airport database: ~113 European airports with IATA code, name, city, country, lat/lon (dataset exists from v1 — import it; originally derived from OurAirports public domain data)

### 3.2 Table-first lookup (CRITICAL architecture decision)
When a dispatcher enters a route:

1. **Check route database first.** If found → return stored total km, per-country km, per-country tolls. **No API call.** Display data with source indicator "from database".
2. **If not found** → show explicit confirmation: "Route not in database. Query HERE API?" Only call HERE on user confirmation.
3. **After HERE returns** → display results, offer "Save to route database". Saved routes have toll values = 0/empty, flagged as "tolls pending" until someone fills them in.
4. **Stale-data rule:** when a route is not found, all previously displayed values (especially tolls) MUST be cleared/reset. (This was a real bug in v1: old toll values lingered after a failed lookup.)

Rationale: HERE is called **exactly once per route, ever**. Saves API quota (1,000 req/month free tier), gives instant responses for known routes, and lets manually verified data take precedence over API estimates.

### 3.3 Manual override
Dispatchers must be able to manually override total km and per-country km on any route. **Reason:** routing APIs don't know company-preferred border crossings (e.g. we use Kudowa-Zdrój for PL→CZ). HERE's WAW-PRG estimate may differ from the company's actual driven distance. Manual values, once entered, are authoritative.

---

## 4. HERE API Integration (specifications validated in v1)

### 4.1 Request
```
GET https://router.hereapi.com/v8/routes
  ?apikey={KEY}                          ← SERVER-SIDE ONLY, never in client bundle
  &transportMode=truck
  &origin={lat},{lon}
  &destination={lat},{lon}
  &via={lat},{lon}                       ← repeat per intermediate stop
  &return=summary,polyline
  &spans=countryCode
```

### 4.2 Response processing (hard-won details)
- `summary.length` is in **metres** → divide by 1000
- Multi-stop routes return **multiple sections** — iterate ALL sections and sum
- Country codes come as **ISO 3166-1 alpha-3** (`POL`, `DEU`) → convert to alpha-2 (`PL`, `DE`); mapping table exists in v1 code
- Per-country km is derived by decoding the **HERE Flexible Polyline** and computing haversine distances between consecutive points within each `spans` range
- **⚠️ Flexible Polyline decoder gotcha:** the encoded string starts with a VERSION BYTE (character `'1'`) that must be skipped BEFORE reading the precision header. Failing to skip it corrupts the precision factor and produces distances inflated ~100,000× (v1 bug: 29,075,298 km for Poland). Use the official `@here/flexpolyline` npm package rather than hand-rolling.

### 4.3 Toll automation: estimate-then-verify model
Toll values use a **trust tier system**. For 40t trucks, all six core toll countries (DE, PL, CZ, SK, HU, AT) use distance-based electronic tolling — well suited to API estimation. Baltic states (EE, LV, LT) use time-based truck charges; if the company holds period passes, marginal cost is ~€0 — default Baltic estimates to 0 with manual override.

**Tiers:**
1. **verified** — human-confirmed against invoice/EETS contract rate. Authoritative; always used when present.
2. **estimate** — auto-fetched from HERE in the SAME routing call (`return=tolls` added to `return=summary,polyline` — zero extra quota). Shown in amber, labeled "estimate — unverified". Used in calculations only when no verified value exists; calculation output flags estimate-based tolls.
3. **missing** — calculation proceeds with a visible warning.

**Request additions** (verify exact param names against current HERE docs at build time):
`truck[axleCount]`, `truck[grossWeight]`, `tolls[emissionType]`, `currency=EUR`.
**CONFIRMED (business input):** the entire fleet is uniform — 5-axle tractor-trailer combinations, Euro 6, 40t GVW. The toll vehicle profile is therefore a SINGLE global config entry (`toll_vehicle_profile` in the config table), NOT a per-fleet-variant attribute. Fleet variants differ only in monthly leasing cost.

**Verification workflow:** finance reviews estimates against invoices → "accept" promotes estimate to verified (with audit: who, when, source) or corrects the value. Route DB view has a "tolls: estimates pending verification" filter.

**Known residual gaps (why the verify tier exists):** EETS contract rates differ from list prices by a few %; tariff updates (typically January) can lag in HERE data; PLN/CZK/HUF→EUR conversion varies daily; actual driven route may deviate. Expected estimate accuracy: ±5% for distance-based countries.

**Still ruled out:** scraping ASFINAG's web calculator (JS-rendered, no public API, ToS prohibits automation) — unnecessary now, since HERE covers Austrian GO-Maut for trucks.

### 4.4 Providers explicitly ruled out
- **OpenRouteService**: 20-second response times, API parameter drift between versions (`countries` → `countryinfo` rename broke integration mid-development), coordinate snapping failures (error 2010), 502 outages, ~12% distance error on WAW-PRG. Do not revisit.
- **Google Maps Routes API**: no truck profile, no free commercial tier
- **PTV/Trimble**: enterprise pricing unjustified at this scale

---

## 5. Application Architecture

### 5.1 Stack (recommended)
- **Frontend:** React + TypeScript, Vite, TailwindCSS
- **Backend:** Node.js (Express or Fastify) or Next.js API routes — REQUIRED to proxy HERE calls and hold the API key
- **Database:** PostgreSQL (SQLite acceptable for MVP if deployment is single-instance)
- **Auth:** simple email+password or magic-link; small team (<20 users); roles: `dispatcher`, `finance`, `admin`
- **Deployment:** single Docker container or Vercel/Railway; low traffic

### 5.2 Data model (normalized)
```
airports(iata PK, name, city, country, lat, lon)
routes(id PK, route_code UNIQUE, stops JSONB, total_km, km_source ENUM(here|manual), created_by, created_at)
route_country_km(route_id FK, country CHAR(2), km NUMERIC)
route_country_toll(route_id FK, country CHAR(2), toll_eur NUMERIC,
                   status ENUM(estimate|verified), fetched_at, vehicle_profile JSONB,
                   verified_by NULL, verified_at NULL)
fleet_variants(id PK, name UNIQUE, monthly_cost_eur, active BOOL)
config(key PK, value)                     -- fuel_price, consumption, driver_day_rate, monthly_overhead, month_days (default 24, editable)
calculations(id PK, route_id FK, days, drivers, fleet_variant_id FK, ferries_eur, tunnels_eur,
             revenue_eur NULL, snapshot JSONB, created_by, created_at)
```
`calculations.snapshot` stores the full cost breakdown at calculation time — config changes must not retroactively alter saved calculations.

### 5.3 Key screens
1. **Calculator** (main) — mirrors the validated sheet layout: route input with autocomplete, days, drivers, fleet dropdown, ferries/tunnels, live cost breakdown, total, optional P&L. Route status indicator: "✓ from database" / "✓ from HERE (unverified tolls)" / "⚠ new route".
2. **Route database** — table view of all routes, per-country km & toll editing, "tolls pending" filter, manual km override with audit note.
3. **Config** (finance/admin) — fuel price, consumption, driver rate, monthly overhead, month_days denominator, fleet variants CRUD.
4. **History** — saved calculations, filterable by route/date/user.

### 5.4 Validation & UX rules (from v1 pain points)
- Fleet variant is a constrained select — free text impossible by construction
- Days ≥ 0.5, step 0.5; drivers ∈ {1, 2}
- All monetary displays: EUR, 2 decimals, comma-as-decimal acceptable in input (Polish users)
- Calculation must never show a raw error state; invalid/missing inputs produce specific inline messages
- When route lookup state changes, ALL derived fields reset before repopulating (no stale values)

---

## 6. Migration from v1
- One-time import script: read the existing Google Sheet (Trasy tab) → seed `routes`, `route_country_km`, `route_country_toll`
- Import the 113-airport dataset → `airports`
- Import current config values from Konfiguracja tab (treat sheet values as source of truth at migration time)
- Keep the Sheet read-only for one month as fallback, then archive

## 7. Non-goals (v2.0)
- Fully autonomous toll pricing without human verification (estimate-then-verify only, see §4.3)
- Multi-currency (EUR only)
- Live fuel price feeds (manual config update is fine)
- Fleet telematics / GPS integration
- Invoicing or customer-facing quoting

## 8. Success criteria
- Known-route calculation: < 1 s, zero API calls
- New-route calculation via HERE: < 5 s end-to-end
- HERE quota consumption: ≤ number of genuinely new routes per month
- Zero formula-style silent errors — every failure state has an explicit message
- Dispatchers stop using the Sheet within one month of launch
