# Potluck — MVP

**The best tables in town aren't in restaurants.** Potluck is Shopify for hosted
micro-experiences: ticketed supper clubs run by the city's best cooks — from
backyards, borrowed wine bars, and restaurants' dead nights.

This is the v1 demo build: a fully client-side single-page app (no build step,
no dependencies) with AI-generated editorial photography in `/assets`.

## What's working

- **Discovery feed** — "This week's tables" for the launch city (Austin), with
  category filters (incl. workshops), scarcity badges, and seat-inventory bars
- **Event pages** — menus, host cards with follow buttons, guest reviews,
  house rules, sticky booking panel
- **Pick-your-seat booking** — tap your chairs around one shared table; seat
  inventory and dietary notes flow through checkout (test mode) with a $25/seat
  no-show deposit narrative
- **First Chair membership ($10/mo)** — working paywall with real in-app
  effects: book locked drops instantly, $0 service fees at checkout, member
  chip in nav, fees-waived tracking, cancellation
- **Scarcity mechanics** — sold-out events roll to an automated waitlist;
  one "locked" room (Midnight Ramen) drops Sundays at 6pm with a live
  countdown and notify-me capture
- **Cancellations** — "Can't make it?" returns seats to inventory, promotes
  the waitlist's #1, and simulates the refund
- **Referral credit** — invite-a-friend banks $10 that auto-deducts at the
  next checkout
- **Host dashboard (demo)** — KPIs, revenue chart, guest list with dietary
  notes, open venue nights (the third side of the marketplace), and a
  publish-a-table flow that pushes a genuinely bookable event into the feed
- **Weekly drop capture** — email signup (the owned channel), personalized
  on return
- **"My seats"** — tickets persist in `localStorage`, with calendar (.ics)
  export and seat chips
- Accessibility: reduced-motion support, ARIA labels, lazy-loaded images,
  Escape-to-close modals

## Run it

**Full mode (recommended)** — static app + API with shared live inventory:

```bash
cd potluck
node server.js          # serves on 0.0.0.0:8080, no npm install needed
# open http://localhost:8080 in two browsers — bookings sync across both
```

`server.js` is zero-dependency (no packages): it serves the static files and a
small JSON API (`/api/state`, `/api/book` with atomic claims + 409 conflicts,
`/api/cancel`, `/api/publish`, `/api/waitlist`, `/api/track`). State persists
to `data.json` (gitignored); delete it to reset the world.

**Offline demo mode** — any static file server also works
(`python3 -m http.server 8080`): the app detects there's no API and falls back
to a fully local `localStorage` world.

## Stack

Hand-crafted HTML/CSS/JS in a single `index.html`. Fraunces + Space Grotesk.
Photography in `assets/` is AI-generated for this demo. Payments shown are
simulated — wire to Stripe Connect for the real thing.

## v5 — accounts & event-day ops

Same zero-dependency server, new in addition to v4:

- **Sign in without passwords**: `POST /api/auth/request` issues a one-time code
  (the demo build returns it in the response as `devCode` since it can't send
  email — that's the "demo inbox"); `POST /api/auth/verify` trades it for a
  `tk_…` session token. Client falls back to offline code `482916`.
- **Your seats, synced**: `GET /api/me?token=` returns the account's bookings;
  bookings made while signed in (`authToken` on `/api/book`) follow you across
  browsers and show as "✓ synced".
- **Day-of host tools**: `POST /api/checkin {code}` validates tickets at the
  door — `ok` / `already` (duplicate scan, timestamped) / 404 (fake). The
  dashboard also has a "Message your people" blast composer with simulated
  delivery/open/reply stats — the owned-channel story, no Instagram required.
- **Ticket visuals**: deterministic QR-style pattern per booking code (with
  finder squares), plus a confirmation-email preview styled like the real
  address-reveal email a real product would send.

Everything degrades gracefully to the pure-localStorage demo when the API is
unreachable.

## v6 — the marketplace loop (pricing, the waitlist machine, earned reputation)

- **Server-authoritative dynamic pricing**: `/api/state` now serves live
  prices. Early-bird tiers (e.g. hotpot: first 6 seats at $39, then $45)
  flip automatically as seats sell — every browser toasts the flip. The
  server reads the tier *before* claiming seats and returns the unit price
  charged on every booking; the client can only display, never argue.
- **The waitlist machine**: freed seats no longer sit there. Cancel a
  booking and the first human in line gets a 10-minute expiring claim
  window (`/api/waitlist/claim` after the offer shows up in `/api/me`).
  Let it lapse and it rolls to the next person. Polling clients drive the
  sweep, so the machine moves as long as anyone anywhere has the app open.
  Offers are email-bound — nobody can steal your spot.
- **Field notes, not reviews**: `POST /api/review` only accepts a note when
  the booking was actually **checked in at the door** and hasn't been
  reviewed — reputation you can't fake, farm, or drive-by. Ratings roll up
  per table into `/api/state` (avg, count, latest quotes) and render on
  cards and event pages as "★ from verified seats".
- **Live ledger for hosts**: per-host payout aggregates (gross / 12% fee /
  net-to-Friday, seats & party counts) derived from the real bookings
  ledger and streamed in every state poll — the dashboard moves when any
  browser books.

Chapters 1–5's economics, now closing the loop: scarcity prices itself,
empty chairs resell themselves, and trust compounds one verified note at a
time.
