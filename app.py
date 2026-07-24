"""Backend do dashboard de apontamentos do Jira.

Sobe um servidor FastAPI que expoe a API de relatorios e serve o front-end
estatico. As credenciais do Jira chegam do navegador em headers
(X-Jira-Base-Url / X-Jira-Email / X-Jira-Token), salvas la via tela de login;
um .env ao lado deste script funciona como fallback opcional.

Rodar:  python app.py   (ou: uvicorn app:app --reload)
"""

import hashlib
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from jira_client import JiraClient, JiraError

BASE_DIR = Path(__file__).parent


def load_env():
    env_path = BASE_DIR / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

# fallback opcional: se o .env tiver credenciais, o app funciona sem login
ENV_BASE_URL = os.environ.get("JIRA_BASE_URL", "")
ENV_EMAIL = os.environ.get("JIRA_EMAIL", "")
ENV_TOKEN = os.environ.get("JIRA_TOKEN", "")
PORT = int(os.environ.get("PORT", "8000"))

app = FastAPI(title="Apontamentos Jira")

# ---------- credenciais por requisicao ----------

_clients: dict = {}
_clients_lock = threading.Lock()


def resolve_client(base_url: str | None, email: str | None, token: str | None):
    """Monta (client, fingerprint, base_url) a partir de headers ou do .env."""
    base_url = (base_url or ENV_BASE_URL or "").strip().rstrip("/")
    email = (email or ENV_EMAIL or "").strip()
    token = (token or ENV_TOKEN or "").strip()
    if not (base_url and email and token):
        raise HTTPException(401, "Credenciais do Jira nao configuradas — faca login.")
    fp = hashlib.sha256(f"{base_url}|{email}|{token}".encode()).hexdigest()[:16]
    with _clients_lock:
        client = _clients.get(fp)
        if client is None:
            client = JiraClient(base_url, email, token)
            _clients[fp] = client
    return client, fp, base_url


def client_dep(
    x_jira_base_url: str | None = Header(None),
    x_jira_email: str | None = Header(None),
    x_jira_token: str | None = Header(None),
):
    return resolve_client(x_jira_base_url, x_jira_email, x_jira_token)


def jira_http_error(e: JiraError) -> HTTPException:
    msg = str(e)
    if "-> 401" in msg or "-> 403" in msg:
        return HTTPException(401, "Jira recusou as credenciais — faca login novamente.")
    return HTTPException(502, msg)

# ---------- cache simples com TTL ----------

_cache: dict = {}
_cache_lock = threading.Lock()
CACHE_TTL = 300  # 5 min


def cached(key, builder, refresh: bool = False, ttl: int = CACHE_TTL):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and not refresh and now - hit[0] < ttl:
            return hit[1]
    data = builder()
    with _cache_lock:
        _cache[key] = (time.time(), data)
    return data


# ---------- helpers ----------


def parse_date(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"Parametro '{name}' invalido: esperado YYYY-MM-DD")


