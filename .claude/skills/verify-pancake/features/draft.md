# Draft rooms

Managers join auction, rookie, and practice drafts to select players and review the draft board.

## Sub-features

- `draft-auction` nominates, bids, and settles an auction pick.
- `draft-rookie` selects an eligible rookie on the active turn.
- `draft-mock` creates, joins, starts, and leaves a practice room.
- `draft-board` shows pick ownership and completed selections.
- `draft-timer` displays pause, resume, and expiry behavior.

## How to get to it (user POV)

- League → Draft → enter the auction room.
- League → Draft → Join Rookie Draft.
- League → Draft → New mock room, or join an existing room.
- Open the current draft from the main draft navigation or a saved room link.

## Driving it with agent-browser

Preconditions:

- Require a draft of the correct type, an active turn, eligible players, and at least two participating seeded managers.
- The baseline startup auction is completed to unlock season play. Create a mock room for auction actions.
- New rooms default to a start 30 minutes ahead. Set the visible start field to the current league time for an immediate room.
- The verification seed attaches current-season pick assets and supplies two unrostered rookies.

- **Practice.** From League choose Draft, then New mock room. Snapshot the room form, create a named disposable room, join it with another seed account, and start it.
- **Auction.** Select an available player and nominate through the visible control. As the other manager, bid above the current price. Require bidder, price, and budget changes.
- **Settlement.** Let the timer expire or use an authorized commissioner control. Require the winning roster player and draft budget debit in the database.
- **Rookie.** Choose `Join Rookie Draft` from Draft. On the active manager’s turn, select an eligible rookie with its Pick button. Require the pick on the board and its stored owner.
- **Timer.** Pause and resume as commissioner. Require stable remaining time while paused and progression after resume.
- **Widths.** At 375×812, require the active player, bid/pick control, and timer to remain visible or reachable.

## Gotchas

- A completed startup auction cannot prove live bidding.
- A room with only one participant cannot prove competing bids or turn changes.
- Mock results must not alter the real league roster. Compare both stored states.
- Timer screenshots alone do not prove pause or expiry; record observations across time.
