CREATE OR REPLACE FUNCTION private.timeline_event_catalog()
RETURNS TABLE(kind text, category text, visibility text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('claim.awarded', 'claims', 'public'),
    ('claim.failed', 'claims', 'member'),
    ('trade.sent', 'trades', 'participants'),
    ('trade.countered', 'trades', 'participants'),
    ('trade.edited', 'trades', 'participants'),
    ('trade.accepted', 'trades', 'participants'),
    ('trade.vetoed', 'trades', 'public'),
    ('trade.executed', 'trades', 'public'),
    ('trade.failed', 'trades', 'participants'),
    ('trade.rejected', 'trades', 'participants'),
    ('trade.withdrawn', 'trades', 'participants'),
    ('trade.expired', 'trades', 'participants'),
    ('lineup.auto_set', 'lineups', 'public'),
    ('scores.finalized', 'scores', 'public'),
    ('pick.made', 'picks', 'public'),
    ('draft.pick', 'picks', 'public'),
    ('settings.changed', 'settings', 'public'),
    ('league.settings_changed', 'settings', 'public');
$$;
