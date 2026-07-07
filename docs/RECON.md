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
- Filters worth mapping later: `category_ids=100`, price min/max, `order_by`
  (`newest` vs `closest`). Discover exact param names from the web app's network tab
  when building the adapter.
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
- **Open questions (Phase 2 recon, needs authed session):** chat transport (historically
  XMPP; verify), login/session persistence in a Playwright profile, rate-limit thresholds.

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
