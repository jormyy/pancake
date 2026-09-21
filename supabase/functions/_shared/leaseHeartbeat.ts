// Keeps a TTL lease alive while a long run is in progress. try_live_poll_lease
// hands out a 90 s lease and a busy night's poll can outrun it, after which a
// second worker takes the lease and both write (probe P2, 2026-09-12). The
// heartbeat renews at a third of the TTL; when a renewal reports the lease was
// lost, `lost` flips; live-poll checks it before the game-status upsert and
// before the stats/scores sync pair and bails out with 'lease-lost' instead of
// writing beside the new holder (writes already in flight are not cancelled).
export type LeaseHeartbeat = {
  stop: () => void
  readonly lost: boolean
}

export function startLeaseHeartbeat(
  renew: () => Promise<boolean>,
  intervalMs: number,
  onLost: (error?: unknown) => void = () => {},
): LeaseHeartbeat {
  let lost = false
  let stopped = false
  let inFlight: Promise<void> | null = null
  const tick = () => {
    if (stopped || lost || inFlight) return
    inFlight = renew()
      .then((held) => {
        if (stopped) return // released on purpose; a late renewal is not a loss
        if (!held && !lost) { lost = true; onLost() }
      })
      .catch((error) => {
        if (stopped) return
        if (!lost) { lost = true; onLost(error) }
      })
      .finally(() => { inFlight = null; if (lost) clearInterval(timer) })
  }
  const timer = setInterval(tick, Math.max(intervalMs, 1))
  return {
    stop: () => { stopped = true; clearInterval(timer) },
    get lost() { return lost },
  }
}