def csv_param(value: str | None) -> list[str]:
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def day_ms(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def adf_text(node) -> str:
    """Extrai texto puro de um documento ADF (comentario de worklog)."""
    if not node:
        return ""
    if isinstance(node, str):
        return node
    parts = []
    if isinstance(node, dict):
        if node.get("type") == "text":
            parts.append(node.get("text", ""))
        for child in node.get("content") or []:
            child_text = adf_text(child)
            if child_text:
                parts.append(child_text)
    return " ".join(parts)


def quote_list(values: list[str]) -> str:
    return ", ".join('"' + v.replace('"', "") + '"' for v in values)


def business_days(start: date, end: date) -> list[date]:
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5:  # seg a sex
            days.append(d)
        d += timedelta(days=1)
    return days


# ---------- montagem do relatorio ----------

ISSUE_FIELDS = ["summary", "project", "status", "issuetype", "assignee", "timetracking"]


def issue_info(issue: dict) -> dict:
    f = issue.get("fields", {})
    status = f.get("status") or {}
    assignee = f.get("assignee") or {}
    tt = f.get("timetracking") or {}
    return {
        "issueId": str(issue.get("id")),
        "issueKey": issue.get("key"),
        "summary": f.get("summary") or "",
        "projectKey": (f.get("project") or {}).get("key") or "",
        "projectName": (f.get("project") or {}).get("name") or "",
        "status": status.get("name") or "",
        "statusCategory": (status.get("statusCategory") or {}).get("key") or "",
        "issueType": (f.get("issuetype") or {}).get("name") or "",
        "assigneeId": assignee.get("accountId") or "",
        "assigneeName": assignee.get("displayName") or "",
        "estimateSeconds": tt.get("originalEstimateSeconds") or 0,
        "totalSpentSeconds": tt.get("timeSpentSeconds") or 0,
    }


def fetch_report(
    client: JiraClient, start: date, end: date, users: list[str], projects: list[str]
) -> dict:
    clauses = [f'worklogDate >= "{start.isoformat()}" AND worklogDate <= "{end.isoformat()}"']
    if projects:
        clauses.append(f"project in ({quote_list(projects)})")
    if users:
        clauses.append(f"worklogAuthor in ({quote_list(users)})")
    jql = " AND ".join(clauses)

    issues = client.search_issues(jql, ISSUE_FIELDS)
    info_by_id = {str(i["id"]): issue_info(i) for i in issues}

    # margem de +-1 dia para nao perder worklogs por fuso horario;
    # o filtro exato e feito abaixo pela data local do 'started'
    after_ms = day_ms(start - timedelta(days=1))
    before_ms = day_ms(end + timedelta(days=2))
    logs_by_issue = client.worklogs_for_issues(list(info_by_id), after_ms, before_ms)

    start_s, end_s = start.isoformat(), end.isoformat()
    user_set = set(users)
    entries = []
    for iid, logs in logs_by_issue.items():
        info = info_by_id.get(iid, {})
        for wl in logs:
            started = wl.get("started") or ""
            wl_date = started[:10]
            if not (start_s <= wl_date <= end_s):
                continue
            author = wl.get("author") or {}
            author_id = author.get("accountId") or ""
            if user_set and author_id not in user_set:
                continue
            entries.append(
                {
                    "date": wl_date,
                    "started": started,
                    "authorId": author_id,
                    "authorName": author.get("displayName") or "",
                    "seconds": wl.get("timeSpentSeconds") or 0,
                    "timeSpent": wl.get("timeSpent") or "",
                    "comment": adf_text(wl.get("comment")).strip(),
                    **{
                        k: info.get(k, "")
                        for k in (
                            "issueId",
                            "issueKey",
                            "summary",
                            "projectKey",
                            "projectName",
                            "status",
                            "statusCategory",
                            "issueType",
                            "estimateSeconds",
                            "totalSpentSeconds",
                        )
                    },
                }
            )

    entries.sort(key=lambda e: (e["date"], e["started"]))
    return {
        "start": start_s,
        "end": end_s,
        "entries": entries,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def get_report(
    client: JiraClient, fp: str, start: date, end: date,
    users: list[str], projects: list[str], refresh: bool,
):
    key = ("report", fp, start.isoformat(), end.isoformat(),
           tuple(sorted(users)), tuple(sorted(projects)))
    return cached(key, lambda: fetch_report(client, start, end, users, projects), refresh)


# ---------- rotas ----------


class LoginBody(BaseModel):
    baseUrl: str
    email: str
    token: str


@app.post("/api/login")
def api_login(body: LoginBody):
    client, fp, base_url = resolve_client(body.baseUrl, body.email, body.token)
    try:
        me = client.myself()
    except JiraError as e:
        with _clients_lock:
            _clients.pop(fp, None)
        msg = str(e)
        if "-> 401" in msg or "-> 403" in msg:
            raise HTTPException(401, "E-mail ou API token invalidos.")
        raise HTTPException(502, f"Nao consegui falar com {base_url}: {msg[:200]}")
    return {
        "accountId": me.get("accountId"),
        "displayName": me.get("displayName"),
        "baseUrl": base_url,
    }


@app.get("/api/meta")
def api_meta(refresh: bool = False, ctx=Depends(client_dep)):
    client, fp, base_url = ctx

    def build():
        users = client.users()
        projects = client.projects()
        me = client.myself()
        return {
            "baseUrl": base_url,
            "myself": {"accountId": me.get("accountId"), "displayName": me.get("displayName")},
            "users": sorted(
                (
                    {
                        "accountId": u["accountId"],
                        "displayName": u.get("displayName", ""),
                        "avatarUrl": (u.get("avatarUrls") or {}).get("24x24", ""),
                    }
                    for u in users
                ),
                key=lambda u: u["displayName"].lower(),
            ),
            "projects": sorted(
                ({"key": p["key"], "name": p.get("name", "")} for p in projects),
                key=lambda p: p["name"].lower(),
            ),
        }

    try:
        return cached(("meta", fp), build, refresh, ttl=3600)
    except JiraError as e:
        raise jira_http_error(e)


@app.get("/api/report")
def api_report(
    start: str = Query(...),
    end: str = Query(...),
    users: str | None = None,
    projects: str | None = None,
    refresh: bool = False,
    ctx=Depends(client_dep),
):
    client, fp, _ = ctx
    start_d, end_d = parse_date(start, "start"), parse_date(end, "end")
    if end_d < start_d:
        raise HTTPException(400, "'end' anterior a 'start'")
    if (end_d - start_d).days > 400:
        raise HTTPException(400, "Periodo maximo: 400 dias")
    try:
        return get_report(client, fp, start_d, end_d, csv_param(users), csv_param(projects), refresh)
    except JiraError as e:
        raise jira_http_error(e)


@app.get("/api/missing")
def api_missing(
    start: str = Query(...),
    end: str = Query(...),
    users: str | None = None,
    projects: str | None = None,
    expected: float = 8.0,
    refresh: bool = False,
    ctx=Depends(client_dep),
):
    """Dias uteis com apontamento abaixo do esperado + tasks mexidas sem apontamento."""
    client, fp, _ = ctx
    start_d, end_d = parse_date(start, "start"), parse_date(end, "end")
    user_ids = csv_param(users)
    project_keys = csv_param(projects)
    today = date.today()
    horizon = min(end_d, today)

    try:
        report = get_report(client, fp, start_d, end_d, user_ids, project_keys, refresh)

        # issues atualizadas no periodo (candidatas a "trabalhou mas nao apontou")
        clauses = [
            f'updated >= "{start_d.isoformat()}" AND updated < "{(end_d + timedelta(days=1)).isoformat()}"'
        ]
        if project_keys:
            clauses.append(f"project in ({quote_list(project_keys)})")
        clauses.append(
            f"assignee in ({quote_list(user_ids)})" if user_ids else "assignee is not EMPTY"
        )
        updated_issues = client.search_issues(" AND ".join(clauses), ISSUE_FIELDS)

        with _cache_lock:
            meta_hit = _cache.get(("meta", fp))
        meta = meta_hit[1] if meta_hit else {}
        name_by_id = {u["accountId"]: u["displayName"] for u in (meta.get("users") or [])}
    except JiraError as e:
        raise jira_http_error(e)

    # segundos apontados por (issue, autor) e por (autor, dia)
    by_issue_author: dict[tuple[str, str], int] = {}
    by_author_day: dict[str, dict[str, int]] = {}
    for e in report["entries"]:
        by_issue_author[(e["issueId"], e["authorId"])] = (
            by_issue_author.get((e["issueId"], e["authorId"]), 0) + e["seconds"]
        )
        by_author_day.setdefault(e["authorId"], {})
        by_author_day[e["authorId"]][e["date"]] = (
            by_author_day[e["authorId"]].get(e["date"], 0) + e["seconds"]
        )
        name_by_id.setdefault(e["authorId"], e["authorName"])

    # usuarios avaliados: filtro selecionado, senao autores + responsaveis vistos
    target_ids = list(user_ids)
    if not target_ids:
        seen = set(by_author_day)
        for i in updated_issues:
            assignee = (i.get("fields", {}).get("assignee") or {})
            if assignee.get("accountId"):
                seen.add(assignee["accountId"])
                name_by_id.setdefault(assignee["accountId"], assignee.get("displayName", ""))
        target_ids = sorted(seen, key=lambda a: (name_by_id.get(a) or "").lower())

    expected_seconds = int(expected * 3600)
    users_out = []
    workdays = business_days(start_d, horizon) if horizon >= start_d else []
    for uid in target_ids:
        days_logged = by_author_day.get(uid, {})
        missing_days = []
        for d in workdays:
            secs = days_logged.get(d.isoformat(), 0)
            if secs < expected_seconds:
                missing_days.append(
                    {"date": d.isoformat(), "seconds": secs, "isToday": d == today}
                )
        users_out.append(
            {
                "accountId": uid,
                "displayName": name_by_id.get(uid, uid),
                "totalSeconds": sum(days_logged.values()),
                "daysEvaluated": len(workdays),
                "missingDays": missing_days,
            }
        )

    issues_out = []
    seen_keys = set()
    for issue in updated_issues:
        info = issue_info(issue)
        if not info["assigneeId"] or info["assigneeId"] not in set(target_ids):
            continue
        if info["issueKey"] in seen_keys:
            continue
        seen_keys.add(info["issueKey"])
        own = by_issue_author.get((info["issueId"], info["assigneeId"]), 0)
        if own > 0:
            continue
        others = sum(
            secs for (iid, aid), secs in by_issue_author.items()
            if iid == info["issueId"] and aid != info["assigneeId"]
        )
        issues_out.append({**info, "othersSeconds": others})

    category_order = {"indeterminate": 0, "new": 1, "done": 2}
    issues_out.sort(
        key=lambda i: (category_order.get(i["statusCategory"], 3), i["assigneeName"].lower())
    )

    return {
        "start": start_d.isoformat(),
        "end": end_d.isoformat(),
        "horizon": horizon.isoformat(),
        "expectedHours": expected,
        "users": users_out,
        "issuesWithoutWorklog": issues_out,
    }


# ---------- front-end ----------

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    print(f"Dashboard em http://localhost:{PORT}")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
