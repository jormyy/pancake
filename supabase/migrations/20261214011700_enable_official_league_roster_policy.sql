INSERT INTO private.league_roster_policies (league_id, weekly_roster_floor, auto_ir_all_members)
SELECT 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd', 16, true
 WHERE EXISTS (SELECT 1 FROM public.leagues WHERE id = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd')
ON CONFLICT (league_id) DO UPDATE
   SET weekly_roster_floor = EXCLUDED.weekly_roster_floor,
       auto_ir_all_members = EXCLUDED.auto_ir_all_members
 WHERE (private.league_roster_policies.weekly_roster_floor,
        private.league_roster_policies.auto_ir_all_members)
       IS DISTINCT FROM (EXCLUDED.weekly_roster_floor, EXCLUDED.auto_ir_all_members);
