# Arch-AI — Remaining Work Plan

Updated at the end of the Simulation fidelity / validation depth work (Phase 9). Everything
listed as done below is committed and pushed to `origin/main`, except Phase 9 itself, which
is complete and verified but **not yet committed**.

## Where things stand

| Phase | Scope | State |
|---|---|---|
| 0 | Data inventory + test-account cleanup | Done |
| 1 | Durable project persistence (autosave, duplicate, delete) | Done |
| 2 | Legacy browser-data migration — **retired**, not migrated | Done |
| 3 | Server-side report profile | Done |
| 4 | Two-account integration suite (disposable DB) | Done |
| 5 | Frontend↔backend integration + browser E2E | Done |
| 6 | Simulation page: presentation, accessibility, result persistence | Done |
| 7 | Documentation | Done |
| 8 | Test coverage: every route has a browser journey | Done |
| 9 | Validation depth, real mining deviations, live simulation instrumentation | Done, uncommitted |
| — | Deployment | **Not started** |
| — | Research write-up groundwork | **Not started** |

Verification totals: **unit 449/449 · integration 61/61 · E2E 66/66 · build clean · lint warnings only.**

### Decisions taken, for the record

- **Old browser projects are not migrated.** They were sample and test data. Any `projects`
  field in a legacy localStorage blob is stripped on read, on write and at startup, while the
  preferences in the same blob survive. The JWT lives under a different key and is never touched.
- **Comparison, Interview Prep and Learning Path are hidden, not deleted.** Routes, pages and
  state remain; only the sidebar entries were withdrawn.
- **Run comparison (Pass 4) was deliberately skipped**, so there is no side-by-side view of
  two runs. `Comparison.jsx` still compares two *versions of one project*, reached by URL.
- **The Gemini advisor has never been exercised end-to-end.** `playwright.config.js` sets
  `GEMINI_API_KEY: ''`, so every test skips the AI arm by design.

---

## Phase 8 — Close the test coverage gaps (DONE)

Every route now has a real browser journey. Verified by checking each route against a
content marker unique to it, rather than assuming the suite grew:

| Route | Coverage |
|---|---|
| `/login` `/register` | Journey |
| `/projects` `/builder` `/settings` | Journey |
| `/simulation` | Journey, including reload persistence and reduced motion |
| `/dashboard` `/process-mining` `/evaluation` `/recommendations` `/reports` | Journey |
| `/comparison` `/interview` `/learning` | Journey, reached by URL and asserted absent from the sidebar |

`e2e/pipeline.spec.js` walks simulate → mine → evaluate → recommend → report → dashboard in a
single session, because Process Mining consumes the event log and that is deliberately never
persisted. `e2e/hidden-routes.spec.js` covers the three routes withdrawn from the sidebar,
including that each redirects to `/login` when signed out.

Verification totals are now **unit 449 · integration 61 · E2E 66**.

---

## Phase 9 — Validation depth, real mining deviations, live simulation instrumentation (DONE, uncommitted)

Three related gaps closed in one pass, because they share the same substrate:

### Validation (`lib/validate.js`, rewritten)

- Stable error `CODES` exported for the UI and the tests; every finding is a structured
  object (`code`, `severity`, `message`, `suggestion`, `componentIds`, `edgeIds`) instead of
  a bare string.
- Architectural rules beyond graph sanity: application-layer bypass, invalid client targets,
  invalid infrastructure access, connection direction, store-connection rules.
- Non-blocking warnings: no terminal node, no data store, cycles, multiple entry points.
- `canSimulate` is now a property of the validation result, not a separate function, so the
  Builder's simulate gate and the worker's guard cannot disagree.

### Process mining (`lib/mining.js`, `lib/contract.js`, `lib/engine.js`)

- `expectedPaths` replaced by `expectedPathModel`, which reports truncation (path budget),
  entry/terminal shape and cycle presence, so a partial model is never presented as complete.
- Deviations are classified `trace` (a conformance violation) or `reliability` (failure,
  retry, queueing on an otherwise conforming path). Conformance is no longer dragged down by
  recovered retries.
- The engine keeps every sampled case's events, including cases still in flight when the
  event budget stops the run. Those are the `INCOMPLETE_TRACE` findings; previously they
  were silently dropped and the sample showed zero incomplete cases by construction.

### Simulation page (`pages/Simulation.jsx`, `components/sim/*`)

- New subcomponents: `IntelPanel`, `AlertStrip` (with `buildAlerts`), `EventTimeline`,
  and `flowRender` for the canvas work.
- Live per-component load during playback, written by the animation frame and polled, so
  node cards show load as it happens rather than only final figures.
- `useResults` validates before ever spinning up the worker; an invalid architecture fails
  immediately with the first real error message instead of a generic one.
- Process Mining page gained real deviation reporting (the `REAL_DEVIATION = 'none'`
  placeholder is gone), filters and tooltips.

New unit suites: `tests/validate.test.js` (all spec cases A–N plus structural edge cases
and the worker backend-bypass guard), `tests/mining.test.js` (deviation categories,
conformance, provenance, end-to-end pipeline). Lint has warnings only, none of them errors;
the pre-existing warnings were left alone.

---

## Phase 10 — Deployment (nothing is live)

The production bundle uses a relative `/api`, so a static host plus a reverse proxy works.
Still required:

1. **Choose a host** — Render for the Node API plus a static host for the frontend, or one
   VPS with nginx. Everything else follows from this.
2. Provision a **production MongoDB Atlas cluster**. Only the dev cluster exists.
3. Generate **production** `JWT_SECRET` and `MONGO_URI`. The values in test config are
   throwaways by design.
4. Set `VITE_API_BASE_URL` at build time **only** if the API is cross-origin, and add the
   frontend origin to the backend CORS allowlist.
5. Smoke-test the deployed stack: register → create project → reload → confirm persistence.

---

## Phase 11 — Research write-up groundwork

Do this while the development data is intact; it is the only copy.

- Collect the experimental evidence: health scores, bottleneck and deviation findings,
  process-mining results, before/after comparisons.
- Fix and document the evaluation methodology.
- **Declare the AI-generated contribution.** Recommendations come from two arms — a
  deterministic rule-based baseline and a server-side Gemini call — and that must be declared.

---

## Housekeeping

| Item | Detail |
|---|---|
| Dev database | 20 accounts, 25 projects. **Back this up** |
| Synthetic accounts | 7 `@example.com` accounts remain, all with 0 projects |
| Empty test databases | 7 empty `archai_it_*` databases on the cluster. Cannot be dropped without elevated Atlas rights — request `dropDatabase` so future runs leave no residue |
| Dev servers | Ports 5000/5173 run a build from before the Simulation work. Restart to pick it up |

---

## House rules for the rest of this plan

1. One phase per session, confirmed before starting.
2. No commit or push without explicit instruction.
3. Integration and E2E suites always run against a disposable database; the development
   database is never written to by tests.
4. Report PASS/FAIL per area at the end of each phase.
5. Keep all work inside the project directory.