# Pancake CLI

Requires Node 22 or later. No runtime packages are needed.

```sh
npm install -g ./packages/pancake-cli
export PANCAKE_API_URL=https://your-pancake-api.example/functions/v1/api
export PANCAKE_TOKEN=your-league-share-token
pancake standings --json
pancake describe
pancake explain standings.pointsFor
```

A commissioner creates the share token. Treat it as a league read credential.
The API never returns pending offers, bids, private notes, lineups, emails, or user identifiers.
Use `pancake describe` for schemas, commands, filters, and exit codes.
`db-health --operator-connection` is private. It needs PostgreSQL operator access and the `psql` executable.
