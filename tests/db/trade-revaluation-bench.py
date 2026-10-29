import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
from urllib.parse import urlparse


parser = argparse.ArgumentParser()
parser.add_argument("phase", choices=["before", "after"])
parser.add_argument("directory", type=Path)
parser.add_argument("--repeats", type=int, default=30)
args = parser.parse_args()
target = os.environ["SUPABASE_DB_URL"]
address = urlparse(target)
if address.hostname != "127.0.0.1" or address.port != 61922:
    raise SystemExit("Use the private trade benchmark database on port 61922")
args.directory.mkdir(parents=True, exist_ok=True)


def sql(source):
    result = subprocess.run(
        ["psql", target, "-XqAt", "-v", "ON_ERROR_STOP=1"],
        input=source, text=True, capture_output=True, check=True,
    )
    return result.stdout, result.stderr


def decode_many(source):
    decoder = json.JSONDecoder()
    values = []
    while source.strip():
        source = source.lstrip()
        value, end = decoder.raw_decode(source)
        values.append(value)
        source = source[end:]
    return values


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


assert sql("SHOW cron.launch_active_jobs;")[0].strip() == "off", "Disable scheduled jobs before benchmarking"
trades = json.loads(sql("""
SELECT coalesce(jsonb_agg(jsonb_build_object('trade',t.id,'member',m.id,'user',m.user_id,
  'league',t.league_id,'season',t.league_season_id) ORDER BY t.id),'[]')
FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
JOIN public.leagues l ON l.id=t.league_id AND l.deleted_at IS NULL
WHERE t.status IN ('pending','accepted');
""")[0])
if not trades:
    raise SystemExit("The backup contains no open trades")
calls = ["public.get_trade_revaluation_inputs(" + ",".join(literal(t[k]) for k in ["user", "member", "trade"]) + ")" for t in trades]
snapshot = decode_many(sql("BEGIN; SET LOCAL statement_timeout=0;\n" + "\n".join("SELECT " + c + ";" for c in calls) + "\nROLLBACK;")[0])
payloads = {t["trade"]: {k: v for k, v in value.items() if k not in ["inputVersion", "observedAt", "cachedRevaluation"]} for t, value in zip(trades, snapshot)}
payload_file = args.directory / "before-inputs.json"
if args.phase == "before":
    payload_file.write_text(json.dumps(payloads, sort_keys=True))
else:
    assert payloads == json.loads(payload_file.read_text()), "Every open trade must preserve the complete input payload"
    print(f"Input parity: {len(trades)} open trades")

queries = {"full": calls}
if args.phase == "before":
    queries["check"] = ["(WITH inputs AS MATERIALIZED (SELECT " + call + " AS value) SELECT public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','queue-trade','tradeId'," + literal(t["trade"]) + ",'inputFingerprint',value->>'inputVersion','modelVersion','benchmark','inputs',value)) FROM inputs)" for t, call in zip(trades, calls)]
else:
    queries["fingerprint"] = ["private.trade_revaluation_input_version(" + literal(t["trade"]) + ")" for t in trades]
    queries["check"] = ["public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','check-trade','tradeId'," + literal(t["trade"]) + ",'modelVersion','benchmark'))" for t in trades]
queries["discovery"] = ["public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','queue-trades','seasonId'," + literal(season) + ",'version',benchmark_scan_version,'modelVersion','benchmark'))" for season in sorted({t["season"] for t in trades})]
queries["publication"] = ["public.view_refresh_work(" + literal(t["league"]) + ",NULL," + literal(json.dumps({"operation": "publish-trade", "seasonId": t["season"], "tradeId": t["trade"], "revaluation": {"inputVersion": value["inputVersion"], "modelVersion": "benchmark"}})) + "::jsonb)" for t, value in zip(trades, snapshot)]
report = {"phase": args.phase, "trades": len(trades), "repeats": args.repeats, "calls": {}}
for kind, expressions in queries.items():
    statements = ["BEGIN; SET LOCAL statement_timeout=0;"]
    for repetition in range(args.repeats):
        statements.extend("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT " + expression.replace("benchmark_scan_version", str(1000000000 + repetition)) + ";" for expression in expressions)
    statements.append("ROLLBACK;")
    plans = decode_many(sql("\n".join(statements))[0])
    samples = [{"trade": trades[i % len(trades)]["trade"], "ms": plan[0]["Execution Time"],
                "buffers": plan[0]["Plan"].get("Shared Hit Blocks", 0) + plan[0]["Plan"].get("Shared Read Blocks", 0)} for i, plan in enumerate(plans)]
    times = sorted(s["ms"] for s in samples)
    summary = {"count": len(samples), "mean_ms": statistics.mean(times), "p95_ms": times[int((len(times) - 1) * .95)],
               "max_ms": max(times), "mean_buffers": statistics.mean(s["buffers"] for s in samples),
               "scan_ms": sum(times) / args.repeats}
    report["calls"][kind] = summary
    (args.directory / f"{args.phase}-{kind}-plans.json").write_text(json.dumps(plans))
    print(kind + ": " + json.dumps(summary))
    if args.phase == "after":
        assert summary["p95_ms"] < (300 if kind == "full" else 50), f"{kind} p95 exceeds the timing guard"
        assert summary["max_ms"] < 1000, f"{kind} statement exceeds one second"

