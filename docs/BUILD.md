# Build brief (for everyone building this repo)

Read with: `CLAUDE.md`, `docs/PLAN.md`, `DECISIONS.md`, `docs/design/*.md`.

## The contract (do not change without agreement)

- `packages/core` — types, money, GSTIN, QR, invoice maths, checks, **HTTP API contract** (`src/api.ts`),
  **extraction contract** (`src/extraction.ts`). Import from `@arad/core`.
- `packages/hdfc-bulk-file` — HDFC ENet bulk file generator. Import from `@arad/hdfc-bulk-file`.
- `.env.example` — every runtime setting. Read config only from `process.env` (twelve-factor).

If the contract is missing something you need, add it in **your own package** and list the
proposed change to `packages/core` in your final report instead of editing core.

## Ownership (one owner per folder, so parallel work never collides)

| Folder | Owner |
|---|---|
| `services/api`, `scripts/dev-db.sh`, `scripts/seed*` | API builder |
| `packages/extraction`, `tools/synth-invoices`, `tools/eval` | Extraction builder |
| `apps/web` | Web builder |
| `Dockerfile`, `docker-compose.yml`, `infra/`, `.github/`, `docs/deploy.md` | Infra builder |
| root files, `packages/core`, `packages/hdfc-bulk-file`, `docs/*` (other) | Lead (integration) |

Do not edit files outside your folders. Need a root script? Put it in your report.

## Stack

- Node 22, TypeScript strict, ESM, pnpm workspaces (package names `@arad/*`), vitest.
- API: Fastify 5, `pg` (node-postgres), plain SQL migrations, pino JSON logs to stdout.
- Web: React 19 + Vite + Tailwind CSS v4 + vite-plugin-pwa, `wouter` router, `lucide-react` icons.
- Local Postgres: binaries in `/usr/lib/postgresql/16/bin` (no Docker daemon in this sandbox).
- Chromium for Playwright: `/opt/pw-browsers` (never run `playwright install`).

## Conventions

- Money: integer paise everywhere; quantities in thousandths (`qtyMilli`); GST in basis points.
- Dates as `YYYY-MM-DD` strings; timestamps ISO strings.
- Never log or return full bank account numbers, AI keys, PINs or session secrets.
- Every state change writes an `audit_log` row (who, when, what, why).
- Errors: `{ error: { code, message, details? } }`.
- Tests next to the package (`test/`). Fast unit tests by default; DB tests use a real local Postgres.
- Commit messages: imperative, explain why. End each commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01N9KNF9t5tgK16ArZhmTXZT
  ```

## Design system (web)

Goal: **light, minimal, modern, calm**. Works one-handed on a ₹8,000 Android phone and on iPhone.

- **Weight budget:** initial JS ≤ 120 KB gzip, total app shell ≤ 250 KB. Lazy-load owner screens,
  QR decoder and camera code. No UI kit, no animation library, no OpenCV, no web fonts.
- **Font:** system stack `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans",
  "Noto Sans Devanagari", sans-serif`. Numbers use `font-variant-numeric: tabular-nums`.
- **Colour tokens** (CSS variables, light + dark via `prefers-color-scheme`):
  - `--bg` #F7F7F5 / #0B0D0C · `--surface` #FFFFFF / #141716 · `--line` #E7E5E0 / #26302C
  - `--text` #111614 / #EEF2EF · `--muted` #5B635F / #9AA6A0
  - `--brand` #0E7C66 (deep green, "fresh grocery") / #34C79F · `--brand-ink` #FFFFFF
  - `--ok` #12805C · `--warn` #B26A00 · `--bad` #C2362B · `--info` #2F6FDE
  - One accent only (brand). Status colours always paired with an icon or text, never colour alone.
- **Type scale:** 13 / 15 (body) / 17 / 20 / 24 / 32 (amounts). Weight 400/600 only.
- **Spacing:** 4-pt grid (4, 8, 12, 16, 24, 32). Screen gutter 16. Cards radius 16, inputs/buttons radius 12.
- **Touch:** minimum target 48×48; primary action in the thumb zone (bottom), full-width.
- **Surfaces:** flat cards on `--bg`, 1px `--line` border, no heavy shadows (one soft shadow for sheets).
- **Motion:** 150–250 ms, `transform`/`opacity` only, ease-out; respect `prefers-reduced-motion`.
  Swipe cards follow the finger (pointer events), snap with a spring-like ease, haptic `navigator.vibrate(10)` where supported.
- **Icons:** lucide-react, 20/24 px, stroke 1.75. No emoji as icons.
- **Language:** English + Hindi from day one; every string through the i18n dictionary; Hindi labels
  may be longer — never fixed-width text containers.
- **Accessibility:** contrast ≥ 4.5:1, visible focus rings, labels on inputs, `aria-live` for the balance meter.
- **States:** every list has empty, loading (skeleton) and error states; offline banner when `navigator.onLine` is false.
