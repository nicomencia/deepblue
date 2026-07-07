# Platform recon findings

> Verified 2026-07-07 from a Spanish residential IP with plain `curl` (no browser).
> This knowledge rots: re-verify before relying on it after any long gap.

## Headline

**Phase 1 ingestion needs no browser on either platform.** Both search surfaces are
readable over plain HTTP today. Playwright is only needed for Wallapop *chat* (Phase 2).
Search jobs should still run through the Runner (residential IP, consistent fingerprint,
jittered pacing), just via HTTP instead of a browser.

## Wallapop

- `GET https://api.wallapop.com/api/v3/search?source=search_box&keywords=...&latitude=...&longitude=...`
  - **HTTP 200** with headers: browser `User-Agent` + `X-DeviceOS: 0`. **403 without `X-DeviceOS`.**
  - Response: `data.section.payload.items[]` — 40 items/page.
  - Item fields: `id`, `title`, `description`, `price {amount, currency}`, `category_id`
    (cars = **100**), `web_slug` (public URL: `wallapop.com/item/<web_slug>`), `location`
    (lat/lon, postal code, city), `created_at`, `modified_at`, `reserved`, `images`, and
    `type_attributes` = **`{brand, model, year, version, km, engine, horsepower}`** — the
    full normalization payload for free.
  - Pagination: `meta.next_page` is a JWT-style opaque token (pass as `next_page=` param).
- `GET api.wallapop.com/api/v3/cars/search` responds 200 but returned 0 items for all
  param styles tried — appears deprecated in favor of general search. Don't use.
- **Native filters (all verified live 2026-07-07 by checking results respect them):**
  - `category_id=100` — **singular**. The plural `category_ids` is silently IGNORED,
    and without the singular one, all car-specific filters below are ignored too.
  - `min_year`, `max_km`, `max_sale_price`, `min_sale_price` — respected within
    the category context. `min_sale_price` also skips financing/installment posts
    (329–421 € "cars" are monthly-quota ads, not prices).
  - `engine` — values: `gasoline`, `gasoil` (diesel), `hybrid`, `electric`
    (verified: `engine=gasoil` → all-Diesel results).
  - `order_by=newest` — respected (verified via created_at ordering). Default is
    `closest`.
  - Unverified (assumed to exist, not sent): `max_year`, `min_km`, `gearbox`
    (can't verify from search payload — no gearbox field in search items).
- `GET https://api.wallapop.com/api/v3/items/{item_id}` — **HTTP 200**, same headers.
  Detail `type_attributes` come wrapped as `{value, text}` and add what search omits:
  **`gear_box`**, `horsepower`, `doors`, `seats`, **`eco_label`** (DGT badge), `body_type`.
  Also `description.original` (full text), `counters` (views/favorites/**conversations** —
  demand signals), `user.id`.
- `GET /api/v3/users/{user_id}` — **HTTP 200**: `micro_name`, `type`
  (`normal` = private; anything else = professional), `register_date`, `is_top_profile`.
- `GET /api/v3/users/{user_id}/stats` — **HTTP 200**: `rating_average` (0–5),
  counters: `reviews`, `sold`, `sells`, `publish`, `buys`, **`reports_received`**.
  Feeds the sellerCredibility factor; fresh 0-review/0-sale profiles selling cars are
  a classic scam pattern. Note: high `sells` with ~0 reviews = high-volume pro
  (compraventa) posing as private — worth its own signal later.
### Chat transport (Phase 2) — mapped 2026-07-07, unauthenticated probing

The old XMPP/`mucbot` realtime host is **gone** (`mucbot.wallapop.com`, `comet.wallapop.com`
no longer resolve). Chat is now a plain **OAuth2 Bearer REST API** on `api.wallapop.com/api/v3`,
which is good news: it fits our poll-based Runner job model with no websocket.

- **Inbox read:** `GET /api/v3/conversations` (params incl. `max_messages`).
  - Bearer token required. Bogus token → **401** `{"code":"ACCESS_TOKEN_EXPIRED"}` +
    header `X-Wallapop-Unauthorized: ACCESS_TOKEN_EXPIRED`. **No** `Authorization` header
    at all → 405 (gateway rejects the verb before auth). So the endpoint is real and
    token-gated; a valid access token is the only thing standing between us and the inbox.
- **Open/send:** `POST /api/v3/conversations` — real (403 without auth, not 404). Exact
  message sub-resource shape (`.../messages` vs. embedded) needs a live token to map.
- **Login:** `POST /api/v3/access/login` → **400** on empty body (exists; email/password
  lane). `POST /oauth/token` → **302** (OAuth authorize/redirect lane). Token expiry has a
  refresh flow (implied by `ACCESS_TOKEN_EXPIRED`).
- **Request signing is in play.** The CORS preflight (`OPTIONS /api/v3/conversations`)
  advertises accepted headers: `authorization`, `x-auth-token`, `timestamp`, **`x-signature`**,
  plus `X-Wallapop-{Session-Token,User-Id,Device-Id,Client-Id}`. `timestamp`+`x-signature`
  = client-side HMAC request signing. We will **not** reverse-engineer it.

**Transport decision (drives Phase 2 build):** Runner uses a **persistent, logged-in
Playwright profile** and issues chat calls via `page.evaluate(fetch …)` **inside the
authenticated page context** — the page's own JS injects `authorization` + `x-signature` +
device headers for us. Robust to Wallapop updates, indistinguishable from the user, no
signing algorithm to maintain. Poll `GET /conversations` on a gentle schedule (`fetch_replies`
job); send via `POST` through the same context; Core's `draft_only` approval gate sits
before any send.

- **Still needs a live authed session to nail down:** message sub-resource shape, whether
  `x-signature` is enforced on send, token/refresh lifetime, rate-limit thresholds. Login
  itself must be **headful on the user's machine — the user types credentials, never pasted
  to the agent.**

## AutoScout24 (Spain)

- `GET https://www.autoscout24.es/lst/<make>/<model>?fregfrom=2016&priceto=20000...`
  - **HTTP 200** with a plain browser UA. Server-rendered Next.js page.
  - `<script id="__NEXT_DATA__">` embeds full JSON: `props.pageProps.listings[]`
    (20/page), `numberOfPages`, `numberOfResults`.
  - Listing fields: `id`, `url` (relative), `price.priceRaw`, **`price.priceEvaluation`**
    (AS24's own price rating — free benchmark signal), `vehicle {make, model,
    modelVersionInput, transmission, fuel, mileageInKm}`, `vehicleDetails[]`
    (km, gearbox, month/year, fuel, power), `seller {type: Dealer|..., companyName}`,
    `location {zip, city, countryCode}`, `images[]`.
  - URL filter params observed: `fregfrom` (first registration year from), `priceto`.
    Full param vocabulary discoverable from the site's filter UI.
- Sellers are predominantly dealers → contact flows into email threads (the Core's
  cloud-only lane, per PROJECT.md).
- **Open questions:** contact-form submission mechanics (form POST vs API), whether
  dealer replies reliably arrive to the provided email address.

## Hygiene rules for both

- Low volume, jittered timing, active-hours only; cache aggressively (`listings` table
  is the cache). A personal-use footprint — a few sweeps per brief per day — is the goal.
- Treat every 403/429 as a signal to back off, never to retry harder.
