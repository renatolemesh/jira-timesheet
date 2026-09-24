"""Login com a Atlassian (OAuth 2.0 3LO).

Substitui a antiga tela que pedia URL + e-mail + API token: um formulario
publico pedindo API token do Jira num dominio que nao e da Atlassian e,
visto de fora, identico a phishing - e foi denunciado como tal em 22/09/2026.
Agora o usuario autoriza na propria Atlassian e este servidor so recebe um
token de acesso somente leitura.

Fluxo:
  /auth/login     -> redireciona para auth.atlassian.com com um `state` aleatorio
  /auth/callback  -> confere o state, troca o `code` por tokens e descobre os
                     sites Jira que o usuario autorizou
  /auth/sites     -> so aparece se o usuario autorizou mais de um site

Sessoes ficam SO em memoria (nada em disco, como promete /privacy): reiniciar
o container desloga todo mundo, e isso e aceitavel.
"""

import hashlib
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlencode

import requests

AUTH_URL = "https://auth.atlassian.com/authorize"
TOKEN_URL = "https://auth.atlassian.com/oauth/token"
RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"
API_BASE = "https://api.atlassian.com/ex/jira/{cloud_id}"

# offline_access: devolve refresh_token, senao a sessao morre em 1h
SCOPES = "read:jira-work read:jira-user offline_access"

COOKIE_SESSAO = "sessao"
COOKIE_STATE = "oauth_state"
SESSAO_MAX_IDADE = 30 * 24 * 3600  # sessao parada ha mais que isso e descartada

# renova o access token um pouco antes de expirar (ele vale 1h)
MARGEM_RENOVACAO = 120


class OAuthError(Exception):
    pass


def config():
    return {
        "client_id": os.environ.get("ATLASSIAN_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("ATLASSIAN_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.environ.get(
            "ATLASSIAN_REDIRECT_URI", "https://jira-timesheet.rlhtech.com.br/auth/callback"
        ).strip(),
    }


def configurado() -> bool:
    c = config()
    return bool(c["client_id"] and c["client_secret"])


def url_autorizacao(state: str) -> str:
    c = config()
    return AUTH_URL + "?" + urlencode({
        "audience": "api.atlassian.com",
        "client_id": c["client_id"],
        "scope": SCOPES,
        "redirect_uri": c["redirect_uri"],
        "state": state,
        "response_type": "code",
        "prompt": "consent",
    })


def _post_token(payload: dict) -> dict:
    c = config()
    body = {"client_id": c["client_id"], "client_secret": c["client_secret"], **payload}
    r = requests.post(TOKEN_URL, json=body, timeout=30)
    if r.status_code >= 400:
        raise OAuthError(f"token -> {r.status_code}: {r.text[:200]}")
    return r.json()


def trocar_code(code: str) -> dict:
    return _post_token({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": config()["redirect_uri"],
    })


def sites_autorizados(access_token: str) -> list[dict]:
    """Sites Jira que o usuario liberou (a lista tambem traz Confluence etc.)."""
    r = requests.get(
        RESOURCES_URL,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        timeout=30,
    )
    if r.status_code >= 400:
        raise OAuthError(f"accessible-resources -> {r.status_code}: {r.text[:200]}")
    return [
        {"id": s["id"], "url": s["url"].rstrip("/"), "name": s.get("name") or s["url"]}
        for s in r.json()
        if "read:jira-work" in (s.get("scopes") or [])
    ]


# ---------- sessoes ----------


@dataclass
class Sessao:
    access_token: str
    refresh_token: str
    expira_em: float
    sites: list[dict]
    site: dict | None = None
    account_id: str = ""
    display_name: str = ""
    client: object = None  # JiraClient do site escolhido
    ultimo_uso: float = field(default_factory=time.time)
    # o refresh_token e rotativo (cada uso gera outro): duas requisicoes
    # paralelas renovando ao mesmo tempo invalidariam uma a outra
    trava: threading.Lock = field(default_factory=threading.Lock)

    @property
    def fingerprint(self) -> str:
        chave = f"{self.site['id'] if self.site else ''}|{self.account_id}"
        return hashlib.sha256(chave.encode()).hexdigest()[:16]

    def garantir_token(self):
        """Renova o access token se estiver perto de expirar."""
        with self.trava:
            if time.time() < self.expira_em - MARGEM_RENOVACAO:
                return
            dados = _post_token({
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
            })
            self._aplicar_tokens(dados)

    def _aplicar_tokens(self, dados: dict):
        self.access_token = dados["access_token"]
        self.refresh_token = dados.get("refresh_token", self.refresh_token)
        self.expira_em = time.time() + int(dados.get("expires_in", 3600))
        if self.client is not None:
            self.client.set_bearer(self.access_token)


_sessoes: dict[str, Sessao] = {}
_sessoes_lock = threading.Lock()


def criar_sessao(tokens: dict, sites: list[dict]) -> tuple[str, Sessao]:
    agora = time.time()
    sessao = Sessao(
        access_token=tokens["access_token"],
        refresh_token=tokens.get("refresh_token", ""),
        expira_em=agora + int(tokens.get("expires_in", 3600)),
        sites=sites,
    )
    sid = secrets.token_urlsafe(32)
    with _sessoes_lock:
        # aproveita o login para varrer sessoes abandonadas
        for velho in [k for k, s in _sessoes.items() if agora - s.ultimo_uso > SESSAO_MAX_IDADE]:
            del _sessoes[velho]
        _sessoes[sid] = sessao
    return sid, sessao


def obter_sessao(sid: str | None) -> Sessao | None:
    if not sid:
        return None
    with _sessoes_lock:
        sessao = _sessoes.get(sid)
    if sessao is not None:
        sessao.ultimo_uso = time.time()
    return sessao


def encerrar_sessao(sid: str | None):
    if sid:
        with _sessoes_lock:
            _sessoes.pop(sid, None)
