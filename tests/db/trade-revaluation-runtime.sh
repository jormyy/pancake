#!/usr/bin/env bash
set -euo pipefail

case "$PWD" in
  "$HOME/pancake-t_4ba51e0d/lanes/fable-tradein/repo") ;;
  *) echo 'Run this recipe in the private mini checkout.' >&2; exit 1 ;;
esac

trade_runtime_tmp=$(mktemp -d "$HOME/pancake-t_4ba51e0d/lanes/fable-tradein/runtime.XXXXXX")
trade_runtime_build=''
trade_runtime_server=''
trade_runtime_image=public.ecr.aws/supabase/edge-runtime:v1.74.2

cleanup() {
  docker update --cpus=1 supabase_db_pt4bafableti >/dev/null
  if [ -n "$trade_runtime_server" ]; then docker rm -f "$trade_runtime_server" >/dev/null; fi
  if [ -n "$trade_runtime_build" ]; then docker rm -f "$trade_runtime_build" >/dev/null; fi
  rm -rf "$trade_runtime_tmp"
}
trap cleanup EXIT

trade_runtime_build=$(docker create --pull never --label com.supabase.cli.project=pt4bafableti --cpus=1 --memory=2g \
  -v "$PWD:/src:ro" "$trade_runtime_image" bundle --entrypoint /src/tests/db/trade-revaluation-analysis/index.mts \
  --output /tmp/trade-analysis.eszip --disable-module-cache)
docker start -a "$trade_runtime_build"
docker cp "$trade_runtime_build:/tmp/trade-analysis.eszip" "$trade_runtime_tmp/trade-analysis.eszip"
docker rm "$trade_runtime_build" >/dev/null
trade_runtime_build=''
trade_runtime_server=$(docker run -d --pull never --label com.supabase.cli.project=pt4bafableti --cpus=0.5 --memory=2g \
  -p 127.0.0.1:61930:9000 -v "$trade_runtime_tmp:/out:ro" "$trade_runtime_image" start \
  --main-service /out/trade-analysis.eszip --main-entrypoint /src/tests/db/trade-revaluation-analysis/index.mts)
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:61930 >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:61930 >/dev/null
docker update --cpus=0.5 supabase_db_pt4bafableti >/dev/null
if [ "${1-}" != --negative-control ]; then
  python3 tests/db/trade-revaluation-runtime.py --values-output ../trade-revaluation-runtime-values.json
fi
python3 tests/db/trade-revaluation-runtime.py --negative-control