profile = """
BEGIN;
SET LOCAL statement_timeout=0;
LOAD 'auto_explain';
SET LOCAL auto_explain.log_min_duration=0;
SET LOCAL auto_explain.log_nested_statements=on;
SET LOCAL auto_explain.log_analyze=on;
SET LOCAL auto_explain.log_buffers=on;
SET LOCAL auto_explain.log_format=json;
SET LOCAL client_min_messages=log;
"""
for t, call, value in zip(trades, calls, snapshot):
    profile += "SELECT " + call + ";\n"
    profile += "SELECT private.refresh_queue_trade_revaluation(" + literal(t["trade"]) + "," + literal(value["inputVersion"]) + ",'benchmark');\n"
    publication = json.dumps([{"tradeId": t["trade"], "revaluation": {"inputVersion": value["inputVersion"], "modelVersion": "benchmark"}}])
    profile += "SELECT private.refresh_trade_values(" + literal(t["league"]) + "," + literal(t["season"]) + ",1," + literal(publication) + "::jsonb);\n"
    if args.phase == "after":
        profile += "SELECT public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','begin-trade','tradeId'," + literal(t["trade"]) + ",'modelVersion','benchmark'));\n"
        profile += "SELECT public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','check-trade','tradeId'," + literal(t["trade"]) + ",'modelVersion','benchmark'));\n"
    profile += "SELECT public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','queue-trades','seasonId'," + literal(t["season"]) + ",'version',1,'modelVersion','benchmark'));\n"
    profile += "SELECT public.view_refresh_work(NULL,NULL,jsonb_build_object('operation','trade-ready','tradeId'," + literal(t["trade"]) + ",'inputFingerprint'," + literal(value["inputVersion"]) + ",'modelVersion','benchmark'));\n"
profile += "ROLLBACK;"
_, nested = sql(profile)
(args.directory / f"{args.phase}-nested.log").write_text(nested)
decoder = json.JSONDecoder()
ranked = []
for part in nested.split("plan:\n")[1:]:
    try:
        value, _ = decoder.raw_decode(part)
    except json.JSONDecodeError:
        continue
    plan = value["Plan"]
    ranked.append({"ms": plan["Actual Total Time"], "buffers": plan.get("Shared Hit Blocks", 0) + plan.get("Shared Read Blocks", 0),
                   "query": value["Query Text"], "id": hashlib.sha256(value["Query Text"].encode()).hexdigest()[:12]})
(args.directory / f"{args.phase}-nested-statements.json").write_text(json.dumps(ranked, indent=2))
report["nested_statements"] = len(ranked)
report["unchanged_scan_db_ms"] = sum(report["calls"][kind]["scan_ms"] for kind in ["discovery", "check"])
report["changed_scan_db_ms"] = report["unchanged_scan_db_ms"] + report["calls"]["publication"]["scan_ms"]
if args.phase == "after":
    report["changed_scan_db_ms"] += report["calls"]["full"]["scan_ms"]
(args.directory / f"{args.phase}-report.json").write_text(json.dumps(report, indent=2))
print("Scan totals: " + json.dumps({key: report[key] for key in ["unchanged_scan_db_ms", "changed_scan_db_ms"]}))
print("Nested statements: " + str(len(ranked)))
for row in sorted(ranked, key=lambda row: row["ms"], reverse=True)[:12]:
    print(json.dumps({**row, "query": row["query"][:160]}))
