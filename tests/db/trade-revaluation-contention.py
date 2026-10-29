import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
import time
from urllib.parse import urlparse


parser = argparse.ArgumentParser()
parser.add_argument("phase", choices=["before", "after"])
args = parser.parse_args()
target = os.environ["SUPABASE_DB_URL"]
address = urlparse(target)
if address.hostname != "127.0.0.1" or address.port != 61922:
    raise SystemExit("Use the private trade database")


def sql(query):
    return subprocess.run(["psql", target, "-XqAt", "-v", "ON_ERROR_STOP=1"], input=query,
                          text=True, capture_output=True, check=True).stdout.strip()


assert sql("SHOW cron.launch_active_jobs;") == "off"
sql("""
BEGIN;
CREATE SCHEMA trade_revaluation_lock_bench;
CREATE TABLE trade_revaluation_lock_bench.boxes(kind text PRIMARY KEY,id uuid,provider text,payload jsonb);
DO $$
DECLARE entry record; game uuid; yr integer; players uuid[]:='{}'; payload jsonb;
BEGIN
  FOR entry IN SELECT * FROM (VALUES ('live',2027),('final',2026)) x(kind,season_year) LOOP
    game:=gen_random_uuid(); yr:=entry.season_year;
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(game,'002-lock-'||entry.kind,yr,1,CASE WHEN entry.kind='live' THEN current_date ELSE current_date-interval '1 year' END,'BOS','NYK','InProgress');
    SELECT jsonb_agg(to_jsonb(row)||jsonb_build_object('id',gen_random_uuid(),'game_id',game,'season_year',yr,
      'game_date',CASE WHEN entry.kind='live' THEN current_date ELSE current_date-interval '1 year' END,'did_not_play',false)) INTO payload
      FROM (SELECT DISTINCT ON (player_id) * FROM public.player_game_stats
        WHERE season_year=yr AND NOT did_not_play AND NOT player_id=ANY(players) ORDER BY player_id,game_id LIMIT 25) row;
    players:=players||ARRAY(SELECT (value->>'player_id')::uuid FROM jsonb_array_elements(payload));
    PERFORM public.save_game_stats_atomic(game,'002-lock-'||entry.kind,payload,false);
    SELECT jsonb_agg(value||jsonb_build_object('points',COALESCE((value->>'points')::integer,0)+1)) INTO payload FROM jsonb_array_elements(payload);
    INSERT INTO trade_revaluation_lock_bench.boxes VALUES(entry.kind,game,'002-lock-'||entry.kind,payload);
  END LOOP;
END;
$$;
COMMIT;
""")
live = "SELECT public.save_live_game_stats_atomic(id,provider,payload,60) FROM trade_revaluation_lock_bench.boxes WHERE kind='live';"
final = "SELECT public.save_final_game_snapshot_atomic(id,provider,payload,clock_timestamp(),100,99,'Final') FROM trade_revaluation_lock_bench.boxes WHERE kind='final';"
samples = []
try:
    with ThreadPoolExecutor(max_workers=1) as workers:
        for iteration in range(30):
            commit_order = args.phase == 'after' and iteration == 29
            version_query = "SELECT private.trade_revaluation_input_version(id) FROM public.trades WHERE status IN ('pending','accepted') ORDER BY id LIMIT 1;"
            initial_version = sql(version_query) if commit_order else None
            first = subprocess.Popen(["psql", target, "-XqAt", "-v", "ON_ERROR_STOP=1"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, bufsize=1)
            first.stdin.write("BEGIN; SELECT pg_backend_pid();\n" + live + "\nSELECT 'ready';\n")
            first.stdin.flush()
            owner = first.stdout.readline().strip()
            changed = first.stdout.readline().strip()
            if changed != "25" or first.stdout.readline().strip() != "ready":
                raise AssertionError("The live writer did not reach its held transaction")

            def run_second():
                named = target + "?application_name=trade-revaluation-lock-second"
                result = subprocess.run(["psql", named, "-XqAt", "-v", "ON_ERROR_STOP=1"],
                                        input="BEGIN; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + final + (" COMMIT;" if commit_order else " ROLLBACK;"),
                                        text=True, capture_output=True, check=True)
                return json.loads(result.stdout)[0]["Execution Time"]

            future = workers.submit(run_second)
            observations = []
            deadline = time.monotonic() + .16
            while time.monotonic() < deadline:
                waiting = sql("SELECT COALESCE(bool_or(" + owner + "=ANY(pg_blocking_pids(pid))),false) FROM pg_stat_activity WHERE application_name='trade-revaluation-lock-second';")
                if waiting == "t":
                    observations.append(time.monotonic())
                time.sleep(.005)
            if commit_order:
                future.result(timeout=10)
                middle_version = sql(version_query)
                assert middle_version != initial_version, "The later writer's commit must change the fingerprint"
            first.stdin.write(("COMMIT;" if commit_order else "ROLLBACK;") + "\n\\q\n")
            first.stdin.flush()
            first.communicate(timeout=10)
            elapsed = future.result(timeout=10)
            if commit_order:
                assert sql(version_query) != middle_version, "A commit in reverse order must still change the fingerprint"
            blocked = (observations[-1] - observations[0]) * 1000 if len(observations) > 1 else 0
            samples.append({"iteration": iteration, "observed_lock_ms": blocked, "statement_ms": elapsed})
    print(json.dumps(samples))
    maximum = max(row["observed_lock_ms"] for row in samples)
    print(json.dumps({"pairs": len(samples), "maximum_observed_lock_ms": maximum,
                      "maximum_statement_ms": max(row["statement_ms"] for row in samples)}))
    if args.phase == "before":
        assert maximum > 10, "The shared revision lock did not reproduce"
    else:
        assert maximum <= 10, "Revision writers still serialize"
finally:
    sql("BEGIN; DELETE FROM public.player_game_stats WHERE game_id IN(SELECT id FROM trade_revaluation_lock_bench.boxes); DELETE FROM public.nba_games WHERE id IN(SELECT id FROM trade_revaluation_lock_bench.boxes); DROP SCHEMA trade_revaluation_lock_bench CASCADE; COMMIT;")
