# Soulside Notes: Frontend System Design Assignment

An AI-assisted clinical note review platform: notes move through an AI-generation,
human-review, approval lifecycle, with multi-reviewer concurrency, offline resilience,
and real-time collaboration.

## Running it

Two terminals, both from the project root:

```bash
npm install
npm run server   # dummy backend + WebSocket channel, :3001
npm run dev      # frontend, :5173
```

Open `http://localhost:5173`. Use the "Acting as" dropdown to switch between fake users
(reviewers, clinicians, admin, read-only auditor) to exercise role/ownership guards.

Run the state machine plus pure-logic unit tests: `npm run test`

Run the provided simulation and the 5 required test scenarios (server must be running):
```bash
npx tsx scripts/simulate_workflow.ts
npx tsx scripts/scenario_1_concurrent_edit.ts
npx tsx scripts/scenario_2_offline_replay.ts
npx tsx scripts/scenario_3_realtime_race.ts
npx tsx scripts/scenario_4_resubmit_after_supersede.ts
npx tsx scripts/scenario_5_no_leak.ts
```
See `scripts/README.md` for what each proves and its actual recorded results.

## Scope: what's built deeply vs. minimally vs. cut

This project went through two passes: an initial build covering the core architecture,
followed by a deliberate, exhaustive audit against the full spec text, which surfaced
and closed a substantial number of real gaps, including a genuine security hole. Both
passes are reflected honestly below.

