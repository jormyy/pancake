# Code Review - codex/annual-draft-sync (2026-06-27)

base: 19c1d1c | converge: 1 | test: npm test && npm test --workspace backend && npm run typecheck
notes: created by loopctl

| # | verdict | findings | commits | loc_delta | tests | notes |
|---|---|---|---|---|---|---|
| 1 | BLOCK | 2/2/2 | 1 | 90 | pass | Multi-axis workflow (5 axes x verify): 12 raised, 6 confirmed, all fixed — CR-1 bid-reset clobber (High), CR-5 withdraw permanently-removed-player (->DELETE, prod), CR-2/3/4 test guards strengthened, CR-6 orphaned /notify ref removed |
| 2 | APPROVE | 0/0/0 | 1 | 8 | pass | Second fresh-eyes pass over post-fix + nomination-modes diff: 2 raised, 0 confirmed; CR-7 transient-null bid-reset edge hardened proactively; by_projection ordering nuance accepted/documented |
