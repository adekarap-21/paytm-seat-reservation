# Live Dashboard — Frontend Design

**Date:** 2026-10-04
**Author:** Apeksha Adekar
**Status:** Draft for review
**Parent spec:** `2026-10-04-seat-reservation-prd.md`

---

## 1. Purpose

A single page served at `GET /dashboard` that lets the interviewer **watch the service behave correctly during their own burst**. It is not a buyer flow or admin UI — those stay as `curl`. The dashboard's only job: make the correctness invariants visible in real time.

## 2. Non-goals

- No buying. No seat picker, no cart, no checkout.
- No login. The dashboard is read-only and public.
- No admin forms. `POST /shows` stays on `curl` so the interviewer can see the raw request.
- No build step. No React, no TypeScript at the frontend, no bundler. Just HTML + CSS + vanilla JS.
- No historical data. Dashboard shows "now". A refresh = new baseline.

## 3. Stack

- **One file:** `public/dashboard.html` served statically by the Node app.
- **Vanilla JS**, ES modules, no transpile.
- **`EventSource`** for the SSE connection (built into every browser).
- **Minimal CSS**, scoped to the file. CSS grid for the seat map.
- **No deps.** Target: under 200 lines total (HTML + CSS + JS).

> ponytail: single-file vanilla; add bundler + framework when the UI grows beyond one page.

## 4. Layout

```
┌──────────────────────────────────────────────────────────────┐
│  friday-night        [● live]                                │ ← header
│  available 198  held 0  confirmed 2  total 200   ✓ reconciled│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   A1  A2  A3  A4  A5  A6  A7  A8  A9  A10                   │ ← seat grid
│   B1  B2  B3  B4  B5  B6  B7  B8  B9  B10                   │   (color coded)
│   C1  C2  C3  C4  C5  C6  C7  C8  C9  C10                   │
│   ...                                                        │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  recent (last 20)                                            │ ← event feed
│  10:15:30.142  confirmed  A12            by u_42             │
│  10:15:30.138  confirmed  B3,B4,B5       by u_17             │
│  10:15:29.901  cancelled  A1             by u_8              │
│  10:15:29.880  seat_taken A12            by u_99 (declined)  │
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

Fixed layout. Header stays visible; seat grid scrolls; event feed scrolls independently. No modals, no tabs, no collapse. Everything on one screen.

## 5. Visual language

### 5.1 Seat colors

| State | Fill | Border | Text label |
|---|---|---|---|
| available | `#e5e7eb` (neutral 200) | `#9ca3af` | — |
| held | `#fde68a` (amber 200) | `#f59e0b` | `H` |
| confirmed | `#fecaca` (red 200) | `#dc2626` | `C` |
| just-changed | pulse animation (300ms) | — | — |

**Important:** state is also encoded in the text label (`H`, `C`, blank), not just color. This is for a11y — colorblind users and screen readers can still read the state. The seat id (`A12`) is always visible.

### 5.2 Hot-seat storm indicator

When the service rejects ≥10 requests for the same seat within 2 seconds, the seat gets a brief red glow (`box-shadow` pulse, 500ms). This visualizes the hot-seat contention the exercise explicitly tests.

### 5.3 Reconciliation badge

Top header shows `✓ reconciled` (green) or `✗ drift: counts don't match seat states` (red). Computed client-side from the SSE `counts` event + the running seat state. If this ever shows red, there's a bug — this IS the invariant check for the viewer.

### 5.4 Connection status

Small badge next to the show name:
- `● live` (green) — SSE connected.
- `● reconnecting` (amber) — connection dropped, `EventSource` auto-retrying.
- `● offline` (red) — repeated failures (>3 reconnects).

## 6. Data flow

```
Browser load
   │
   ▼
GET /dashboard             (static HTML+JS)
   │
   ▼
JS parses ?show=<id> from URL (or last-seen in localStorage)
   │
   ├─► GET /shows/:id       (baseline, one-shot)
   │     └─► render seat grid, header counts
   │
   └─► new EventSource('/shows/:id/stream')
         ├─ 'baseline' event ─► replace seat grid (handles reconnect drift)
         ├─ 'seat' event    ─► update one seat, pulse, update counts
         ├─ 'counts' event  ─► header counters
         └─ 'reservation' event ─► prepend to event feed, trim to 20

```

Reconnection: `EventSource` handles exponential backoff automatically. On reconnect, we discard local seat state and wait for the next `baseline` event — this guarantees we never show stale state after a disconnect.