**Built fully, including server-side enforcement:** state machine (fully guarded, unit
tested, and now the literal authority the server itself defers to, see Authorization),
optimistic updates with rollback, notes list virtualization (verified at the
assignment's actual 100k scale, not just architecturally, see Scale), the 409 three-way
conflict resolution UI (verified both manually and via an automated script), real-time
sync (all three event types, transitions routed through the same machine client- and
server-side), the dummy backend with latency/failure injection, telemetry (full spec
including retry-with-backoff and IndexedDB parking), and the full notes-list feature set
(status/reviewer/patient/date filters, debounced search, sortable columns, bulk actions,
skeleton loaders, distinct empty/no-results states).

**Built real but modest:** offline queue. The core "survive reload, replay in order"
loop works, verified rigorously: testing surfaced and led to fixing a stalled-fetch bug
(DevTools' offline simulation not reliably triggering error handlers), an unreliable
`online` event, and a false-positive "offline" classification for the backend's own
random 5% failures (now retried once before queuing, so a real connectivity issue is
distinguished from a coincidental simulated failure). Not hardened against multi-tab
IndexedDB contention. The periodic real-time auto-approve simulation is intentionally
simplistic, a random dice roll rather than a realistic actor model.

**Explicitly cut:**
- CRDT collaborative editing: listed as bonus in the spec, out of scope here
- Character-level diffing: word-level (see Concurrency section) covers the review need
- Plugin architecture for other note types: SOAP only
- PWA/installability, module federation
- Automated architecture diagram: explicitly marked optional in the spec

## Visual design

A styling pass referencing Soulside's actual brand palette (navy `#1a1a35`, amber
`#fcb613`, lavender `#f0f0fd`, Cormorant Garamond for headings), implemented via CSS
custom properties as design tokens. A deliberate late addition on top of already-complete,
already-tested functionality. The spec explicitly deprioritizes polish relative to
architecture, and no functional logic changed during this pass.

---

## Design decisions

### 1. State topology

Client state splits into three layers that don't overlap:

- **Server cache** (TanStack Query): anything that originated from the API, notes,
  versions, review events. Keyed by `['note', id]`, `['notes', {filters}]`, etc. This is
  the layer optimistic updates, real-time patches, and eventId-reconciled events write into.
- **Domain/interaction state** (XState): one running machine instance per *open* note,
  representing "what's legal to do right now." Derived fresh from the server's real
  status on every note-detail mount via `resolveState()`, and re-driven by
  server-pushed transitions via `send()` (see Real-time section), not just patched
  around.
- **Local UI state** (`useState`): form inputs, dirty-section tracking, which versions
  are selected for comparison, the reject-reason textbox.

For the **notes list** (verified functioning correctly at 100k+ rows, see Scale), no
XState actor is spawned per row; actors are only spawned for the single note currently
open in the detail view. Guard evaluation for bulk actions and server-side authorization
both go through the pure, stateless machine-evaluation path (`resolveState` plus `can`),
never live per-row actors.

**Resolved gap** (previously documented as open): the machine's snapshot and the query
cache used to independently represent "current status," which caused a real display bug
during initial real-time work: a server push correctly patched the cache but the UI
kept reading the machine's stale local snapshot. This is now fully resolved on two
fronts: `note.status` (cache) remains the single *display* source of truth, and
server-pushed transitions are additionally reconstructed into the actual machine event
and run through `send()`, so the machine's own internal state also stays genuinely
correct, not just bypassed for display purposes. See section 6.

### 2. State machine

Implemented with XState v5 (`src/domain/noteMachine.ts`), encoding the full 11-row
transition table from the spec, each transition guarded by role/ownership/MFA/reason
checks, composed via `and()` where a transition needs multiple conditions.

**This machine is now the actual authority on both client and server**, not just a UI
convenience. The `/transitions` endpoint imports and evaluates the identical machine
module the frontend uses (`server/index.ts` imports directly from `src/domain/`),
reconstructing a snapshot from the note's real status/context and calling `.can(event)`
before applying anything. This was added after an audit against the spec's explicit
requirement that a hostile client's rogue button click cannot silently bypass a guard,
which revealed the server was originally accepting any transition a client sent,
regardless of role/ownership/state. Verified via a direct `fetch()` from the browser
console impersonating an unassigned "hacker" reviewer attempting to approve a
READY_FOR_REVIEW note: correctly rejected with 403, confirming the guard cannot be
bypassed by skipping the UI entirely.

Disabled action buttons show a specific, UI-layer-approximated reason for why they're
disabled; the actual enabled/disabled state always comes from the real `state.can()`
call, so a wrong guess about "why" can never make an illegal action clickable.

10 unit tests cover the happy path, every guard rejection, the 24h grace-window boundary
(deterministic via injectable time), and the failure/regeneration branch.

**Known simplification:** `EVENT_TO_STATUS`, a small hardcoded event-to-status lookup
used for optimistic UI purposes and telemetry labeling, remains a parallel structure
outside the machine definition. The server-side enforcement path does not rely on this
table; it derives the real next state from the machine itself via `actor.getSnapshot()`
after sending the event through a real `createActor` instance (a bare `resolveState`
snapshot alone was insufficient to execute a transition's side effects; this was found
and fixed during server-enforcement work).

### 3. Optimistic updates and rollback

Both transitions and version saves use TanStack Query's `onMutate`/`onError`/`onSettled`
lifecycle: cancel in-flight queries, snapshot the previous value, write the optimistic
guess, restore on error, always invalidate on settle for eventual full reconciliation.

Verified against the backend's real 5% simulated failure rate, including temporarily
forcing it to 90% to reliably observe rollback under manual testing, then reverting.

**Local ReviewEvent plus literal eventId reconciliation:** per the spec's explicit
requirement, an optimistic local `ReviewEvent` is emitted immediately on every
transition click (rendered distinctly in the UI, amber with a "(saving...)" label).
On success, rather than merely discarding the placeholder and waiting for a subsequent
refetch, the exact server-assigned event from the transition's ack response
(`result.event`) is swapped in synchronously by its real id, a true one-for-one
reconciliation with zero visible gap, verified by confirming the persisted event
survives a full page refresh.

### 4. Concurrency and consistency (conflict resolution)

Every version save includes `baseVersionId`; a mismatch returns `409` with the current
version and common ancestor. The frontend shows a per-SOAP-section three-way diff
(your changes vs. ancestor, their changes vs. ancestor), word-level (LCS-based, from
scratch, `src/lib/diffWords.ts`), letting the user resolve section-by-section rather
than forcing an all-or-nothing choice. Resolving rebases onto the server's version so
the merged save won't immediately re-conflict.

**Proactive conflict detection**, per the spec's explicit requirement that if the
server-pushed version supersedes an in-flight optimistic edit, the resolution UI is the
same three-way merge: the real-time channel now also broadcasts `note.version_added`
whenever any save succeeds. If a client has unsaved local edits when this arrives for
their open note, the conflict panel opens proactively. The user is never left
discovering the conflict only reactively, after their own doomed save fails.

**Verified two ways:** manually with two simultaneous browser tabs (including forcing
tight timing to genuinely diverge before either side saves), and automatically via
`scripts/scenario_1_concurrent_edit.ts`, 6/6 assertions pass, confirming the second
writer is rejected with the correct current/commonAncestor payload and the first
writer's content is never silently lost.

**Autosave coalescing**, per the spec's explicit requirement to never allow two
concurrent POSTs and to queue exactly one follow-up save: a debounce (800ms) means
rapid keystrokes produce one request, not one per character. Additionally, if a save is
already in flight when further edits arrive, they're held in a ref and flushed as
exactly one follow-up save once the in-flight request settles, verified by artificially
slowing the backend to 3s latency and confirming only one trailing request fires
despite continued typing during the wait.

### 5. Offline behavior

`navigator.onLine` plus native `online`/`offline` events drive a visible banner and an
IndexedDB-backed write queue (`src/offline/db.ts`, via the `idb` wrapper). Writes that
fail are queued and replay in order on reconnect, honoring `baseVersionId`; a replayed
write that lands in a genuine conflict is left queued and flagged for the same
three-way-merge UI, rather than auto-resolved.

**Two real bugs found and fixed during testing:**
- Chrome DevTools' "Offline" network throttling stalls fetches rather than rejecting
  them immediately, so a save attempted while offline could hang indefinitely instead
  of reaching the error handler that queues it. Fixed by checking `navigator.onLine`
  before attempting the request, rather than relying solely on the request erroring.
- The browser's `online` event doesn't always fire reliably when toggling DevTools'
  simulated connectivity. Fixed by also triggering replay locally whenever the
  component's own `isOnline` hook transitions to `true`, as a fallback to the global
  listener.

**A third distinction added:** since the backend's own 5% random failure rate could be
mistaken for a genuine connectivity issue, a save failure while `navigator.onLine` is
still `true` now retries once immediately before falling back to queuing, so a
coincidental simulated failure doesn't misleadingly show "offline" messaging while the
user is actually online.

**Known limitation:** `navigator.onLine` remains a network-adapter heuristic, not
"can reach our API." A production version would pair this with observed request
failure patterns. The spec's claim of usability for at least 30 minutes offline is
architecturally sound (no time-based assumptions exist in the queue/replay mechanism)
but was not verified as a literal continuous 30-minute session, a real gap between
reasoned confidence and empirical proof, noted honestly rather than silently assumed.

### 6. Real-time synchronization

A single shared WebSocket connection per tab (`src/realtime/socket.ts`) with
client-driven subscribe/unsubscribe. Subscriptions now cover both the open detail
note and every note currently visible in the virtualized list (`useVisibleNotesRealtime`),
matching the spec's explicit requirement to subscribe to notes currently on screen
(list rows in view plus open detail) and unsubscribe when they leave the viewport,
verified via the Network tab's WS message log showing subscribe/unsubscribe pairs
firing as rows scroll in and out.

**Reconnection uses exponential backoff with full jitter** (a random delay up to the
backoff ceiling, not a fixed exponential value), spreading reconnection attempts across
clients rather than a "thundering herd" all retrying in lockstep. On reconnect, the
client requests replay of anything missed via a server-assigned sequence number
(`replay_since`), rather than assuming the gap contained nothing. The server buffers
the last 500 broadcast events specifically to answer this. Verified by stopping and
restarting the backend mid-session and confirming the client reconnects and resumes
receiving live updates without a manual page refresh.

**All three event types are implemented, both directions:** `note.status_changed`,
`note.presence`, and `note.version_added` (added during the audit pass, previously
missing entirely).

**Transitions are genuinely routed through the same machine on receipt**, per the
spec's explicit requirement. A pushed `(fromStatus, toStatus, actorId)` triple is
reconstructed into the corresponding machine event and sent via `send()`, not just
patched into the cache, verified by observing that the action bar's enabled/disabled
states correctly re-evaluate the instant a remote transition arrives (for example
"Start amendment" becoming enabled immediately after a remote Approve), not only after
a manual refresh.

**A real gap found and fixed during this work:** the original implementation only ever
broadcast `note.status_changed` from the background simulation, never from a genuine
user-initiated transition via the enforced `/transitions` endpoint, meaning real
Approve/Reject clicks were invisible to other viewers even though the simulated
auto-approve was visible. Found via a two-tab test that only worked when the simulation
happened to fire, and fixed by adding the missing broadcast call to the real transition
path.

**Reconciliation by eventId, not order:** proven empirically, not just claimed.
`scripts/scenario_3_realtime_race.ts` opens a real WebSocket, subscribes, fires an HTTP
transition, and races both responses. On the recorded run, the WebSocket push arrived
4ms before the HTTP acknowledgment, directly capturing the exact out-of-order scenario
the spec describes as a live measurement, not a theoretical possibility.

**A second bug found during batch work:** live-patched list rows kept their stale sort
position after a status update (for example a newly-APPROVED row staying interspersed
among IN_REVIEW rows when sorted by status), since the direct cache patch never
triggers a resort. Fixed with a debounced resort (3s after the last live patch): the
badge updates instantly (satisfying "never jumps or blinks"), and the row settles into
correct sorted position once activity quiets, rather than staying wrong indefinitely or
jumping jarringly mid-update.

### 7. Telemetry

`src/telemetry/track.ts` implements the full `track(name, properties, {important?})`
signature. Batched (flush at 20 events, every 5s, on route change, or on tab-hidden, all
four triggers implemented). `important: true` bypasses batching thresholds entirely for
an immediate flush (used for `version_conflict_detected`).

**Retry and park, per the spec's explicit requirement:** a failed batch send retries up
to 3 times with exponential backoff; if all retries are exhausted, the batch is parked
in IndexedDB rather than dropped, and retried on the next flush tick or on the next
session's startup recovery pass. Verified by forcing the telemetry endpoint to always
fail, confirming batches appear in IndexedDB, then reverting the endpoint and confirming
the parked batches are picked up and successfully sent without any user action.

PII redaction via a denylist (patient names, note content, reject reasons) plus a
structural rule dropping any non-primitive value by default. `sendBeacon` on
`visibilitychange`/`pagehide` for unload-safe delivery.

### 8. Performance and scale

`@tanstack/react-virtual` plus `useInfiniteQuery` with server-side cursor pagination
(base64-encoded offset internally, though the client never assumes offset semantics;
it only ever passes back whatever cursor the server returned).

**Verified directly at the assignment's actual stated scale of 100,000+ notes**, not
just reasoned about architecturally: reseeded the store with 100,000 notes, confirmed
the list correctly displayed "100000 total," and confirmed via DevTools that the DOM
row-element count stayed bounded (roughly 25 to 35 elements, matching the visible
window plus overscan) while scrolling rapidly through the full dataset, never anywhere
close to 100,000 live DOM nodes. The Network tab confirmed each scroll-triggered load
still fetched only about 50 rows at a time via cursor pagination. Scrolling remained
smooth with no browser unresponsive-page warnings.

Status/reviewer/patient/date/search/sort are all part of the React Query key, so
toggling a filter off and back on shows cached results instantly rather than refetching.

### 9. Testing strategy

**Unit tests** (Vitest, 20 total, all passing): state machine (10), word-level diff
algorithm (6), debounce hook (4, using fake timers plus `renderHook`, directly proving
the autosave-coalescing behavior). Prioritized as the highest-leverage, cheapest-to-test
pure logic, versus effectful flows that are far more expensive to test in true isolation.

**The provided simulation script**, reconstructed from the spec's excerpt (the literal
file was not provided) and adapted to the actual current `/transitions` payload shape
(a machine `event` object, following the server-enforcement work; the original
excerpt's flat `{to, actorId}` shape predates that change). Run against 5,000 seeded
notes and 3 concurrent reviewer loops: 82 successful saves, 0 conflicts (expected, since
this script's reviewers each independently pick their own note rather than deliberately
colliding; see Scenario 1 for that), 21 requests hit the backend's own 5% simulated
failure rate and were correctly caught and logged without halting the run, a count
matching the statistically expected value at that request volume, confirmed against the
actual `FAILURE_RATE` constant rather than assumed.

**All 5 of the assignment's explicitly-named "build your own" scenarios**, built as
standalone, retry-hardened, re-runnable scripts (`scripts/scenario_1` through `_5`),
not just described in prose. Each asserts specific, falsifiable outcomes rather than
just printing output for manual inspection. All pass. See `scripts/README.md` for full
detail on each, including one genuinely interesting empirical result (Scenario 3's
measured 4ms real-time-before-http-ack race) and one honestly-reported scale limitation
(Scenario 5 cycled 200 notes, not the originally-planned 500, due to the route's
pagination cap, reported accurately rather than adjusted after the fact).

**Not done:** automated component tests (React Testing Library) for the effectful UI
flows, and Playwright end-to-end smoke tests. The pure-logic layer is now solidly
covered by unit tests and the integration/scenario layer by the 5 scenario scripts plus
extensive manual verification, but true component-level automated tests (rendering the
actual React tree and simulating user interaction) remain the largest testing gap.

### 10. Accessibility

An accessibility pass covering the highest-impact, cheapest-to-fix gaps, not a full
WCAG audit:

- **ARIA live region** (`role="status"`, `aria-live="polite"`) announces both the
  user's own successful transitions and real-time pushes from other reviewers, the one
  case where the UI updates with zero other signal to anyone not looking at the screen.
- **`aria-describedby`** links each disabled action button to its specific reason.
- **Focus management**: the conflict panel receives focus on open (`tabIndex={-1}` plus
  `.focus()`).
- **Non-color diff indicators**: `+`/`−` markers alongside color, hidden from screen
  readers via `aria-hidden` since they're a redundant visual-only signal.
- Semantic HTML and explicit `htmlFor`/`id` label association throughout.

**Still not done:** no formal screen reader testing (VoiceOver/NVDA); no
keyboard-navigation audit of the virtualized list specifically; no focus trap
constraining focus to stay within the conflict panel while open (focus moves in, but
isn't locked there). A full WCAG 2.2 AA audit remains the largest single remaining
investment.

### 11. Authorization

Four roles (`CLINICIAN`, `REVIEWER`, `ADMIN`, `READONLY_AUDITOR`), enforced at three
distinct layers, per the spec's explicit requirement:

- **Action-level**: every button's enabled state derives from `state.can(event)`,
  disabled reasons shown per-action.
- **Component-level**: `canEditNoteContent`/`canPerformBulkActions`
  (`src/auth/permissions.ts`) gate the SOAP editor and bulk-action checkboxes. A
  READONLY_AUDITOR sees a note fully but cannot edit it or select rows for bulk
  action, with distinct messaging ("You have read-only access...") rather than the
  editor simply appearing broken.
- **Route-level**: `RequirePermission` wraps the entire authenticated route tree with a
  session-validity check, architecturally equivalent to what a real app would use to
  redirect an invalid or expired session. This specific check essentially never fires
  in normal use with our fixed fake-user roster, and that's stated plainly rather than
  implied to be meaningfully exercised by everyday testing.

**Server-side enforcement, not just UX:** the critical requirement, that the server is
authoritative and a rogue button click cannot silently bypass a guard, is genuinely
met. The `/transitions` endpoint evaluates the real shared state machine before
applying anything, independent of whatever the client claims. Verified directly via a
browser-console `fetch()` bypassing the UI entirely, impersonating an unassigned
reviewer attempting to approve a note still in `READY_FOR_REVIEW`: rejected with 403.
This was found to be genuinely missing during the spec audit (the original
implementation trusted the client's requested transition outright) and is one of the
more consequential fixes made after initial development.

---

## Architecture notes

- **Layering**: `domain/` (pure logic, the state machine is imported unmodified by
  both frontend and server), `api/`, `offline/`, `realtime/`, `telemetry/`, `auth/`
  (each independently testable, no React), then `pages/`/`components/` composing
  everything above.
- **Dummy backend** (`server/`): Express plus `ws`, in-memory store, deterministic
  seeded PRNG. Latency (100-800ms) plus 5% failure injection on all non-dev routes. Two
  real seed bugs found and fixed during testing: the status pool originally omitted
  `FAILED` and `AMENDED` entirely (making those states permanently untestable from
  seed data), and every note originally got a brand-new unique patient rather than
  being drawn from a shared pool (making the patient filter technically correct but
  practically useless, since no patient ever had more than one note). Both fixed; the
  patient filter now draws from a 150-patient pool across up to however many notes are
  seeded.
- react-router-dom's `npm audit` flags several SSR/RSC-related CVEs; not applicable
  here, since this is a client-only SPA with no server rendering.

## A note on process

This project was built in two distinct passes. The first covered the explicit 12-area
build plan end-to-end. The second was a deliberate, line-by-line audit of the full
assignment text against what actually existed, which surfaced roughly a dozen genuine
gaps and bugs, including a real security hole (client-trusted authorization) and
several silent data/logic bugs (missing real-time broadcasts, seed data gaps, a
falsy-zero bug in the reseed endpoint, unretried test flakiness). Each was investigated
by first reproducing and confirming the actual behavior, not assumed from code
inspection alone, before being fixed and re-verified. That process, and its results,
are reflected throughout this document rather than smoothed over.