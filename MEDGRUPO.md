# Fork Medgrupo do OneUptime

Fork do [OneUptime](https://github.com/OneUptime/oneuptime) usado pela plataforma
Medgrupo (self-hosted no hub ArgoCD `Management-0226`, UI em
`https://oneuptime.mgmt.medgrupo.com.br`). Deploy via GitOps no repo
`MEDGRUPOGIT/gitops-platform` (`platform/med-uptime/`).

> **Regra de ouro:** a imagem de produção é buildada da branch **`medgrupo/11.0.3-fixes`**
> (ou de uma das suas git-tags `11.0.3-medgrupo.N`), **NUNCA do `master`**. O `master`
> aqui é um espelho antigo do upstream que **não tem o backend OIDC** — buildar dele
> quebra o SSO (foi o que aconteceu com a imagem `.4`, revertida). Sempre confirme a
> feature na fonte antes de buildar: `git grep -il oidc App/FeatureSet/Identity`.

## Branch model

| Ref | Papel |
|---|---|
| `medgrupo/11.0.3-fixes` | **Canônica.** Base = upstream tag `11.0.3` (commit `f8cc28cc00`, tem OIDC) + patches Medgrupo. É de onde saem as imagens. |
| `11.0.3-medgrupo.N` (git-tags) | Snapshots imutáveis dessa branch, 1:1 com a tag da imagem no ghcr. |
| `master` | Espelho antigo do upstream (base **sem OIDC**). Não use pra build. |

## Tag scheme

git-tag `11.0.3-medgrupo.N` ⇄ imagens
`ghcr.io/nidiodolfini/oneuptime-{app,probe}:11.0.3-medgrupo.N`.
Sempre crie a git-tag no commit buildado (reprodutibilidade).

Histórico:
- `.1` — baseline: upstream 11.0.3 + 12 patches (max_tokens, slack-suppress, isRoot,
  stalled-job, race-safe, pyroscope, 3× trace-hex, N+1, import-morto, docs).
- `.5` — `.1` + 2 patches de UX (abaixo). Imagem de produção atual.
- ~~`.4`~~ — **NÃO USAR**: buildada do `master` (sem OIDC), regrediu o login SSO.

## Patches de UX Medgrupo

Sobre o baseline, dois ajustes cosméticos de login (ver
[gitops SSO runbook](https://github.com/MEDGRUPOGIT/gitops-platform/blob/main/docs/oneuptime-sso-keycloak.md)):

1. **Botão "Login com Keycloak"** — `App/FeatureSet/Accounts/src/Pages/Login.tsx`:
   `<a href="/identity/oidc/{projectId}/{projectOidcId}">` no footer do form. Vai direto
   ao Keycloak (rota `GET /oidc/:p/:o` de `App/FeatureSet/Identity/API/OIDC.ts`), pulando
   a tela de e-mail. Os IDs são hardcoded do projeto "Medgrupo" — se recriar a config
   OIDC, atualizar o `href` e rebuildar.
2. **Rodapé "Medgrupo"** — `Common/UI/Components/EditionLabel/EditionLabel.tsx`: reescrito
   como `<span>` estático "Medgrupo", removendo o badge "Enterprise Edition (License
   Required)" + o modal de licença. Rodamos com `IS_ENTERPRISE_EDITION=true` (env de
   **runtime**, setada no chart do gitops — não é baked na imagem) só pra liberar
   SSO/OIDC/SCIM no self-host (Apache 2.0, sem licença comercial).

## Como buildar e publicar a imagem

Não há CI que emita a tag `medgrupo.N` (o `release.yml` usa o arquivo `VERSION`; o
`build.yml` só compila, não faz push). Build é **manual via Docker**:

```bash
# 1) Fonte reproduzível: a git-tag (ou o tip da branch canônica p/ uma nova versão)
git checkout 11.0.3-medgrupo.1            # ou: git checkout medgrupo/11.0.3-fixes

# 2) (Windows) normalizar EOL p/ LF — senão os *.sh viram CRLF e o bash do
#    container quebra ("$'\r': command not found") no `build-frontends:prod`.
git config core.autocrlf false && git rm --cached -rq . && git reset --hard

# 3) Renderizar App/Dockerfile a partir do .tpl. O prerun oficial
#    (`npm run prerun` = configure.sh) usa `gomplate` e precisa de sudo (feito p/ o
#    runner do CI). Sem gomplate, renderize à mão: o único bloco de template é
#    `{{ if eq .Env.ENVIRONMENT "development" }} DEV {{ else }} PROD {{ end }}` —
#    mantenha o ramo PROD. ATENÇÃO: os nºs de linha do if/else/end VARIAM por base;
#    rode `grep -n '{{' App/Dockerfile.tpl` ANTES.
grep -n '{{' App/Dockerfile.tpl
sed '<IF>,<ELSE>d;<END>d' App/Dockerfile.tpl > App/Dockerfile   # ajuste os nºs
grep -cF '{{' App/Dockerfile   # tem que dar 0

# 4) Build (amd64 p/ os nodes EKS). Redirecione a saída a arquivo — `... | tail`
#    MASCARA o exit code do docker (reporta 0 mesmo falhando).
TAG=11.0.3-medgrupo.5
docker build -f App/Dockerfile \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg APP_VERSION=$TAG \
  --build-arg IS_ENTERPRISE_EDITION=true \
  -t ghcr.io/nidiodolfini/oneuptime-app:$TAG . > build.log 2>&1
docker image inspect ghcr.io/nidiodolfini/oneuptime-app:$TAG --format '{{.Architecture}}'  # amd64

# 5) Push (token com escopo write:packages)
gh auth token | docker login ghcr.io -u <seu-user> --password-stdin
docker push ghcr.io/nidiodolfini/oneuptime-app:$TAG

# 6) Tag git p/ reprodutibilidade
git tag $TAG && git push origin $TAG
```

O `oneuptime-probe` só precisa de rebuild se mexer no `Probe/` — a UI (botão/rodapé)
não afeta o probe.

## Deploy

Bump da tag em `gitops-platform`:
`platform/med-uptime/chart/values.yaml` → `oneuptime.image.tag` (e, se rebuildou o
probe, o bloco do probe). PR → merge → ArgoCD sync no `Management-0226` → rollout
(PDB `maxUnavailable:1`, 3 réplicas, sem downtime).

## Referências

- [SSO via Keycloak (OIDC) — runbook](https://github.com/MEDGRUPOGIT/gitops-platform/blob/main/docs/oneuptime-sso-keycloak.md)
- [Deploy OneUptime (visão geral)](https://github.com/MEDGRUPOGIT/gitops-platform/blob/main/docs/oneuptime.md)
- Upstream: [OneUptime/oneuptime](https://github.com/OneUptime/oneuptime) (Apache 2.0)
