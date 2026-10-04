from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import threading
import time

DATA_DIRECTORY = os.path.abspath(os.environ.get(
    "BISCAD_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")))
os.makedirs(os.path.join(DATA_DIRECTORY, "versions"), exist_ok=True)
DATABASE_PATH = os.path.join(DATA_DIRECTORY, "biscad.db")

PLANS = {
    "anon": {"builds_month": 300, "compute_s_month": 600, "rpm": 30, "timeout_s": 30, "agent_runs_month": 0},
    "free": {"builds_month": 2000, "compute_s_month": 3600, "rpm": 120, "timeout_s": 60,
             "agent_runs_month": int(os.environ.get("BISCAD_FREE_AGENT_RUNS", "10"))},
    "pro": {"builds_month": 100000, "compute_s_month": 200000, "rpm": 600, "timeout_s": 180, "agent_runs_month": 1000},
    "unlimited": {"builds_month": 10**12, "compute_s_month": 10**12, "rpm": 100000, "timeout_s": 600,
                  "agent_runs_month": 10**9},
}

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

_connection_per_thread = threading.local()
_write_lock = threading.Lock()


def _connection_for_current_thread() -> sqlite3.Connection:
    connection = getattr(_connection_per_thread, "connection", None)
    if connection is not None:
        return connection
    connection = sqlite3.connect(DATABASE_PATH, timeout=30, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("pragma journal_mode=wal")
    connection.executescript(SCHEMA)
    _connection_per_thread.connection = connection
    return connection


def _query_rows(statement: str, parameters: tuple) -> list[sqlite3.Row]:
    return _connection_for_current_thread().execute(statement, parameters).fetchall()


def _execute_writes_atomically(*statements_with_parameters: tuple[str, tuple]):
    with _write_lock:
        connection = _connection_for_current_thread()
        for statement, parameters in statements_with_parameters:
            connection.execute(statement, parameters)
        connection.commit()


def new_random_id_with_prefix(prefix: str) -> str:
    return prefix + "_" + secrets.token_urlsafe(9).replace("-", "x").replace("_", "z")


def _sha256_hex_of_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()


def _insert_api_key_statement(owner_id: str, email: str, api_key: str, plan: str) -> tuple[str, tuple]:
    return "insert into keys values(?,?,?,?,?)", (owner_id, email, _sha256_hex_of_api_key(api_key), plan, time.time())


def create_api_key(email: str, plan: str = "free") -> dict:
    api_key = "bsc_" + secrets.token_urlsafe(24)
    owner_id = new_random_id_with_prefix("usr")
    _execute_writes_atomically(_insert_api_key_statement(owner_id, email, api_key, plan))
    return {"api_key": api_key, "owner": owner_id, "plan": plan}


def find_api_key_row(api_key: str) -> dict | None:
    rows = _query_rows("select * from keys where key_hash=?", (_sha256_hex_of_api_key(api_key),))
    return dict(rows[0]) if rows else None


def ensure_admin_api_key_from_environment():
    admin_api_key = os.environ.get("BISCAD_ADMIN_KEY")
    if admin_api_key and not find_api_key_row(admin_api_key):
        _execute_writes_atomically(_insert_api_key_statement("usr_admin", "admin", admin_api_key, "unlimited"))


def current_month_label() -> str:
    return time.strftime("%Y-%m")


def record_usage(owner: str, build_count=0, call_count=1, compute_milliseconds=0):
    _execute_writes_atomically(("""insert into usage(owner, month, builds, calls, compute_ms) values(?,?,?,?,?)
        on conflict(owner, month) do update set builds=builds+excluded.builds,
        calls=calls+excluded.calls, compute_ms=compute_ms+excluded.compute_ms""",
                                (owner, current_month_label(), build_count, call_count, int(compute_milliseconds))))


def usage_this_month(owner: str) -> dict:
    rows = _query_rows("select * from usage where owner=? and month=?", (owner, current_month_label()))
    counters = {counter: rows[0][counter] if rows else 0 for counter in ("builds", "calls", "compute_ms")}
    return {"month": current_month_label(), **counters}


def directory_for_version(version_id: str) -> str:
    safe_version_id = "".join(character for character in version_id if character.isalnum() or character in "_-")
    return os.path.join(DATA_DIRECTORY, "versions", safe_version_id)


def _document_from_row(row: sqlite3.Row) -> dict:
    return dict(row) | {"public": bool(row["public"])}


def create_document(owner: str, name: str, is_public: bool) -> dict:
    document_id = new_random_id_with_prefix("doc")
    now = time.time()
    _execute_writes_atomically(("insert into documents values(?,?,?,?,?,?,?)",
                                (document_id, owner, name, int(is_public), now, now, None)))
    return get_document(document_id)


def get_document(document_id: str) -> dict | None:
    rows = _query_rows("select * from documents where id=?", (document_id,))
    return _document_from_row(rows[0]) if rows else None


def list_documents(owner: str, limit=100) -> list[dict]:
    rows = _query_rows("select * from documents where owner=? order by updated desc limit ?", (owner, limit))
    return [_document_from_row(row) for row in rows]


def update_document_name_and_visibility(document_id: str, name=None, is_public=None):
    name_update = [("update documents set name=? where id=?", (name, document_id))] if name is not None else []
    visibility_update = ([("update documents set public=? where id=?", (int(is_public), document_id))]
                         if is_public is not None else [])
    _execute_writes_atomically(*name_update, *visibility_update)


def delete_document_and_its_versions(document_id: str):
    version_ids = [row["id"] for row in _query_rows("select id from versions where document_id=?", (document_id,))]
    _execute_writes_atomically(("delete from versions where document_id=?", (document_id,)),
                               ("delete from documents where id=?", (document_id,)))
    for version_id in version_ids:
        shutil.rmtree(directory_for_version(version_id), ignore_errors=True)


def _document_head_update(document_id: str | None, version_id: str, is_build_ok: bool, now: float) -> list:
    if not document_id:
        return []
    if is_build_ok:
        return [("update documents set updated=?, head=? where id=?", (now, version_id, document_id))]
    return [("update documents set updated=? where id=?", (now, document_id))]


def save_version(version_id, document_id, parent, script, params, message, build_outcome, owner) -> dict:
    now = time.time()
    version_row = (
        version_id, document_id, parent, script, json.dumps(params or {}), message or "",
        "ok" if build_outcome["ok"] else "error", build_outcome.get("error"), build_outcome.get("logs", ""),
        json.dumps(build_outcome.get("summary")), json.dumps(build_outcome.get("param_schema", [])),
        json.dumps(build_outcome.get("steps", [])), now, owner)
    _execute_writes_atomically(("insert into versions values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", version_row),
                               *_document_head_update(document_id, version_id, build_outcome["ok"], now))
    return get_version(version_id)


def get_version(version_id: str) -> dict | None:
    rows = _query_rows("select * from versions where id=?", (version_id,))
    if not rows:
        return None
    version = dict(rows[0])
    json_columns = ("params", "summary", "param_schema", "steps")
    return version | {column: json.loads(version[column]) if version[column] else None for column in json_columns}


def list_version_history(document_id: str) -> list[dict]:
    rows = _query_rows("select id, parent, message, status, error, created from versions "
                       "where document_id=? order by created", (document_id,))
    return [dict(row) for row in rows]
