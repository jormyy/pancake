import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse


target = os.environ["SUPABASE_DB_URL"]
address = urlparse(target)
if address.hostname != "127.0.0.1" or address.port != 61922:
    raise SystemExit("Use the private trade benchmark database on port 61922")
names = ["private/trade_value_player_inputs", "private/build_trade_estimate_inputs",
         "public/get_dynasty_pick_values", "public/get_trade_revaluation_inputs",
         "private/refresh_trade_values", "public/view_refresh_work"]
paths = ["supabase/sql/functions/by-name/" + name + ".sql" for name in names]
before = "\n".join(subprocess.check_output(["git", "show", "64ada45a:" + path], text=True) for path in paths)
after = "\n".join(Path(path).read_text() for path in paths)
query = """
SELECT t.id,convert_to((public.get_trade_revaluation_inputs(m.user_id,m.id,t.id)
  - ARRAY['inputVersion','observedAt','cachedRevaluation'])::text,'UTF8') AS payload
FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
WHERE t.status IN ('pending','accepted')
"""
source = "BEGIN; SET LOCAL statement_timeout='120s';\nCREATE TEMP TABLE parity_before(id uuid PRIMARY KEY,payload bytea);\n"
for label, update in [("backup", ""), ("fractional", "UPDATE public.leagues SET scoring_settings=jsonb_set(scoring_settings,'{points}','1.001') WHERE id IN(SELECT league_id FROM public.trades WHERE status IN('pending','accepted'));\n")]:
    source += update + before + "\nTRUNCATE parity_before; INSERT INTO parity_before " + query + ";\n" + after
    source += """
DO $parity$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM parity_before) THEN RAISE EXCEPTION 'The backup must contain open trades'; END IF;
  IF EXISTS(SELECT 1 FROM parity_before old FULL JOIN (""" + query + """) current USING(id)
    WHERE old.payload IS DISTINCT FROM current.payload) THEN
    RAISE EXCEPTION 'Trade input bytes differ';
  END IF;
END;
$parity$;
SELECT '""" + label + " byte parity: '||count(*)||' open trades' FROM parity_before;\n"
source += "ROLLBACK;"
result = subprocess.run(["psql", target, "-XqAt", "-v", "ON_ERROR_STOP=1"], input=source,
                        text=True, capture_output=True, check=True)
print(result.stdout.strip())