## 7. States

| Dashboard state | Trigger | What user sees |
|---|---|---|
| `loading` | page just opened | spinner, "connecting to show …" |
| `live` | baseline + SSE connected | full grid, live updates |
| `reconnecting` | SSE `error` event | amber badge, grid frozen at last known state |
| `show not found` | `GET /shows/:id` → 404 | centered message with input to pick a show |
| `no show selected` | URL has no `?show=` | input: `show id or name` + "load" button |

## 8. Accessibility

- Minimum 4.5:1 contrast for all text on fills (checked at design time).
- State encoded by both color AND text label (never color-only).
- Seat grid is a `<table>` with `<caption>` naming the show; each seat `<td>` has `aria-label="seat A12, confirmed"`.
- SSE events announced via `aria-live="polite"` region (opt-in via a toggle; defaults off because it's noisy during a burst).
- Keyboard: `?show=` input is tab-focusable; grid is read-only so no interactive focus needed.
- No animations when `prefers-reduced-motion` is set — pulse becomes a static color swap.

## 9. HTML skeleton (indicative, not final)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seat Reservation — Live Dashboard</title>
  <style>/* ~60 lines of scoped CSS */</style>
</head>
<body>
  <header>
    <h1 id="show-name">—</h1>
    <span id="conn-status" class="status loading">connecting…</span>
    <div id="counts">available <b id="c-available">—</b> · held <b id="c-held">—</b> · confirmed <b id="c-confirmed">—</b> · total <b id="c-total">—</b> <span id="reconciled"></span></div>
  </header>
  <main>
    <section id="seat-grid-wrap">
      <table id="seat-grid" aria-live="off"><caption id="grid-caption">seats</caption></table>
    </section>
    <aside id="feed">
      <h2>recent</h2>
      <ol id="feed-list"></ol>
    </aside>
  </main>
  <script type="module">
    // ~80 lines: parse URL, fetch baseline, open EventSource, dispatch events to DOM updaters.
  </script>
</body>
</html>
```

## 10. SSE event schema (contract with backend §10.3)

```json
// baseline — sent once on connect and on each reconnect
{ "type":"baseline", "counts":{"available":198,"held":0,"confirmed":2,"total":200},
  "seats":[{"seat_id":"A1","status":"available"}, ...] }

// seat — one seat changed state
{ "type":"seat", "seat_id":"A12", "status":"confirmed", "user_id":"u_42", "at":"2026-10-04T10:15:30.142Z" }

// counts — periodic, only if changed since last emit
{ "type":"counts", "available":197, "held":0, "confirmed":3, "total":200 }

// reservation — a reservation was created or cancelled
{ "type":"reservation", "reservation_id":"rs_01HV8K...", "user_id":"u_42",
  "seats":["A12"], "outcome":"confirmed", "at":"2026-10-04T10:15:30.142Z" }
```

The backend MUST send `baseline` within 500ms of connect; dashboard enters `live` state only after receiving it.

## 11. Testing

Manual script, included in `README.md`:

1. Open `/dashboard?show=<id>` in two browser tabs.
2. From a third tab (or `curl`), reserve a seat.
3. Both dashboards flash that seat → red within 200ms.
4. Cancel the reservation.
5. Both dashboards flash the seat → gray.
6. Run `./burst.sh` and watch the grid repaint in real time; verify reconciliation badge stays green throughout.
7. Pause the Node container (`docker pause`), see badge go amber then red; unpause, see baseline arrive.

No automated frontend tests. The dashboard is observability-only; its correctness is verified by eye against the API state, which has its own test suite.

## 12. What this intentionally skips

| Skipped | When to add |
|---|---|
| Charts / graphs over time | If we need to prove latency or throughput visually (Grafana is better) |
| Multi-show selector / nav | If we have more than one show in demo |
| Dark mode | If someone is actually using this at night |
| Export / snapshot button | If an interviewer asks "can I save this view" |
| Authenticated per-user view ("show my reservations") | Changes dashboard from observability tool to buyer tool — scope creep |
| Build pipeline (Vite, bundler) | When the single file exceeds ~300 lines |

---

## Approval

This dashboard is deliberately small. One file, no deps, under 200 lines, serves the exercise's "Deploy & Observe" need directly. Review and either approve or push back on specific items; after approval it becomes task #12 in the implementation plan.
