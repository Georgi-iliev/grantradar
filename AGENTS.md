# GrantRadar — Base44 dev environment

## What this is
A single-file static site: `index.html` (~1150 lines) is a self-contained UK & EU grant-funding dashboard with inline CSS, inline JS, and an embedded `GRANTS` data array. No build step, no framework, no backend.

## Running it
- `docker compose -f docker-compose.base44.yml up -d` — serves `index.html` via `nginx:alpine` on host port 3000.
- No external secrets required to run/preview the dashboard. The only runtime external dependency is Google Fonts (CDN, no key).

## Data refresh (CI only, NOT needed to run)
- `scripts/refresh.mjs` calls the OpenAI API to propose new grants and rewrites the `GRANTS` array in `index.html`. Requires `OPENAI_API_KEY` + Node 20+. This is a CI/data-maintenance tool, not part of the running app.
- `grantradar-tests.js` — Node test suite validating `index.html` structure. Run with `node grantradar-tests.js`. No deps.

## Editing
- All UI/logic/data live in `index.html`. Changes hot-reload only via `reload_preview` (nginx serves the file directly; there is no watch/reload dev server, but file changes are picked up on browser refresh since the volume is bind-mounted read-only).
- The `GRANTS` array sits between `const GRANTS = [` and the `// @@GRANTS_END@@` sentinel — keep edits inside that region or the refresh script breaks.
