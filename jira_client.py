"""Cliente da API REST do Jira Cloud (v3).

Endpoints usados:
  - POST /rest/api/3/search/jql          -> busca de issues (paginacao por nextPageToken)
  - GET  /rest/api/3/issue/{id}/worklog  -> worklogs de uma issue (startedAfter/startedBefore)
  - GET  /rest/api/3/users/search        -> usuarios do site
  - GET  /rest/api/3/project/search      -> projetos
  - GET  /rest/api/3/myself              -> usuario autenticado
"""

from concurrent.futures import ThreadPoolExecutor, as_completed

import requests


class JiraError(Exception):
    pass


class JiraClient:
    def __init__(self, base_url: str, email: str = "", token: str = "", bearer: str = ""):
        """`bearer`: token OAuth (base_url = api.atlassian.com/ex/jira/{cloudId}).
        `email` + `token`: API token classico, so para uso local via .env."""
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        if bearer:
            self.set_bearer(bearer)
        else:
            self.session.auth = (email, token)

    def set_bearer(self, access_token: str):
        self.session.headers["Authorization"] = f"Bearer {access_token}"

    # ---------- HTTP ----------

    def _get(self, path: str, params: dict | None = None):
        r = self.session.get(f"{self.base_url}{path}", params=params, timeout=60)
        if r.status_code >= 400:
            raise JiraError(f"GET {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    def _post(self, path: str, payload: dict):
        r = self.session.post(f"{self.base_url}{path}", json=payload, timeout=60)
        if r.status_code >= 400:
            raise JiraError(f"POST {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    # ---------- API ----------

    def myself(self) -> dict:
        return self._get("/rest/api/3/myself")

    def search_issues(self, jql: str, fields: list[str]) -> list[dict]:
        """Busca todas as issues de um JQL (pagina ate o fim)."""
        issues: list[dict] = []
        next_token = None
        while True:
            payload: dict = {"jql": jql, "fields": fields, "maxResults": 100}
            if next_token:
                payload["nextPageToken"] = next_token
            data = self._post("/rest/api/3/search/jql", payload)
            issues.extend(data.get("issues", []))
            next_token = data.get("nextPageToken")
            if not next_token or data.get("isLast"):
                break
        return issues

    def issue_worklogs(self, issue_id: str, after_ms: int, before_ms: int) -> list[dict]:
        logs: list[dict] = []
        start_at = 0
        while True:
            data = self._get(
                f"/rest/api/3/issue/{issue_id}/worklog",
                params={
                    "startedAfter": after_ms,
                    "startedBefore": before_ms,
                    "startAt": start_at,
                    "maxResults": 1000,
                },
            )
            values = data.get("worklogs", [])
            logs.extend(values)
            start_at += len(values)
            if not values or start_at >= data.get("total", 0):
                break
        return logs

    def worklogs_for_issues(
        self, issue_ids: list[str], after_ms: int, before_ms: int, max_workers: int = 8
    ) -> dict[str, list[dict]]:
        """Busca worklogs de varias issues em paralelo. Retorna {issue_id: [worklogs]}."""
        result: dict[str, list[dict]] = {}
        if not issue_ids:
            return result
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = {
                ex.submit(self.issue_worklogs, iid, after_ms, before_ms): iid
                for iid in issue_ids
            }
            for fut in as_completed(futures):
                result[futures[fut]] = fut.result()
        return result

    def users(self) -> list[dict]:
        """Usuarios humanos ativos do site."""
        out: list[dict] = []
        start_at = 0
        page = 200
        while True:
            batch = self._get(
                "/rest/api/3/users/search", params={"startAt": start_at, "maxResults": page}
            )
            if not batch:
                break
            out.extend(batch)
            start_at += len(batch)
            if len(batch) < page:
                break
        return [u for u in out if u.get("accountType") == "atlassian" and u.get("active")]

    def projects(self) -> list[dict]:
        out: list[dict] = []
        start_at = 0
        while True:
            data = self._get(
                "/rest/api/3/project/search", params={"startAt": start_at, "maxResults": 100}
            )
            values = data.get("values", [])
            out.extend(values)
            if data.get("isLast") or not values:
                break
            start_at += len(values)
        return out
