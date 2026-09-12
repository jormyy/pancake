// Keeps a TTL lease alive while a long run is in progress. try_live_poll_lease
// hands out a 90 s lease and a busy night's poll can outrun it, after which a
// second worker takes the lease and both write (probe P2, 2026-09-12). The
// heartbeat renews at a third of the TTL; when a renewal reports the lease was
// lost, `lost` flips so the caller can stop treating itself as the holder.
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
        if (!held && !lost) { lost = true; onLost() }
      })
      .catch((error) => {
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
