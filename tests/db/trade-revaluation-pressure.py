import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse


parser = argparse.ArgumentParser()
parser.add_argument("phase", choices=["before", "after"])
parser.add_argument("directory", type=Path)
args = parser.parse_args()
target = os.environ["SUPABASE_DB_URL"]
address = urlparse(target)
if address.hostname != "127.0.0.1" or address.port != int(os.environ.get("PANCAKE_TEST_DB_PORT", "61922")):
    raise SystemExit("Use the configured private trade benchmark database")


def sql(query, strict=True):
    return subprocess.run(["psql", target, "-XqAt", "-v", "ON_ERROR_STOP=1"], input=query,
                          text=True, capture_output=True, check=strict)


assert sql("SHOW cron.launch_active_jobs;").stdout.strip() == "off", "Disable scheduled jobs before benchmarking"
leagues = json.loads(sql("SELECT jsonb_agg(jsonb_build_array(id,scoring_settings)) FROM public.leagues WHERE id IN (SELECT league_id FROM public.trades WHERE status IN ('pending','accepted'));").stdout)
trades = json.loads(sql("SELECT jsonb_agg(jsonb_build_array(m.user_id,m.id,t.id) ORDER BY t.id) FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.status IN ('pending','accepted');").stdout)


def read_trade(trade):
    call = "public.get_trade_revaluation_inputs(" + ",".join("'" + value + "'" for value in trade) + ")"
    result = sql("SET statement_timeout='3s'; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT " + call + ";", False)
    if result.returncode:
        assert "canceling statement due to statement timeout" in result.stderr, result.stderr
        return {"timeout": True}
    plan = json.loads(result.stdout)[0]
    return {"timeout": False, "ms": plan["Execution Time"],
            "buffers": plan["Plan"].get("Shared Hit Blocks", 0) + plan["Plan"].get("Shared Read Blocks", 0)}


try:
    sql("UPDATE public.leagues SET scoring_settings=jsonb_set(scoring_settings,'{points}','1.001') WHERE id IN (" + ",".join("'" + row[0] + "'" for row in leagues) + ");")
    payloads = {}
    for trade in trades:
        call = "public.get_trade_revaluation_inputs(" + ",".join("'" + value + "'" for value in trade) + ")"
        result = sql("SET statement_timeout=0; SELECT " + call + ";")
        value = json.loads(result.stdout)
        payloads[trade[2]] = {key: item for key, item in value.items() if key not in ["inputVersion", "observedAt", "cachedRevaluation"]}
    parity = args.directory / "before-fractional-inputs.json"
    if args.phase == "before":
        parity.write_text(json.dumps(payloads, sort_keys=True))
    else:
        assert payloads == json.loads(parity.read_text()), "Fractional scoring must preserve every open trade payload"
    call = "public.get_trade_revaluation_inputs(" + ",".join("'" + value + "'" for value in trades[0]) + ")"
    trace = sql("LOAD 'auto_explain'; SET auto_explain.log_min_duration=0; SET auto_explain.log_nested_statements=on; SET auto_explain.log_analyze=on; SET auto_explain.log_buffers=on; SET auto_explain.log_format=json; SET client_min_messages=log; SET statement_timeout=0; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT " + call + ";")
    (args.directory / (args.phase + "-fractional-plan.json")).write_text(trace.stdout)
    (args.directory / (args.phase + "-fractional-nested.log")).write_text(trace.stderr)
    if args.phase == "after":
        visited = set()
        pruned = set()

        def inspect(plan):
            relation = plan.get("Relation Name", "")
            if relation.startswith("player_game_stats"):
                (visited if plan["Actual Loops"] else pruned).add(relation)
            for child in plan.get("Plans", []):
                inspect(child)

        for part in trace.stderr.split("plan:\n")[1:]:
            plan, _ = json.JSONDecoder().raw_decode(part)
            if "WITH rounded AS" in plan["Query Text"]:
                inspect(plan["Plan"])
        assert visited == {"player_game_stats"}, visited
        assert not pruned, pruned
        print(json.dumps({"visited_partitions": len(visited), "pruned_partitions": len(pruned)}))
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(read_trade, trades[:2]))
    args.directory.mkdir(parents=True, exist_ok=True)
    (args.directory / (args.phase + "-pressure.json")).write_text(json.dumps(results, indent=2))
    print(json.dumps(results))
    if args.phase == "before":
        assert any(row["timeout"] for row in results), "The two-worker fractional-scoring timeout did not reproduce"
    else:
        assert all(not row["timeout"] and row["ms"] < 1000 for row in results), "The bounded read exceeds one second"
finally:
    sql("\n".join("UPDATE public.leagues SET scoring_settings='" + json.dumps(settings).replace("'", "''") + "'::jsonb WHERE id='" + league + "';" for league, settings in leagues))
