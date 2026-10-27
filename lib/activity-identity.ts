export type ActivityPlayerIdentity = { id: string; name: string }

export function activityPlayerMentions(value: unknown): ActivityPlayerIdentity[] {
  if (!value || typeof value !== 'object') return []
  const row = value as Record<string, unknown>
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {}
  const raw = row.playerMentions ?? row.player_mentions ?? metadata.player_mentions
  const candidates: unknown[] = Array.isArray(raw) ? raw : [{ id: row.playerId, name: row.playerName }]
  const result = new Map<string, ActivityPlayerIdentity>()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const player = candidate as Record<string, unknown>
    if (typeof player.id !== 'string' || !player.id.trim() || typeof player.name !== 'string' || !player.name.trim()) continue
    if (!result.has(player.id)) result.set(player.id, { id: player.id, name: player.name })
  }
  return [...result.values()]
}
