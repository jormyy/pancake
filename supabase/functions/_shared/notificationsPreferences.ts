export const notificationEvents = [
  {
    'key': 'trade_offered',
    'category': 'trade',
    'label': 'New offer',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_countered',
    'category': 'trade',
    'label': 'Counteroffer',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_accepted',
    'category': 'trade',
    'label': 'Accepted',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_rejected',
    'category': 'trade',
    'label': 'Rejected',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_vetoed',
    'category': 'trade',
    'label': 'Vetoed',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_expired',
    'category': 'trade',
    'label': 'Expired',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_edited',
    'category': 'trade',
    'label': 'Offer edited',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_withdrawn',
    'category': 'trade',
    'label': 'Withdrawn',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_completed',
    'category': 'trade',
    'label': 'Completed',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_participant_accepted',
    'category': 'trade',
    'label': 'Participant accepted',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_completion_failed',
    'category': 'trade',
    'label': 'Completion failed',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'trade_claim_cancelled',
    'category': 'trade',
    'label': 'Claim cancelled',
    'defaultEnabled': true,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'league_trade',
    'category': 'trade',
    'label': 'Other league trades',
    'defaultEnabled': false,
    'legacy': 'trade_enabled'
  },
  {
    'key': 'draft_on_clock',
    'category': 'draft',
    'label': 'Your turn',
    'defaultEnabled': true,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_coming_soon',
    'category': 'draft',
    'label': 'Your pick is next',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_timer_expiring',
    'category': 'draft',
    'label': 'Timer expiring',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_auto_picked',
    'category': 'draft',
    'label': 'Auto-picked for you',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_started',
    'category': 'draft',
    'label': 'Started',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_paused',
    'category': 'draft',
    'label': 'Paused',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_resumed',
    'category': 'draft',
    'label': 'Resumed',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'draft_finished',
    'category': 'draft',
    'label': 'Finished',
    'defaultEnabled': false,
    'legacy': 'draft_enabled'
  },
  {
    'key': 'waiver_claim_won',
    'category': 'waiver',
    'label': 'Claim won',
    'defaultEnabled': true,
    'legacy': 'waiver_enabled'
  },
  {
    'key': 'waiver_claim_lost',
    'category': 'waiver',
    'label': 'Claim lost',
    'defaultEnabled': true,
    'legacy': 'waiver_enabled'
  },
  {
    'key': 'faab_outbid',
    'category': 'waiver',
    'label': 'FAAB outbid',
    'defaultEnabled': false,
    'legacy': 'waiver_enabled'
  },
  {
    'key': 'waivers_processed',
    'category': 'waiver',
    'label': 'Waivers processed',
    'defaultEnabled': false,
    'legacy': 'waiver_enabled'
  },
  {
    'key': 'watched_player_dropped',
    'category': 'waiver',
    'label': 'Watched player dropped',
    'defaultEnabled': false,
    'legacy': 'waiver_enabled'
  },
  {
    'key': 'waiver_limit_reached',
    'category': 'waiver',
    'label': 'Weekly limit reached',
    'defaultEnabled': false,
    'legacy': 'waiver_enabled'
  },
  {
    'key': 'owned_player_injured',
    'category': 'player',
    'label': 'Player injured',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'owned_player_status',
    'category': 'player',
    'label': 'Player status changed',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'owned_player_ruled_out',
    'category': 'player',
    'label': 'Player ruled out',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'lineup_inactive',
    'category': 'lineup',
    'label': 'Inactive starter',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'lineup_empty',
    'category': 'lineup',
    'label': 'Empty starter',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'matchup_final',
    'category': 'matchup',
    'label': 'Final result',
    'defaultEnabled': true,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'matchup_started',
    'category': 'matchup',
    'label': 'Started',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'matchup_close',
    'category': 'matchup',
    'label': 'Close late in week',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'playoff_clinched',
    'category': 'playoff',
    'label': 'Clinched',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'playoff_eliminated',
    'category': 'playoff',
    'label': 'Eliminated',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'playoff_seeding',
    'category': 'playoff',
    'label': 'Seeding',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'champion',
    'category': 'playoff',
    'label': 'Champion',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'trade_deadline_approaching',
    'category': 'league',
    'label': 'Trade deadline soon',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'season_started',
    'category': 'league',
    'label': 'Season started',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'season_rollover',
    'category': 'league',
    'label': 'New season',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'commissioner_announcement',
    'category': 'league',
    'label': 'Commissioner message',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  },
  {
    'key': 'league_settings_changed',
    'category': 'league',
    'label': 'Settings changed',
    'defaultEnabled': false,
    'legacy': 'activity_enabled'
  }
] as const

export const notificationCategories = {
  'trade': 'Trades',
  'draft': 'Drafts',
  'waiver': 'Waivers',
  'player': 'Players',
  'lineup': 'Lineup',
  'matchup': 'Matchups',
  'playoff': 'Playoffs',
  'league': 'League'
} as const

export type NotificationCategory = keyof typeof notificationCategories
export type NotificationEvent = typeof notificationEvents[number]['key']
export type NotificationPreferenceRow = {
  trade_enabled: boolean
  waiver_enabled: boolean
  draft_enabled: boolean
  activity_enabled: boolean
  master_enabled?: boolean
  category_settings?: Partial<Record<NotificationCategory, boolean>>
  event_settings?: Partial<Record<NotificationEvent, boolean>>
}

type StoredNotificationPreferenceRow = Omit<NotificationPreferenceRow, 'category_settings' | 'event_settings'> & {
  category_settings?: unknown
  event_settings?: unknown
}

function booleanSettings<Key extends string>(value: unknown, keys: readonly Key[]): Partial<Record<Key, boolean>> {
  const settings: Partial<Record<Key, boolean>> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return settings
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue
    const enabled: unknown = Reflect.get(value, key)
    if (typeof enabled === 'boolean') settings[key] = enabled
  }
  return settings
}

export function normalizeNotificationPreferences(row: StoredNotificationPreferenceRow): NotificationPreferenceRow {
  return {
    trade_enabled: row.trade_enabled,
    waiver_enabled: row.waiver_enabled,
    draft_enabled: row.draft_enabled,
    activity_enabled: row.activity_enabled,
    master_enabled: row.master_enabled,
    category_settings: booleanSettings(row.category_settings, notificationEvents.map(event => event.category)),
    event_settings: booleanSettings(row.event_settings, notificationEvents.map(event => event.key)),
  }
}

export function notificationEnabled(
  preferences: NotificationPreferenceRow | null | undefined,
  category: NotificationCategory | 'activity',
  event?: string,
): boolean {
  if (preferences?.master_enabled === false) return false
  const definition = notificationEvents.find(item => item.key === event)
  const resolvedCategory = definition?.category ?? category
  const legacy = definition?.legacy ?? (category === 'trade' ? 'trade_enabled'
    : category === 'waiver' ? 'waiver_enabled' : category === 'draft' ? 'draft_enabled' : 'activity_enabled')
  if (preferences?.[legacy] === false) return false
  if (resolvedCategory !== 'activity' && preferences?.category_settings?.[resolvedCategory] === false) return false
  if (!definition) return event === undefined
  return preferences?.event_settings?.[definition.key] ?? definition.defaultEnabled
}
