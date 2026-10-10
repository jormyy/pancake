# Trade veto read policy

`trade_vetos_select` checked `trade_id IN (SELECT t.id FROM trades t ...)`.
That subquery ran the trades read policy, `private.can_read_trade(id)`, on every
row of `trades` for each read. Trade pages and veto realtime checks therefore
slowed as all leagues' trade history grew, not only the reader's leagues.

The effective rule was already `private.can_read_trade(trade_id)`. The policy
now evaluates that rule per veto row, as `trade_participants` and `trade_items`
do. Visible rows are unchanged for parties, non-party members, non-members and
other leagues; anonymous users still have no read grant.

The exact PostgREST trades embed ran five interleaved pairs per size as a
signed-in member. With 452 trades in the table each 40-trade page fell from
about 51 ms to about 22.5 ms. With 1,052 trades (600 in leagues the reader
cannot see) it fell from about 213 ms to about 24 ms. These are isolated local
measurements, not iPhone or production latency claims.

The migration replaces one policy and adds no table, index, grant or function.
Recovery restores the previous policy statement from
`20260328000004_rls_policies.sql` inside one transaction. Use a bounded lock
timeout; the policy swap takes a brief lock on `trade_vetos` only.
