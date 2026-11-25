"""Round 2 (25 Nov 2026): the repo deploys out of the box (Render blueprint, Dockerfile, production boot)."""
import base64
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

yaml = pytest.importorskip("yaml")

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent


def _render_service():
    data = yaml.safe_load((ROOT / "render.yaml").read_text())
    return data["services"][0]


def _env(svc):
    return {e["key"]: e for e in svc["envVars"]}


def test_render_blueprint_points_at_real_things(client):
    svc = _render_service()
    assert svc["runtime"] == "docker"
    assert (ROOT / svc["dockerfilePath"].lstrip("./")).is_file()
    assert (ROOT / svc["dockerContext"].lstrip("./")).resolve() == BACKEND
    assert client.get(svc["healthCheckPath"]).status_code == 200
    env = _env(svc)
    assert "https://tradex777.github.io" in env["CORS_ORIGINS"]["value"].split(",")
    assert env["ENVIRONMENT"]["value"] == "production"
    assert env["LIVE_TRADING_ENABLED"]["value"] == "false"
    assert env["JWT_SECRET"].get("generateValue") and env["FERNET_KEY"].get("generateValue")


def test_render_generated_values_pass_production_checks():
    from app.config import Settings, production_problems
    from app.security import CredentialVault

    env = _env(_render_service())
    # Render's generateValue is a random base64 256-bit string; it must satisfy the boot checks
    gen = base64.b64encode(secrets.token_bytes(32)).decode()
    s = Settings(environment="production", jwt_secret=gen, fernet_key=gen, cors_origins=env["CORS_ORIGINS"]["value"], _env_file=None)
    assert production_problems(s) == []
    v = CredentialVault(gen)
    assert v.decrypt(v.encrypt({"a": 1})) == {"a": 1}


def test_dockerfile_is_coherent():
    df = (BACKEND / "Dockerfile").read_text()
    assert "COPY requirements.txt requirements-brokers.txt ./" in df
    assert "COPY app ./app" in df
    assert "uvicorn app.main:app" in df and "--workers 1" in df and "${PORT:-8000}" in df
    assert "/health" in df  # HEALTHCHECK hits the same route Render checks
    for f in ("requirements.txt", "requirements-brokers.txt", "app/main.py"):
        assert (BACKEND / f).exists()


def test_empty_database_url_falls_back_to_sqlite():
    from app.db import DEFAULT_SQLITE_URL, _normalise_url

    assert _normalise_url("") == DEFAULT_SQLITE_URL and _normalise_url("  ") == DEFAULT_SQLITE_URL
    assert _normalise_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_uvicorn_boots_in_production_and_health_is_200(tmp_path):
    port = _free_port()
    gen = base64.b64encode(secrets.token_bytes(32)).decode()
    env = {
        **os.environ, "PYTHONPATH": str(BACKEND), "SCHEDULER_ENABLED": "true", "GEMINI_API_KEY": "", "OPENAI_BASE_URL": "",
        "ENVIRONMENT": "production", "JWT_SECRET": secrets.token_urlsafe(48), "FERNET_KEY": gen,
        "CORS_ORIGINS": "https://tradex777.github.io", "DATABASE_URL": "", "TRUST_PROXY_HEADERS": "true",
        "LIVE_TRADING_ENABLED": "false", "BETA_PLAN": "pro",
    }
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--workers", "1"],
                            cwd=tmp_path, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 30
        r = None
        while time.time() < deadline:
            try:
                r = httpx.get(f"http://127.0.0.1:{port}/health", timeout=2, trust_env=False)  # ignore any HTTP(S)_PROXY
                break
            except httpx.HTTPError:
                if proc.poll() is not None:
                    break
                time.sleep(0.3)
        assert r is not None and r.status_code == 200, proc.stdout.read().decode()[-2000:] if proc.poll() is not None else "no response"
        assert r.json()["ok"] is True
        assert r.headers.get("strict-transport-security")  # production headers on
        pre = httpx.options(f"http://127.0.0.1:{port}/api/strategies/copilot", trust_env=False, headers={
            "Origin": "https://tradex777.github.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        assert pre.headers.get("access-control-allow-origin") == "https://tradex777.github.io"
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_production_refuses_unsafe_settings():
    from app.config import Settings
    from app.main import check_startup_settings

    with pytest.raises(RuntimeError):
        check_startup_settings(Settings(environment="production", jwt_secret="change-me", cors_origins="*", _env_file=None))
