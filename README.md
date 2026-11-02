# Jerry's Lotto 47 Board

A one-page Michigan Lotto 47 dashboard for Grandpa Jerry, served by Cloudflare Workers.

- `public/index.html` — the page. All statistics are computed in the browser from the draws.
- `public/draws.json` — the draw history up to Oct 17, 2026: `[{date: "YYYY-MM-DD", n1..n6}]`, sorted by date, main numbers only (no Double Play). No longer updated.
- `src/worker.js` — a small Worker for `/api/*`. Draws Jerry enters on the page are saved in a SQLite-backed Durable Object (`DrawStore`), which Cloudflare creates on the first deploy. Everything else is served from `public/`.
- `public/robots.txt`, `public/_headers` and the API's `X-Robots-Tag` keep search engines from indexing the site.

## Entering draws

Jerry adds each Wednesday and Saturday drawing with the **Add a drawing** box at the top of the page. The page lists drawings since Oct 17, 2026 that have not been entered yet. An entered draw on a date that is already in `draws.json` replaces it (the page asks first), and removing that entry brings the original back.

Saving or removing needs the entry PIN. It is the Worker secret `ENTRY_PIN`, set in the Cloudflare dashboard under the Worker's Settings > Variables and Secrets (type: Secret). It is never stored in this repo. Until it is set, the page says entry is not switched on. Five wrong PINs in a row pause entry for 15 minutes. The page can remember the PIN on Jerry's computer.

API:

| Method | Path | PIN | Does |
|---|---|---|---|
| GET | `/api/draws` | no | Entered draws, and whether entry is switched on |
| POST | `/api/pin` | yes | Checks the PIN |
| POST | `/api/draws` | yes | Adds or replaces one draw: `{date, numbers: [6 numbers]}` |
| DELETE | `/api/draws/YYYY-MM-DD` | yes | Removes an entered draw |

The PIN goes in the `X-Entry-PIN` header.

## Deploying

Workers Builds deploys `main` on each push (`wrangler deploy`). The Durable Object migration (`v1`) runs on the first deploy that includes it.
