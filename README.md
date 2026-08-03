# Soulside Notes — Frontend System Design Assignment

An AI-assisted clinical note review platform: notes move through an AI-generation →
human-review → approval lifecycle, with multi-reviewer concurrency, offline resilience,
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

Run the state machine unit tests: `npm run test`

## Scope: what's built deeply vs. minimally vs. cut

Per the assignment's "quality over quantity" guidance, I deliberately did not build every
listed feature to the same depth.

**Built fully:** state machine (fully guarded, unit tested), optimistic updates with
rollback, notes list virtualization (tested to 500 seeded notes; the mechanism is
count-independent — see Scale section), the 409 three-way conflict resolution UI, the
dummy backend with latency/failure injection.

**Built real but modest:** offline queue (core "survive reload, replay in order" loop
works; not hardened against every edge case like multi-tab IndexedDB contention),
real-time reconciliation (status changes and presence work; the periodic
auto-approve simulation is simplistic), telemetry (the `track()` pattern and batching
are real; only a handful of call sites are instrumented, not every possible action).

**Explicitly cut:**
- CRDT collaborative editing — listed as bonus in the spec, out of scope here
- Character-level diffing — word-level (see Concurrency section) covers the review need
- Plugin architecture for other note types — SOAP only
- PWA/installability, module federation
- Visual polish — the spec explicitly says architecture is weighted over polish
- Comprehensive multi-tab offline sync testing
- Accessibility — see dedicated section below; this is the area I'd invest in next

---

## Design decisions

### 1. State topology

Client state splits into three layers that don't overlap:

- **Server cache** (TanStack Query) — anything that originated from the API: notes,
  versions, review events. Keyed by `['note', id]`, `['notes', {filters}]`, etc. This is
  the layer optimistic updates and real-time patches write into.
- **Domain/interaction state** (XState) — one running machine instance per *open* note,
  representing "what's legal to do right now." Not persisted state — derived fresh from
  the server's real status on every note-detail mount via `resolveState()`.
- **Local UI state** (`useState`) — form inputs, dirty-section tracking, which version is
  selected in the history sidebar, the reject-reason textbox. Never touches the server
  directly; always flows through a mutation.

For the **notes list** specifically (100k+ rows), I deliberately did **not** spawn one
XState actor per row. Guard evaluation for list-level bulk actions would use the
machine's pure/stateless transition checking rather than live actors — actors are only
spawned for the single note currently open in the detail view. This is the difference
between "is this legal" (cheap, pure, works at any scale) and "track live state for this
specific thing I'm actively looking at" (actors, appropriately scoped to 1).

**Known gap:** the machine's snapshot and the query cache both independently represent
"current status," and I hit a real bug from this during Step 10 — a real-time push
correctly patched the cache but the UI kept reading `state.value` (the machine's stale
local snapshot) instead. Fixed by making `note.status` (cache) the single display source
of truth, with the machine used purely for `state.can()` guard evaluation, never for
display. A cleaner long-term design would derive the machine's snapshot from the cache on
every render rather than only at mount, eliminating the redundancy entirely — I didn't do
this here for time reasons, having found and worked around the specific bug it caused.

### 2. State machine

Implemented with XState v5 (`src/domain/noteMachine.ts`), encoding the full transition
table from the spec: 8 states, each transition guarded by role/ownership/MFA/reason
checks as appropriate, composed via `and()` where a transition needs multiple conditions
(e.g. `approve` requires both `isAssignedReviewer` AND `hasMfa`).

Every user-initiated action is checked via `state.can(event)` *before* the corresponding
button is even enabled — never after the fact. Disabled actions show a specific reason
(wrong role, not the assigned reviewer, missing MFA, missing reject reason), derived
alongside the guard checks. The reason strings are a UI-layer approximation reasoning
about *why* a guard likely failed, kept separate from the guard evaluation itself — the
button's actual enabled/disabled state always comes from the real `state.can()` call, so
a wrong guess about "why" can never make an illegal action clickable.

Server-pushed transitions (from the WebSocket) and user-clicked transitions are the exact
same event type sent through the exact same machine — deliberately, so there's no separate
ad-hoc code path for "someone else changed this."

10 unit tests cover the happy path, every guard rejection case, the 24h amend grace
window (using injectable `now` rather than real wall-clock time, for determinism), and
the failure/regeneration branch.

**Known simplification:** the mapping from "event type" → "target status string" (needed
to call the transitions API) lives in a small hardcoded lookup table
(`EVENT_TO_STATUS`) alongside the component, not inside the machine definition itself.
This is a parallel source of truth that could in principle drift from the machine — a
more robust version would have the machine expose its own target-state-for-event query.

