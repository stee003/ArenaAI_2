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
