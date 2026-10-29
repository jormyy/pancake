import argparse
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time
import urllib.request
from urllib.parse import urlparse


parser = argparse.ArgumentParser()
parser.add_argument("--negative-control", action="store_true")
parser.add_argument("--values-output", type=Path)
args = parser.parse_args()
target = os.environ["SUPABASE_DB_URL"]
assert urlparse(target).hostname == "127.0.0.1" and urlparse(target).port == 61922
process = subprocess.Popen(["psql", target, "-XqAt", "-v", "ON_ERROR_STOP=1"],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, bufsize=1)


def query(statement):
    process.stdin.write("\\timing on\n" + statement + ";\n\\timing off\nSELECT '__done__';\n")
    process.stdin.flush()
    value = None
    elapsed = None
    while True:
        line = process.stdout.readline().strip()
        if line == "__done__":
            return value, elapsed
        if not line and process.poll() is not None:
            raise RuntimeError(process.stderr.read())
        matched = re.match(r"Time: ([\d.]+) ms", line)
        if matched:
            elapsed = float(matched[1])
        elif line.startswith(("{", "[", '"')) or line in ["true", "false", "null"]:
            value = json.loads(line)


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def guard_timing(stage):
    assert stage["p95_ms"] < 300 and stage["max_ms"] < 1000, stage


samples = []
expected = {}
values_to_save = {}
try:
    with urllib.request.urlopen("http://127.0.0.1:61930", timeout=5) as response:
        model = json.load(response)["modelVersion"]
    query("BEGIN")
    state, _ = query("SELECT to_jsonb(current_setting('cron.launch_active_jobs'))")
    assert state == "off"
    trades, _ = query("SELECT jsonb_agg(jsonb_build_object('id',t.id,'user',m.user_id,'member',m.id,'league',t.league_id,'season',t.league_season_id) ORDER BY t.id) FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.status IN ('pending','accepted')")
    assert trades
    for _ in range(1 if args.negative_control else 30):
        for trade in trades:
            query("DELETE FROM private.trade_value_publications WHERE trade_id=" + literal(trade["id"]))
            query("DELETE FROM public.trade_value_cache WHERE trade_id=" + literal(trade["id"]))
            query("DELETE FROM private.trade_revaluation_schedule WHERE trade_id=" + literal(trade["id"]))
            started = time.monotonic()
            allowed, begin_ms = query("SELECT public.view_refresh_work(NULL,NULL," + literal(json.dumps({"operation": "begin-trade", "tradeId": trade["id"], "modelVersion": model})) + "::jsonb)")
            assert allowed is True
            inputs, read_ms = query("SELECT public.get_trade_revaluation_inputs(" + ",".join(literal(trade[key]) for key in ["user", "member", "id"]) + ")")
            payload = json.dumps({"inputs": inputs, "delay": 1100 if args.negative_control else 0}).encode()
            request = urllib.request.Request("http://127.0.0.1:61930", data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                result = json.load(response)
            if args.negative_control:
                try:
                    guard_timing({"p95_ms": result["analysisMs"], "max_ms": result["analysisMs"]})
                except AssertionError:
                    print("Rejected delayed analysis with the runtime timing guard")
                else:
                    raise AssertionError("The delayed control did not fail the guard")
                raise SystemExit(0)
            value = result["value"]
            values_to_save[trade["id"]] = value
            assert result["analysisMs"] < 1000
            if trade["id"] in expected:
                assert value["analysis"] == expected[trade["id"]], "Identical inputs changed the analysis"
            expected[trade["id"]] = value["analysis"]
            parameters = {"operation": "publish-trade", "tradeId": trade["id"], "seasonId": trade["season"], "revaluation": value}
            saved, save_ms = query("SELECT public.view_refresh_work(" + literal(trade["league"]) + ",NULL," + literal(json.dumps(parameters)) + "::jsonb)")
            assert saved is True
            total_ms = (time.monotonic() - started) * 1000
            stored, _ = query("SELECT revaluation FROM public.trade_value_cache WHERE trade_id=" + literal(trade["id"]))
            assert stored == value, "The saved valuation differs from the computed valuation"
            samples.append({"begin": begin_ms, "inputs": read_ms, "analysis": result["analysisMs"], "save": save_ms, "end_to_end": total_ms})
    report = {}
    for kind in samples[0]:
        values = sorted(row[kind] for row in samples)
        report[kind] = {"count": len(values), "mean_ms": statistics.mean(values), "p95_ms": values[int((len(values) - 1) * .95)], "max_ms": max(values)}
        guard_timing(report[kind])
    print(json.dumps(report))
    if args.values_output:
        args.values_output.write_text(json.dumps(values_to_save))
finally:
    query("ROLLBACK")
    process.stdin.write("\\q\n")
    process.stdin.flush()
    process.communicate(timeout=10)