### 3. Optimistic updates & rollback

Both transitions and version saves use TanStack Query's `onMutate`/`onError`/`onSettled`
mutation lifecycle:

- `onMutate`: cancel in-flight refetches for that note (so a stale response can't
  clobber the optimistic write), snapshot the previous cache value, write the optimistic
  guess into the cache.
- `onError`: restore the snapshot exactly, surface the failure.
- `onSettled`: always invalidate, regardless of success/failure — the final source of
  truth is always a real refetch, the optimistic write is just a latency mask.

Verified against the backend's real 5% simulated failure rate — forced it up to 90%
temporarily during manual testing to reliably observe rollback, then reverted. Confirmed
the UI never shows a status change that didn't actually happen for longer than one
failed round trip.

### 4. Concurrency & consistency (conflict resolution)

Every version save includes `baseVersionId` (which version this edit assumes it's
building on). The server compares that to the note's actual current version; a mismatch
returns `409` with the current version's id/revision/author and a common-ancestor
reference.

On `409`, the frontend fetches the full content of both "theirs" (server's current) and
the common ancestor, then shows a per-SOAP-section three-way diff: your changes vs.
ancestor, and their changes vs. ancestor, computed with a from-scratch word-level LCS
diff (`src/lib/diffWords.ts`) — no external diff library. Sections only one side touched
are visually unflagged; sections both sides touched are flagged and require an explicit
"keep mine / keep theirs" choice. Resolving rebases the save onto the server's version
(`baseVersionId` becomes their version's id), so the merged save won't immediately
re-conflict.

**Deliberately word-level, not character-level** — for clinical prose, word-level is
readable and sufficient; character-level would be noisier without adding real value for
this use case.

**Autosave coalescing:** a debounce (800ms) means rapid keystrokes produce one save
request, not one per character — verified via Network tab during testing (10+ keystrokes
→ exactly one POST). `clientMutationId` is sent on every save and checked server-side for
idempotency, so a retried request (e.g. from the offline queue) can't create a duplicate
version.

### 5. Offline behavior

`navigator.onLine` + the native `online`/`offline` events drive a visible banner and an
IndexedDB-backed write queue (`src/offline/db.ts`, using the `idb` wrapper library rather
than raw IndexedDB's callback API). When a save fails for a non-conflict reason
(connectivity), it's written to the queue instead of just erroring. On reconnect
(`online` event, plus once on app mount in case writes were queued in a previous
session), queued writes replay in original order; replay stops at the first
connectivity-caused failure (to preserve ordering — never let write #3 land before
write #2 for the same note) but continues past a real version-conflict failure on one
note to still attempt others.

A queued write that replays into a **real** conflict is left in the queue and flagged
per-note (via a small Zustand store) rather than auto-resolved — resolving it correctly
needs the same human-judgment UI as any other conflict, reused rather than duplicated.

**Known limitation:** `navigator.onLine` is a browser/network-adapter heuristic, not
"can actually reach our API" — a real production version would pair this with observed
request failures. Also, the "N changes waiting to sync" counter can lag slightly behind
the actual IndexedDB queue state in rare timing cases, though the underlying queue and
replay correctness were verified independently of the counter display.

### 6. Real-time synchronization

A single shared WebSocket connection per browser tab (`src/realtime/socket.ts`), with
client-driven subscribe/unsubscribe per note — components subscribe when a note is open
and unsubscribe on unmount, matching "subscribe to notes currently on screen... unsubscribe
when they leave the viewport." Reconnection uses exponential backoff (capped at 15s) and
automatically re-subscribes to everything on reconnect.

Events carry a server-assigned `eventId`; the client tracks the last ~500 seen ids and
drops exact duplicates — required because the dummy server deliberately delivers ~2% of
events twice, simulating the assignment's "design for at-least-once delivery."

On a `note.status_changed` push, the client both (a) directly patches the query cache
with the pushed status, and (b) invalidates in the background for full reconciliation.
Originally implemented as invalidate-only; found during testing that a background
refetch hitting the simulated 5% failure rate could leave the UI stale indefinitely with
no retry trigger. Patching directly with the server-pushed value (which is already
authoritative for that one field) fixed this — the background invalidate remains for
anything the lightweight patch doesn't cover (assignedReviewer, review events, etc.).

Presence (`note.presence` events, viewer list per note) is implemented and tested with
two simultaneous browser tabs.

### 7. Telemetry

`src/telemetry/track.ts` — event name + properties, batched (flush at 20 events or every
5s, whichever first) rather than one request per `track()` call. PII redaction uses a
denylist of known-sensitive keys (patient names, note content, reject reasons) plus a
structural rule: any non-primitive value (objects/arrays) is dropped by default rather
than risking an unredacted nested field. Explicitly noted as a denylist, not an
allowlist — a stricter production system would prefer allowlisting fields as safe rather
than trying to enumerate everything unsafe.

Flush on tab close/navigation uses `navigator.sendBeacon` (guaranteed best-effort delivery
during page teardown, unlike a `fetch()` which can be aborted mid-flight), triggered from
both `visibilitychange` (hidden) and `pagehide`, with a `fetch(..., {keepalive: true})`
fallback for the periodic in-session flushes.

Only a representative subset of actions are instrumented (note viewed, transition
attempted, conflict detected/resolved, write queued offline) — enough to demonstrate the
pattern, not exhaustive coverage of every possible interaction.

### 8. Performance & scale

The notes list uses `@tanstack/react-virtual` + `@tanstack/react-query`'s
`useInfiniteQuery` with server-side cursor pagination (base64-encoded offset, though the
client never assumes offset semantics — it only ever passes back whatever cursor the
server gave it). Only visible rows (~15-20, plus overscan) exist in the DOM at any time,
regardless of total row count — verified by watching the DOM stay small while scrolling
through all 500 seeded notes; the mechanism itself is count-independent, so 100k should
behave identically (not separately load-tested against 100k in this pass, given time
constraints — this would be the first thing I'd verify with more time).

Status filters are part of the React Query key, so toggling a filter off and back on
shows cached results instantly rather than refetching.

### 9. Testing strategy

- **Unit tests** (Vitest, 20 total, all passing):
  - **State machine** (10 tests) — happy path, every guard rejection, the grace-window
    boundary (deterministic via injectable time), and the failure/regenerate branch.
  - **Word-level diff algorithm** (6 tests) — same/added/removed detection, full
    replacement, empty-string edge cases, and a property-based check that
    same+added tokens exactly reconstruct the new text.
  - **Debounce hook** (4 tests, using Vitest fake timers + `@testing-library/react`'s
    `renderHook`) — no call before the delay, one call after, rapid calls coalescing
    into a single invocation with the last value (this is a direct automated proof of
    the autosave-coalescing behavior manually verified via the Network tab during
    development), and no call after unmount.
  
  These three were prioritized as the highest-leverage, cheapest-to-test areas: pure
  logic with no I/O (state machine, diff) or deterministic time-based behavior (debounce),
  versus effectful UI flows that are far more expensive to test in isolation.

- **Manual/integration verification**: every other major flow (optimistic
  rollback, conflict resolution, offline queue + replay, real-time push, telemetry
  batching) was verified end-to-end manually during development, including deliberately
  forcing edge conditions (temporarily raising the failure rate to 90% to reliably
  trigger rollback; running two browser tabs simultaneously to force real version
  conflicts and test presence).

- **Not done**: automated component tests (React Testing Library) for the effectful UI
  flows above, and Playwright end-to-end smoke tests. This remains the top item I'd
  tackle next — the pure-logic layer is now solidly covered, but the integration
  surface (mutations, cache patching, IndexedDB interactions) is still only manually
  verified.

### 10. Accessibility

**This is the weakest area of the submission, and I want to be direct about that rather
than overstate it.** Given the time budget, I prioritized the concurrency/state-machine/
real-time mechanics (explicitly the most heavily weighted evaluation criteria) over
accessibility. Concretely missing: no ARIA live regions announcing status changes or
real-time pushes to screen readers, no explicit focus management when the conflict panel
or version diff appears, disabled buttons rely on the native `disabled` attribute (which
does convey state to screen readers) but their reason text isn't programmatically
associated via `aria-describedby`, and color is used alone (green/red diff highlighting)
without a non-color-dependent indicator. Semantic HTML (`<button>`, `<label>`, proper
heading hierarchy) is used throughout, which covers some baseline behavior for free, but
a real accessibility pass — screen reader testing, focus trap in the conflict modal,
live-region announcements for real-time events — is the top item on my "next" list.

---

## Architecture notes

- **Layering**: `domain/` (pure logic, no React/HTTP), `api/` (fetch wrappers, no React),
  `offline/`, `realtime/`, `telemetry/` (each independently testable, no React), then
  `pages/`/`components/` (React, composes everything above). Swapping the transport
  (REST → GraphQL) or the UI framework would only touch the top layer.
- **Dummy backend** (`server/`): Express + `ws`, in-memory store seeded deterministically
  (seeded PRNG, not `Math.random()`, so restarts produce the same dataset shape). Latency
  (100-800ms) + 5% failure injection applied to all non-dev routes via middleware.
- react-router-dom's `npm audit` flags several SSR/RSC-related CVEs; not applicable here
  since this is a client-only SPA with no server rendering.