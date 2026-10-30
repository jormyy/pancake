export function realtimeQueryKind(query) {
  const text = query.replaceAll('"', '').replace(/\s+/g, ' ')
  const walPoll = /realtime\.list_changes|wal->>/i.test(text)
  const catalog = /pg_publication/i.test(text)
  const authorizationContext = /set_config\s*\(\s*'realtime\.topic'\s*,/i.test(text)
  const authorize = /realtime\.authorize/i.test(text)
    || /\bSELECT\b.*\bFROM\s+realtime\.messages\b/i.test(text) && /\btopic\b/i.test(text) && /\bid\b.*\bANY\s*\(/i.test(text)
  return { realtime: /\brealtime\s*\./i.test(text) || walPoll || catalog, walPoll, catalog, authorize, authorizationContext }
}
