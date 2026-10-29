# Trade receipts

A replay requires current league membership and ownership of the original request.
Former owners, removed members, and other members receive an authorization error.
The original owner receives the committed result, even when balances or offer status change.

The regression runs through `npm run test:db:trade-offer-retries`.
It also runs directly from `tests/db/regressions/trade-receipt-former-owner.sql`.

## Trade receipt release order

Apply migration `20261202000100` to enforce receipt authorization.
Existing clients and API routes use the same function signature and authorization error code.
