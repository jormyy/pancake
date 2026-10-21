import json
from pathlib import Path
root=Path(__file__).resolve().parents[3]
p=root/'scripts/mutation/post/catalog.json'
rows=[row for row in json.loads(p.read_text()) if not row['id'].startswith('post-t4-')]
sql='supabase/migrations/20261020000063_balanced_season_matchups.sql'
for row in rows:
    if row['id']=='post-sw-01':
        row['original']='      IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;'
        row['mutated']=row['original'].replace('AND v_week','AND NOT v_week')
    elif row['id']=='post-sw-02':
        row['original']='      v_played := v_played + 1;'
        row['mutated']=''
    else:
        continue
    row['file']=sql
    row['line']=(root/sql).read_text().split(row['original'],1)[0].count('\n')+1

def add(area,file,symbol,operator,original,mutated,test):
    source=(root/file).read_text()
    assert source.count(original)==1,(original,source.count(original))
    rows.append(dict(id=f'post-t4-{len([r for r in rows if r["id"].startswith("post-t4-")])+1:02}',area=area,file=file,line=source[:source.index(original)].count('\n')+1,symbol=symbol,operator=operator,original=original,mutated=mutated,oracles=[dict(name=area,command=f'node scripts/mutation/post/check.mjs {test}',timeout=120000)]))
for op,original,mutated in [
 ('ARG-SWAP',"md5(p_season_id::text || ':' || id::text)","md5(p_league_id::text || ':' || id::text)"),
 ('CONST','v_order[1 + v_played % (v_count - 1)]','v_order[1]'),
 ('CONST','v_seen[v_code] % 2 = 0','v_seen[v_code] % 2 = 1'),
 ('CONST','v_counts[v_code] % 2 = 1','v_counts[v_code] % 2 = 0'),
]:add('matchup-order',sql,'private.regular_season_matchup_payload(uuid,uuid,integer)',op,original,mutated,'tests/db/matchup-order-fairness.sql')
for op,original,mutated in [
 ('ROR',"endWeek <= lastAvailableWeek && complete ? 'fit'","endWeek < lastAvailableWeek && complete ? 'fit'"),
 ('CONST','weeks.length ? Math.max(...weeks) : null','weeks.length ? Math.max(...weeks) + 1 : null'),
 ('CONST','rounds.reduce((sum, length) => sum + length, 0)','rounds.reduce((sum, length) => sum + 1, 0)'),
]:add('playoff-fit','supabase/functions/_shared/schedule.ts','playoffFit',op,original,mutated,'supabase/tests/db/matchup-order-seasons.ts')
add('rookie-draft','supabase/functions/_shared/seasonBoundary.ts','runRookieDraftBackstop','CONST','p_pick_timer_seconds: 60','p_pick_timer_seconds: 30','supabase/tests/db/rookie-backstop.ts')
rows[-1]['oracles'][0]['command']='POST_ROOKIE_CASE=missing '+rows[-1]['oracles'][0]['command']
add('matchup-order',sql,'private.regular_season_matchup_payload(uuid,uuid,integer)','STMT-DEL',' AND NOT is_voided','', 'tests/db/matchup-order-fairness.sql')
p.write_text(json.dumps(rows,indent=2)+'\n')
