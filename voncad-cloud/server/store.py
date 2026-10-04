"""SQLite store: API keys, documents, versions, usage metering."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time

DATA = os.environ.get("VONCAD_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
DATA = os.path.abspath(DATA)
os.makedirs(os.path.join(DATA, "versions"), exist_ok=True)
DB = os.path.join(DATA, "voncad.db")

PLANS = {
    # builds/month, compute seconds/month, requests/minute, max build seconds
    "anon": {"builds_month": 300, "compute_s_month": 600, "rpm": 30, "timeout_s": 30, "agent_runs_month": 0},
    "free": {"builds_month": 2000, "compute_s_month": 3600, "rpm": 120, "timeout_s": 60,
             "agent_runs_month": int(os.environ.get("VONCAD_FREE_AGENT_RUNS", "10"))},
    "pro": {"builds_month": 100000, "compute_s_month": 200000, "rpm": 600, "timeout_s": 180, "agent_runs_month": 1000},
    "unlimited": {"builds_month": 10**12, "compute_s_month": 10**12, "rpm": 100000, "timeout_s": 600,
                  "agent_runs_month": 10**9},
}

_local = threading.local()
_lock = threading.Lock()

SCHEMA = """
create table if not exists keys(
  id text primary key, email text, key_hash text unique, plan text, created real);
create table if not exists documents(
  id text primary key, owner text, name text, public integer, created real, updated real, head text);
create table if not exists versions(
  id text primary key, document_id text, parent text, script text, params text, message text,
  status text, error text, logs text, summary text, param_schema text, steps text, created real, owner text);
create table if not exists usage(
  owner text, month text, builds integer default 0, calls integer default 0, compute_ms integer default 0,
  primary key(owner, month));
create index if not exists versions_doc on versions(document_id, created);
create index if not exists docs_owner on documents(owner, updated);
"""


def db() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB, timeout=30, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("pragma journal_mode=wal")
        c.executescript(SCHEMA)
        _local.conn = c
    return c


def new_id(prefix: str) -> str:
    return prefix + "_" + secrets.token_urlsafe(9).replace("-", "x").replace("_", "z")


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


# ------------------------------------------------------------------ keys

def create_key(email: str, plan: str = "free") -> dict:
    key = "vc_" + secrets.token_urlsafe(24)
    kid = new_id("usr")
    with _lock:
        db().execute("insert into keys values(?,?,?,?,?)", (kid, email, _hash(key), plan, time.time()))
        db().commit()
    return {"api_key": key, "owner": kid, "plan": plan}


def lookup_key(key: str) -> dict | None:
    row = db().execute("select * from keys where key_hash=?", (_hash(key),)).fetchone()
    return dict(row) if row else None


def ensure_admin_key():
    """VONCAD_ADMIN_KEY env var -> an unlimited key (for the owner)."""
    k = os.environ.get("VONCAD_ADMIN_KEY")
    if k and not lookup_key(k):
        with _lock:
            db().execute("insert into keys values(?,?,?,?,?)", ("usr_admin", "admin", _hash(k), "unlimited", time.time()))
            db().commit()


# ------------------------------------------------------------------ usage

def month() -> str:
    return time.strftime("%Y-%m")


def record_usage(owner: str, builds=0, calls=1, compute_ms=0):
    with _lock:
        db().execute("""insert into usage(owner, month, builds, calls, compute_ms) values(?,?,?,?,?)
            on conflict(owner, month) do update set builds=builds+excluded.builds,
            calls=calls+excluded.calls, compute_ms=compute_ms+excluded.compute_ms""",
                     (owner, month(), builds, calls, int(compute_ms)))
        db().commit()


def get_usage(owner: str) -> dict:
    row = db().execute("select * from usage where owner=? and month=?", (owner, month())).fetchone()
    return {"month": month(), "builds": row["builds"] if row else 0, "calls": row["calls"] if row else 0,
            "compute_ms": row["compute_ms"] if row else 0}


# ------------------------------------------------------------------ documents / versions

def vdir(vid: str) -> str:
    safe = "".join(ch for ch in vid if ch.isalnum() or ch in "_-")
    return os.path.join(DATA, "versions", safe)


def create_document(owner: str, name: str, public: bool) -> dict:
    did = new_id("doc")
    now = time.time()
    with _lock:
        db().execute("insert into documents values(?,?,?,?,?,?,?)", (did, owner, name, int(public), now, now, None))
        db().commit()
    return get_document(did)


def get_document(did: str) -> dict | None:
    row = db().execute("select * from documents where id=?", (did,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["public"] = bool(d["public"])
    return d


def list_documents(owner: str, limit=100) -> list[dict]:
    rows = db().execute("select * from documents where owner=? order by updated desc limit ?", (owner, limit)).fetchall()
    return [dict(r) | {"public": bool(r["public"])} for r in rows]


def rename_document(did: str, name=None, public=None):
    with _lock:
        if name is not None:
            db().execute("update documents set name=? where id=?", (name, did))
        if public is not None:
            db().execute("update documents set public=? where id=?", (int(public), did))
        db().commit()


def delete_document(did: str):
    import shutil
    vids = [r["id"] for r in db().execute("select id from versions where document_id=?", (did,))]
    with _lock:
        db().execute("delete from versions where document_id=?", (did,))
        db().execute("delete from documents where id=?", (did,))
        db().commit()
    for v in vids:
        shutil.rmtree(vdir(v), ignore_errors=True)


def save_version(vid, did, parent, script, params, message, result, owner) -> dict:
    now = time.time()
    with _lock:
        db().execute("insert into versions values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            vid, did, parent, script, json.dumps(params or {}), message or "",
            "ok" if result["ok"] else "error", result.get("error"), result.get("logs", ""),
            json.dumps(result.get("summary")), json.dumps(result.get("param_schema", [])),
            json.dumps(result.get("steps", [])), now, owner))
        if did:
            if result["ok"]:
                db().execute("update documents set updated=?, head=? where id=?", (now, vid, did))
            else:
                db().execute("update documents set updated=? where id=?", (now, did))
        db().commit()
    return get_version(vid)


def get_version(vid: str) -> dict | None:
    row = db().execute("select * from versions where id=?", (vid,)).fetchone()
    if not row:
        return None
    v = dict(row)
    for k in ("params", "summary", "param_schema", "steps"):
        v[k] = json.loads(v[k]) if v[k] else None
    return v


def list_versions(did: str) -> list[dict]:
    rows = db().execute("select id, parent, message, status, error, created from versions where document_id=? order by created",
                        (did,)).fetchall()
    return [dict(r) for r in rows]
