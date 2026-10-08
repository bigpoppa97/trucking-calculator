# Trucking calculator + Tablica floty

Two tools in one app for the forwarding department (8 subcontractor trucks):
- **Kalkulator**: break-even cost calculator for airport-to-airport routes (HERE routing, tolls).
- **Tablica floty** (the board): replaces the Excel planner "Grafik podwykonawców"; imports the
  company application's AG Grid export (.xlsx) and lays orders out per truck and week.

Terminology (the user's): **aplikacja** = the company's own order software (we only get its export),
**tablica** = our board. The user writes in Polish; all UI text is Polish.

Specs and decisions: `TABLICA.md` (run/usage) and the claude.ai Project doc
`claude/tablica-floty-specyfikacja.md` (every board design decision), status/backlog in
`claude/tablica-floty-stan.md`.

## Where it runs

- Windows PC, `C:\Users\wojciechz\Desktop\claude\trucking-calculator`, Node via fnm (`%USERPROFILE%\.fnm`,
  not on PATH in a plain cmd: `set PATH=%USERPROFILE%\.fnm\aliases\default;%PATH%`).
- `scripts\kalkulator-serwer.cmd` (Windows autostart) runs the backend with `.env`; the backend serves
  the built UI from `web/dist` and `/api` on :3001. Logs: `logs\serwer.log`.
- **Delivering changes**: push to the branch the PC is on (currently `feature/tablica-floty`); the user
  closes the server window and double-clicks `scripts\aktualizuj.cmd` (git pull, npm install, web build,
  DB backup to `data\kopie`, migrations, optional seed, restart). UI changes only show after that build.
- Debugging on the PC: read `logs\serwer.log` and stage a copy of `data\calculator.sqlite` (read-only
  analysis). Never write to the user's database directly.

## Rules

- No company data in the repo: no driver names, phones, rates, clients or real exports. Tests use
  synthetic data; `board:seed` reads the user's local files at runtime.
- Migrations: in-code registry (`src/db/migrations/index.ts`), applied ones are never renamed or edited.
  Next free number: **0012**.
- All `/api/*` routes are behind session auth (`src/server/auth.ts`). Board writes are signed with the
  logged-in user's display name (`BoardService.withActor`).
- Windows scripts (`.cmd`, `.ps1`): ASCII only (no Polish diacritics), CRLF (see `.gitattributes`).
- Amounts on the board are always EUR, never converted. Export naming is inverted: "Fracht zakup" =
  client rate (revenue), "Fracht sprzedaż" = carrier rate (cost).

## Checks before pushing

```
npx tsc --noEmit && npx vitest run
cd web && npx tsc --noEmit && npx vitest run && npx vite build
```
