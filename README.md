# Apontamentos Jira — Dashboard

Dashboard web local para acompanhar tempo apontado (worklogs) no Jira Cloud:
horas por dia/semana/mês, por pessoa, por projeto e por task, com detecção de
dias úteis e tasks **sem apontamento**.

## Como rodar

### Com Docker (recomendado)

Só precisa do Docker (Desktop no Windows/Mac, engine no Linux):

```powershell
cd jira-dashboard
docker compose up -d
```

Abra <http://localhost:8000>. Para atualizar depois de mudar o código:
`docker compose up -d --build`. Para parar: `docker compose down`.
Com `restart: unless-stopped`, o container volta sozinho quando o Docker inicia
— bom para deixar rodando num servidor da rede interna para o time todo.

### Direto com Python

Precisa de Python 3.10+:

```powershell
cd jira-dashboard
pip install -r requirements.txt
python app.py
```

Abra <http://localhost:8000>.

## Login

Na primeira vez, o app mostra uma tela de login pedindo a URL do Jira, e-mail e
[API token da Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens).
As credenciais são validadas no Jira (`/myself`), salvas no `localStorage` do
navegador e enviadas ao backend em headers a cada requisição — cada pessoa usa
o dashboard com a própria conta. O botão **Sair** esquece as credenciais.

Opcionalmente, dá para preencher `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_TOKEN`
no `.env` para pular o login (uso pessoal). O `.env` está no `.gitignore` —
**não** commite credenciais.

> Observação: o token fica legível no `localStorage` do navegador — adequado
> para uso local/interno; não exponha o servidor na internet.

## O que tem

- **Dashboard** — total apontado, média por dia útil, dias com apontamento,
  gráfico de horas por dia (empilhado por pessoa; vira semana/mês em períodos
  longos), horas por pessoa, por projeto e tabela por task (com % do total e
  estimativa original).
- **Apontamentos** — todos os worklogs do período com busca livre e exportação
  em **Excel (.xlsx) ou CSV** (separador `;`, compatível com Excel pt-BR), com
  cabeçalho de totais (período, pessoas, projetos, total de horas — pronto para
  anexar em fatura), escolha de quais campos exportar (ou o conjunto padrão) e
  dois relatórios: apontamentos detalhados ou resumo por task.
- **Sem apontamento** — por pessoa, os dias úteis com menos horas que a meta
  (padrão 8h/dia, configurável no filtro), e as tasks atualizadas no período
  cujo responsável não registrou tempo nelas.
- **Filtros** — presets de período (hoje, semana, mês, mês passado, 30 dias),
  datas livres, multi-seleção de pessoas e projetos.

## Como busca os dados (API Jira Cloud v3)

1. `POST /rest/api/3/search/jql` com `worklogDate >= inicio AND worklogDate <= fim`
   (+ filtros de projeto/autor) encontra as issues com apontamento no período.
2. `GET /rest/api/3/issue/{id}/worklog?startedAfter&startedBefore` busca os
   worklogs de cada issue em paralelo (8 threads), com margem de ±1 dia para
   fuso horário; o filtro fino por data/autor é feito no backend.
3. Para "tasks sem apontamento": issues com `updated` no período e responsável
   definido, cruzadas com os worklogs — as que o responsável não apontou nada
   aparecem na lista.

As respostas ficam em cache por 5 minutos; o botão **Atualizar** força uma nova
consulta.

## Limitações conhecidas

- Feriados não são descontados na análise de dias sem apontamento (só fins de
  semana).
- A lista de pessoas vem de `/users/search` (usuários Atlassian ativos do site).
- Período máximo por consulta: 400 dias.
