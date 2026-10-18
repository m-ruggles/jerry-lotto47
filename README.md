# Jerry's Lotto 47 Board

A one-page Michigan Lotto 47 dashboard for Grandpa Jerry. Static files only, served by Cloudflare Workers (static assets).

- `public/index.html` — the page. All statistics are computed in the browser from `draws.json`.
- `public/draws.json` — every draw: `[{date: "YYYY-MM-DD", n1..n6}]`, sorted by date, main numbers only (no Double Play).
- `public/robots.txt` and `public/_headers` keep search engines from indexing the page.

A scheduled Claude task adds new draws to `draws.json` on Thursday and Sunday mornings and commits them; Workers Builds redeploys on each push.
