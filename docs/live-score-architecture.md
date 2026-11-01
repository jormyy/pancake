# Shared live scores

The public source and score overlay are implemented. Phone wiring and checkpoint ingestion are still in progress. No deployment has occurred.

## Public route

`GET /api/live/YYYY-MM-DD` reads public NBA and ESPN feeds. It accepts today or yesterday in Eastern Time. It never reads Supabase or forwards request credentials. The payload contains game IDs, team codes, clocks, source times, and compact player lines. It contains no league or user data.

The root `api/live/[date].ts` function runs beside the static Expo output. Its rewrite precedes the static fallback. Vercel supports an `api` directory with a separate output directory. See [build configuration](https://vercel.com/docs/builds/configure-a-build).

Responses use `s-maxage=30`, `stale-while-revalidate=15`, and `stale-if-error=90`. The origin has no second timed cache. Concurrent origin requests share one fetch. Phones must reject snapshots older than two minutes, even if a CDN returns them. See [cache directives](https://vercel.com/docs/caching/cache-control-headers).

`LIVE_SCORES_OFF=1` selects database mode. The route then returns no player lines and makes no upstream requests. Worker and phone integration must honor this same response.

The route rejects bodies above 1 MB. This is below the 4.5 MB function response limit and the 10 MB non-streaming cache limit. See [function limits](https://vercel.com/docs/functions/limitations) and [CDN cache limits](https://vercel.com/docs/caching/cdn-cache).

## Initial source measurement

The local source probe returned seven games on November 1, 2026: 11,400 bytes raw, 3,463 bytes gzip, and 350 ms wall time. The evidence is `evidence-climb/provider-connectivity.json`. This proves source access from this Mac. It does not measure a live Vercel function.

The planned 15-second phone poll produces 432,000 monthly requests for ten phones, six hours per night, thirty nights. A thirty-second worker adds 21,600 requests. At the measured size, 453,600 responses transfer 5.17 GB raw or 1.57 GB gzip. These are estimates until the complete replay measures the final payload.

With one shared cache region, thirty-second misses produce at most 21,600 origin calls during those hours. Eleven independent regions produce at most 237,600. That upper estimate transfers 2.71 GB of raw origin responses. Cache outages can increase calls; the request total remains the conservative upper bound.

Current [Hobby allowances](https://vercel.com/docs/plans/hobby) include one million CDN requests, one million function invocations, 100 GB transfer, 10 GB origin transfer, four active CPU hours, and 360 GB memory-hours. Request and transfer estimates are below half those allowances. CPU and memory need direct measurement before acceptance. Public traffic beyond these ten phones is outside this estimate.

## Validation

The route tests cover source fallback, public-only output, the off switch, invalid requests, source errors, request coalescing, and routing order. The local cache tests cover thirty-second expiry and bounded stale responses. The core overlay tests cover starter deltas, source identity, stale fallback, duplicate rows, invalid lines, and official finals.

The unchanged ingestion path remains available for the off switch and official saves. It must not be removed while the switch depends on it.
