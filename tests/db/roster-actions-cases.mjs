export function scenarios(manager) {
  const f = `(SELECT league_id FROM ra_fixture)`
  const s = `(SELECT season_id FROM ra_fixture)`
  const m = `(SELECT member_ids[${manager}] FROM ra_fixture)`
  const u = `(SELECT user_ids[${manager}] FROM ra_fixture)`
  const p = index => `(SELECT player_id FROM ra_players WHERE manager=${manager} AND ordinal=${index})`
  const r = index => `md5('ra-roster-${manager}-${index}')::uuid`
  const c = index => `md5('ra-claim-${manager}-${index}')::uuid`
  const league = settings => `UPDATE public.leagues SET ${settings} WHERE id=${f};`
  const claim = (index, order = index - 7, bid = 0, member = m) => `INSERT INTO public.waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,claim_order,bid_amount)
    VALUES(${c(index)},${f},${s},${member},${p(index)},${manager},current_date+2,${order},${bid});`
  const bid = "waiver_mode='faab'"
  const cases = []
  const add = (name, expression, setup = '', outcome = 'success', role = 'authenticated', response = 'void') => cases.push({ name, manager, expression, setup, outcome, role: expression.startsWith('public.toggle_') ? 'service_role' : role, response, user: u })
  for (const [name, dest] of [['active', 'false,false'], ['ir', 'true,false'], ['taxi', 'false,true']]) {
    add(`add-${name}`, `public.add_free_agent_atomic(${m},${f},${p(7)},${dest})`, '', 'scheduled waiver claim')
  }
  add('drop', `public.drop_player_atomic(${r(1)})`)
  add('drop-and-add', `public.drop_and_add_free_agent_atomic(${r(1)},${m},${f},${p(7)})`, '', 'scheduled waiver claim')
  for (const mode of ['rolling', 'faab']) {
    const setup = league(`waiver_mode='${mode}'`)
    add(`claim-submit-${mode}`, `public.create_waiver_claim_atomic(${f},${m},${p(7)},NULL,${u},10)`, setup, 'success', 'service_role', 'json')
    add(`claim-edit-${mode}`, `public.edit_waiver_claim_atomic(${c(8)},${m},${u},NULL,10)`, setup + claim(8), 'success', 'service_role')
    add(`claim-cancel-${mode}`, `public.cancel_waiver_claim_atomic(${c(8)},${m},${u})`, setup + claim(8), 'success', 'service_role')
    add(`claim-reorder-${mode}`, `public.reorder_waiver_claim_atomic(${c(9)},${m},${u},'up')`, setup + claim(8, 1, 10) + claim(9, 2, 10), 'success', 'service_role', 'json')
  }
  add('claim-reorder-duplicates', `public.reorder_waiver_claim_atomic(${c(9)},${m},${u},'up')`, claim(8, 1) + claim(9, 1), 'success', 'service_role', 'json')
  add('claim-reorder-boundary', `public.reorder_waiver_claim_atomic(${c(8)},${m},${u},'up')`, claim(8), 'success', 'service_role', 'json')
  add('faab-zero-bid', `public.create_waiver_claim_atomic(${f},${m},${p(7)},NULL,${u},0)`, league(bid), 'success', 'service_role', 'json')
  add('faab-over-budget', `public.create_waiver_claim_atomic(${f},${m},${p(7)},NULL,${u},101)`, league(bid), 'exceeds your available balance', 'service_role', 'json')
  add('to-ir', `public.toggle_ir_atomic(${r(1)},true,${u})`)
  add('to-ir-offday', `public.toggle_ir_atomic(${r(1)},true,${u})`, `DELETE FROM public.nba_games WHERE id=md5('ra-other-game')::uuid;`)
  add('from-ir', `public.toggle_ir_atomic(${r(5)},false,${u})`)
  add('from-ir-full', `public.toggle_ir_atomic(${r(5)},false,${u})`, league('roster_size=4'), 'Your active roster is full')
  add('to-taxi-rejected', `public.toggle_taxi_atomic(${r(1)},true,${u})`, '', 'Players enter taxi')
  add('from-taxi', `public.toggle_taxi_atomic(${r(6)},false,${u})`)
  for (const source of ['ir', 'taxi']) {
    const target = r(source === 'ir' ? 5 : 6)
    for (const free of ['drop', 'ir']) {
      add(`activate-${source}-overflow-${free}`, `public.activate_roster_player_with_overflow_atomic(${target},'${source}',${r(1)},'${free}')`, league('roster_size=4'))
      add(`activate-${source}-lineup-${free}`, `public.activate_roster_player_with_lineup_atomic(${target},'${source}',${r(1)},'${free}',${m},${f},${s},current_date,1,'PG')`, league('roster_size=4'))
    }
    add(`activate-${source}-lineup-bench`, `public.activate_roster_player_with_lineup_atomic(${target},'${source}',NULL,NULL,${m},${f},${s},current_date,1,'BE')`)
  }
  add('commissioner-faab', `public.commissioner_adjust_faab_balance_atomic(${f},${m},85)`, '', 'success', 'authenticated', 'json')
  cases.at(-1).user = '(SELECT user_ids[1] FROM ra_fixture)'
  add('commissioner-weekly-add', `public.commissioner_override_weekly_add_count_atomic(${f},${m},2)`, '', 'success', 'authenticated', 'json')
  cases.at(-1).user = '(SELECT user_ids[1] FROM ra_fixture)'
  add('invite-join', `public.join_league_by_invite_code('ABCDEF0123456789','Joined team')`, `INSERT INTO public.leagues(id,name,slug,commissioner_id,status,invite_code,team_limit) SELECT md5('ra-join')::uuid,'RA join','ra-join',user_ids[1],'setup','ABCDEF0123456789',12 FROM ra_fixture;
    INSERT INTO public.league_seasons(league_id,season_year,is_current) VALUES(md5('ra-join')::uuid,9881,true);`, 'success', 'authenticated', 'json')
  add('add-full', `public.add_free_agent_atomic(${m},${f},${p(7)})`, league('roster_size=4'), 'scheduled waiver claim')
  add('claim-week-limit', `public.create_waiver_claim_atomic(${f},${m},${p(7)},NULL,${u})`, `UPDATE public.weekly_add_counts SET add_count=20 WHERE member_id=${m};`, 'weekly add limit', 'service_role', 'json')
  add('add-wrong-user', `public.add_free_agent_atomic(${m},${f},${p(7)})`, '', 'permission')
  cases.at(-1).user = `(SELECT user_ids[${manager % 3 + 1}] FROM ra_fixture)`
  add('claim-cutoff', `public.edit_waiver_claim_atomic(${c(8)},${m},${u})`, claim(8) + `UPDATE public.waiver_claims SET process_date=current_date-1 WHERE id=${c(8)};`, 'cutoff has passed', 'service_role')
  const locked = `INSERT INTO public.nba_games(id,season_year,week_number,game_date,home_team,away_team,status,game_time) VALUES(md5('ra-game')::uuid,9881,1,(now() AT TIME ZONE 'America/New_York')::date,'ZRA','ZRB','InProgress',now()-interval '1 hour');`
  add('locked-ir', `public.toggle_ir_atomic(${r(1)},true,${u})`, locked, 'game has already started')
  add('locked-taxi-return', `public.toggle_taxi_atomic(${r(6)},false,${u})`, locked, 'game has already started')
  add('locked-activation', `public.activate_roster_player_with_overflow_atomic(${r(5)},'ir',${r(1)},'drop')`, locked, 'game has already started')
  const trade = `SELECT public.propose_trade_atomic(${f},${s},${m},(SELECT member_ids[${manager % 3 + 1}] FROM ra_fixture),ARRAY[${p(1)}],ARRAY[(SELECT player_id FROM ra_players WHERE manager=${manager % 3 + 1} AND ordinal=1)],'{}','{}');`
  add('trade-pending-drop', `public.drop_player_atomic(${r(1)})`, trade, 'Locked by trade')
  add('trade-pending-ir', `public.toggle_ir_atomic(${r(1)},true,${u})`, trade, 'Locked by trade')
  add('trade-pending-taxi', `public.toggle_taxi_atomic(${r(1)},true,${u})`, trade, 'Locked by trade')
  for (const mode of ['rolling', 'faab']) {
    for (const variant of ['empty', 'tie', 'drop', 'full', 'budget', 'taxi', 'ir', 'batch']) {
      let setup = league(`waiver_mode='${mode}'`)
      if (variant !== 'empty' && variant !== 'batch') setup += claim(8, 1, mode === 'faab' ? 10 : 0)
      if (variant === 'batch') setup += `INSERT INTO public.waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,claim_order,bid_amount) SELECT md5('ra-batch-'||players.ordinal||'-'||contender)::uuid,${f},${s},(SELECT member_ids[contender] FROM ra_fixture),players.player_id,contender,current_date+2,players.ordinal-6,${mode === 'faab' ? 10 : 0} FROM ra_players players CROSS JOIN generate_series(1,3) contender WHERE players.manager=${manager} AND players.ordinal BETWEEN 7 AND 12;`
      if (variant === 'tie') setup += `INSERT INTO public.waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,claim_order,bid_amount)
        VALUES(md5('ra-contender')::uuid,${f},${s},(SELECT member_ids[${manager % 3 + 1}] FROM ra_fixture),${p(8)},${manager % 3 + 1},current_date+2,1,${mode === 'faab' ? 10 : 0});`
      if (variant === 'drop') setup += `UPDATE public.waiver_claims SET drop_player_id=${p(1)} WHERE id=${c(8)};`
      if (variant === 'full') setup += league('roster_size=4')
      if (variant === 'budget') setup += `UPDATE public.faab_balances SET balance=0 WHERE member_id=${m};`
      if (variant === 'taxi' || variant === 'ir') setup += `UPDATE public.waiver_claims SET to_${variant}=true WHERE id=${c(8)};`
      setup += `UPDATE public.waiver_claims SET process_date=current_date-1 WHERE league_id=${f};`
      add(`worker-${mode}-${variant}`, `pg_temp.worker()`, setup, 'success', 'service_role', 'json')
    }
  }
  return cases
}
