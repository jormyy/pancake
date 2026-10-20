#!/bin/bash
set -euo pipefail
eval "$(supabase-go status -o env 2>/dev/null)"
export SUPABASE_URL="$API_URL"
export SUPABASE_DB_URL="$DB_URL"
export PANCAKE_TEST_API_PORT=57321
export PANCAKE_TEST_DB_PORT=57322
export PANCAKE_SUPABASE_SECRET_KEY="$SECRET_KEY"
export PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token
export E2E_SUPABASE_URL="$API_URL"
export E2E_PANCAKE_SUPABASE_SECRET_KEY="$SECRET_KEY"
export E2E_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
python3 - <<'PY'
import os
from urllib.parse import urlparse
for key, port in [('SUPABASE_URL', 57321), ('SUPABASE_DB_URL', 57322)]:
    endpoint = urlparse(os.environ[key])
    if endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.port != port:
        raise SystemExit('Only the assigned loopback services are allowed')
PY
exec "$@"
