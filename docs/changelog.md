# Changelog

## 2.15.0 — Live scores with fewer database writes

- Live matchup screens share a compact public score feed, refreshed every 30 seconds while visible.
- Official scores, lineup locks, trades, waivers, and permissions remain server-controlled.
- Stale feeds show saved scores with a stale state; completed games keep official results.
- Background updates follow the approved schedule, with 30-minute recovery checkpoints.
- Smaller screen responses and fewer unnecessary refreshes reduce transfer and connection churn.

See [release notes](release-2.15.md) for local results, operating risks, and rollout requirements.
Earlier release records remain in [database release history](../supabase/RELEASE-DB.md).
