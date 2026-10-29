const view = {
  cacheKey: 'pancake:screen-view:v1:<canonical account, league, member, season, screen, parameters>',
  warmSource: 'memory or localStorage view envelope; league scopes include the selected league date',
  ttl: 'no age expiry; online reads validate the league version before reusing a clean envelope',
  sizeBound: '48 screen entries and 4 MiB in total',
  invalidation: 'relevant league-version topics mark matching views dirty; account changes clear the views',
  reconnect: 'focused active screens validate versions, then request dirty or forced views',
  failureFallback: 'render the saved scoped envelope; show a refresh error; offline reads make no request',
}

const overrides = {
  'app-shell': { outgoing: 'no application writes from the Service Worker', writePolicy: 'the shared API and guarded RPC transports manage pending writes' },
  'auth-session': { outgoing: 'Supabase Auth sign-in, sign-up, sign-out and password operations', writePolicy: 'authentication requires the server; the gameplay mutation queue does not store passwords' },
  'league-memberships': { outgoing: 'POST RPC create_league, join_league_by_invite_code and save_client_settings_atomic', writePolicy: 'guarded RPCs queue by account when offline; the server rechecks membership on replay' },
  'matchup-lineup': { ...view, coldSource: 'GET /functions/v1/api/views/home or /views/lineup; selected date and matchup parameters' },
  'live-stats': { ...view, coldSource: 'scores and player statistics in the home or lineup view', realtimeEvent: 'league-version messages for game, stat, score, and lineup topics' },
  'player-search': { ...view, coldSource: 'GET /functions/v1/api/views/players; query, filters, sort, season and 20-row page', warmSource: 'saved query-specific player view and mounted search state' },
  'player-detail': { ...view, coldSource: 'GET /functions/v1/api/views/player; overview first, then games, news or history when opened' },
  roster: { ...view, coldSource: 'GET /functions/v1/api/views/roster; roster, picks, claims, priority and transaction state' },
  waivers: { ...view, coldSource: 'roster view with section=waivers; claim-editor view for the selected player', realtimeEvent: 'league-version messages for claim, roster, inventory and member topics' },
  trades: { ...view, coldSource: 'GET /functions/v1/api/views/trades or /views/trade-block; tab and 40-row page', realtimeEvent: 'league-version messages for trade, roster, inventory, member and settings topics' },
  'draft-picks': { ...view, coldSource: 'league picks section, trade-block view or composer pick RPCs' },
  'league-tabs': { ...view, coldSource: 'GET /functions/v1/api/views/league; selected tab and 50-row activity page' },
  'profile-data': { ...view, coldSource: 'GET /functions/v1/api/views/profile; profile and notification preferences', warmSource: 'account-only saved profile envelope; local edits patch mounted state', ttl: 'no age expiry; online loads fetch the current profile', reconnect: 'online focus refreshes the profile; profile events update mounted data' },
  'active-draft': { cacheKey: 'pancake:draft-launcher:v1:[account,league,member]; league draft-tab view', warmSource: 'saved draft or explicit no-draft result', ttl: 'launcher: 24 hours; league view: version-based', sizeBound: 'launcher shares the 64-entry persistent-cache limit; league views share 48 entries and 4 MiB' },
  'auction-room': { cacheKey: 'pancake:auction-room:v1:<account>:<member>:<draft>; draft-room screen view', warmSource: 'saved room state and mounted draft state', ttl: 'room snapshot: 24 hours; draft-room view: version-based', sizeBound: 'room snapshots share 64 persistent entries; screen views share 48 entries and 4 MiB' },
  'rookie-room': { cacheKey: 'pancake:rookie-room:v1:<account>:<member>:<league>:<draft>; :prospects; draft-room screen view', warmSource: 'saved room, prospects and mounted draft state', ttl: 'room snapshots: 24 hours; draft-room view: version-based', sizeBound: 'room snapshots share 64 persistent entries; screen views share 48 entries and 4 MiB' },
}

const writes = {
  'matchup-lineup': 'POST RPC set_player_slot_moves_atomic and save_client_settings_atomic; POST /league/lineup/auto-set-season',
  roster: 'POST RPC add_free_agent_atomic, drop_and_add_free_agent_atomic, drop_player_atomic and activate_roster_player_with_lineup_atomic',
  waivers: 'POST /waivers/claims; POST /waivers/claims/:id/edit, cancel or reorder',
  trades: 'POST /trades/propose or propose-multi; POST /trades/:id/accept, reject, counter, counter-multi, edit, edit-multi, withdraw, veto, roster-plan or taxi-destinations; POST /trades/block or /trades/block/:id/remove',
  'draft-picks': 'pick ownership changes through accepted trades and draft actions',
  'league-tabs': 'POST RPC update_league_configuration_atomic, commissioner_adjust_faab_balance_atomic and commissioner_override_weekly_add_count_atomic',
  'profile-data': 'PATCH /rest/v1/profiles; upload /storage/v1/object/avatars; POST RPC save_client_settings_atomic for notification preferences',
  'active-draft': 'POST /draft/start or start-rookie; POST /draft/:id/pause, resume, stop or reset',
  'auction-room': 'POST /draft/:id/nominate, bid, withdraw-nomination or close-expired',
  'rookie-room': 'POST /draft/:id/snake-pick, commissioner-pick, process-expired-pick or reseed-picks',
}

export function currentDataClasses(classes) {
  return classes.map(row => ({ ...row, ...overrides[row.id], ...(writes[row.id] ? { outgoing: writes[row.id] } : {}) }))
}

export const editorContext = {
  id: 'trade-editor-context',
  coldSource: 'league_members read and current-season lookup',
  writePolicy: 'saved context does not authorize a trade; Send requires current online validation',
  cacheKey: 'pancake:trade-editor-context:v1:<account>:<league>:<member>',
  warmSource: 'saved member choices and season; unsent trade fields use tab-scoped sessionStorage',
  ttl: '24 hours',
  sizeBound: 'shares the 64-entry persistent-cache limit',
  invalidation: 'online editor load replaces member choices and season; account-scoped key prevents cross-account reuse',
  reconnect: 'online editor refresh validates current membership',
  realtimeEvent: 'none',
}

export const analyzerContext = {
  id: 'trade-analyzer',
  coldSource: 'GET /rest/v1/league_members with profiles; composer roster and pick reads; estimate or revaluation after assets load',
  outgoing: 'POST /trades/estimate with participants and assets; POST /trades/:id/revalue for a saved trade; Make offer opens the composer with a tab-scoped draft',
  writePolicy: 'the authenticated API checks the estimate; opening the composer does not send an offer',
  cacheKey: 'pancake:dynasty-analyzer-snapshot:v7: plus latest:v3 and scope:v1; pancake:analyzer-members:v1: keyed by account, member and league; analysis adds season, scoring and asset signature',
  warmSource: 'saved analysis, participant names and member choices paint offline; Edit assets retains the unchanged result in memory; online member reads refresh the saved list',
  ttl: '24-hour analysis and member-list maximum; live quotes refresh at their server expiry',
  sizeBound: 'four entries per analyzer cache prefix; 64 persistent entries overall',
  invalidation: 'an edited asset route cannot reuse the previous in-memory result; 300 ms after asset or mode changes; league catchup, roster, inventory and resources events; quote expiry or retry',
  reconnect: 'online state enables member reads and active analysis',
  realtimeEvent: 'shared league change messages for catchup, roster, inventory and resources',
}
