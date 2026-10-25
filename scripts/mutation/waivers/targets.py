import os
import re
from urllib.parse import urlparse


def database_target(env=None):
    env = os.environ if env is None else env
    expected_port = env.get('PANCAKE_TEST_DB_PORT', '54322')
    value = env.get('SUPABASE_DB_URL', '')
    try:
        url = urlparse(value)
        valid = (
            re.fullmatch(r'[1-9]\d{0,4}', expected_port, re.ASCII)
            and int(expected_port) <= 65535
            and url.scheme in ('postgres', 'postgresql')
            and url.hostname in ('127.0.0.1', 'localhost')
            and url.port == int(expected_port)
        )
    except ValueError:
        valid = False
    if not valid:
        raise SystemExit(f'Refuse a target outside loopback port {expected_port}')
    return value
