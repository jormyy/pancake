# Public league pages

Anyone can find a league by name and read every public CLI resource without signing in, JavaScript, or tools.
The pages are Markdown served by the `api` Edge function at `/public/web` and `/public/web/<resource>`.
They take the same options as `/public/v2/<resource>` and the CLI and show the same records.

## Sub-features

- `public-web-discovery` links the homepage's `noscript` block to the start page, which lists leagues and explains name search.
- `public-web-search` resolves a full name, a partial name, an ambiguous name, and a missing name.
- `public-web-parity` shows each resource with every filter, sort, direction, limit, and cursor exactly as JSON does.
- `public-web-privacy` never shows deleted leagues, account emails, invite codes, pending trades, notes, or claims.
- `public-read-limit` admits 240 JSON, CLI, and page reads per client IP per minute, then returns 429 with `Retry-After`.

## How to get to it (user POV)

- Open the homepage without JavaScript and follow Browse public leagues.
- Follow a league's League home link, then a resource link such as Standings or Schedule.
- Add `?query=NAME` to the leagues page to search.

## Driving it

Launch normally, then apply any new checkout migration and rebuild before checking.
Add synthetic fixtures in the disposable database: a second active league whose name contains the first one's name, a deleted league, and a pending-trade note.
Write every private value to a sentinel file in the evidence directory: account emails, invite codes, non-completed trade ids, claim ids, the note, and the deleted league's name.

```sh
node tools/verify/public-web.mjs --api="$E2E_API_BASE_URL" --frontend="$E2E_FRONTEND_URL" \
  --name='<league name>' --ambiguous='<text both active names contain>' --missing='Nonexistent Club' \
  --forbid-file="$EVIDENCE/private-sentinels.txt" --limit-ip=198.51.100.40 --receipt="$EVIDENCE/public-web-receipt.json"
```

The tool follows the homepage link, runs the four searches, and compares every page with its JSON source per resource, filter, sort, direction, limit, and cursor.
It fails if any sentinel appears in any response.
`--limit-ip` sends 240 mixed JSON and page reads from 12 concurrent readers under one synthetic `CF-Connecting-IP` in one minute.
It then requires read 241 to return 429 with `Retry-After`, another IP to read normally, and the same IP to read after the reset.
Use `--limit-ip` only on the disposable stack; hosted Cloudflare replaces the header.
Against production, omit `--limit-ip` and `--forbid-file`; the tool waits out 429 responses.

## Proof

Keep the receipt, the sentinel file, and a copy of the start, search, league home, and standings pages.
The receipt must show `passed: true` and zero skipped checks, or name the missing public data.
