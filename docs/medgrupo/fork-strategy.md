# Plano: Fork do OneUptime + fixes upstream-compatible

**Data**: 2026-04-11
**Status**: Proposto, aguardando aprovação
**Duração estimada**: 4–6 horas de trabalho ativo + tempo assíncrono de build/deploy

## Contexto

OneUptime 10.0.55 rodando no Medgrupo (hub `Management-0226`) tem 5 bugs upstream identificados durante a operação pós-rebuild de 2026-04-11. Workarounds locais (scale de réplicas, delete de componentes órfãos) empurraram o impacto mas não resolvem a raiz.

Proposta do user: forkar o `OneUptime/oneuptime` upstream, fixar os bugs em commits separados (cada um upstream-compatible para virar PR), buildar imagem custom com os fixes aplicados, deployar no Medgrupo, validar, e em paralelo submeter cada fix como PR upstream. Quando os PRs mergearem e uma release nova sair, voltar pra imagem oficial.

## Objetivo principal

**Voltar pra 3 réplicas do OneUptime sem race condition, com throughput preservado e zero erros visíveis em logs**, enquanto contribui os fixes de volta pro upstream.

## Objetivos secundários

1. `Monitor.updatedAt` atualizando em real-time (hoje está stale há 3h+)
2. `Generate Postmortem with AI` funcionando (bug do `max_tokens`)
3. Histogram metrics com `explicitBounds` grandes aceitos pelo ClickHouse
4. Primeiro boot pós-wipe não requer mais restart manual (fix do `seed-global-config`)
5. 5 PRs abertos no upstream (um por fix)

## Escopo

### Dentro do escopo
- Fork `OneUptime/oneuptime` sob `nidiodolfini/oneuptime`
- Branch paralelo ao upstream 10.0.55 tag
- Fixes em 5 commits separados (cada um = 1 PR upstream independente)
- Build da imagem OneUptime server + probe (duas imagens)
- Push pro **GHCR** (ghcr.io/nidiodolfini/oneuptime e .../probe) — não no ECR do Medgrupo (evita custo AWS, GHCR é grátis pra repos públicos)
- Atualização do chart em `gitops-plataform/platform/med-uptime/chart/values.yaml` apontando pras imagens custom
- Deploy via ArgoCD, validação end-to-end
- Abrir 5 PRs upstream (um por fix, independentes)

### Fora do escopo
- Features Medgrupo-specific que não têm sentido upstream (nenhuma identificada até agora)
- Refactor estrutural (ex.: reescrever TelemetryQueueService) — só fixes mínimos
- Novos tests (o repo tem tests mas é maior compromise abrir PR com test + fix do que só fix)
- Build multi-arch (só amd64 que é o que roda no Medgrupo)
- Manter a fork sincronizada após os PRs mergearem — se upstream aceitar tudo, voltamos pra imagem oficial e o fork vira arquivo morto

### Bugs FORA do escopo dessa rodada (deixar pra outro momento)
- `TELEMETRY_CONCURRENCY=100` default agressivo — feature gap, não bug crítico, não bloqueia ninguém
- Re-introduzir `LLMCompletionRequest.maxTokens` configurável — é refactor, fix atual resolve

## Bugs a fixar (ordem de prioridade)

### 1. `max_tokens: Field required` (Anthropic completion)
- **Arquivo**: `Common/Server/Utils/LLM/LLMService.ts:157`
- **Fix**: adicionar `max_tokens: 4096` no `requestData` do `getAnthropicCompletion`
- **Impacto**: destravar `Generate Postmortem with AI` + qualquer feature Anthropic
- **Status**: PR #2393 já aberto upstream (+5/-0). Vou copiar o mesmo commit pro fork.
- **Risco**: zero — fix mínimo, impacto isolado

### 2. Probe-ingest `type: undefined` no worker
- **Arquivo**: `App/FeatureSet/Telemetry/Jobs/TelemetryIngest/ProcessTelemetry.ts:154` (sintoma) + `App/FeatureSet/Telemetry/Services/Queue/TelemetryQueueService.ts` (provável causa)
- **Investigação necessária**: 30–60min de code reading. Hipóteses:
  - (a) Bullmq version mismatch entre producer e consumer
  - (b) Segundo producer paralelo enfileirando com schema diferente
  - (c) Deserialização wrapping `data` num objeto que tem outra forma
- **Fix provável**: cast/validação no consumer pra detectar e logar o shape real, depois fix no producer ou consumer
- **Impacto**: restaurar `Monitor.updatedAt` em real-time (hoje stale há 3h+)
- **Risco**: médio — pode requerer leitura profunda do bullmq internals

### 3. Service creation race condition
- **Arquivo**: procurar `TelemetryService.findOrCreate` ou `ServiceService.findOrCreate` (~15min de exploração)
- **Fix**: trocar o flow `SELECT → INSERT → catch exception` por um `INSERT ... ON CONFLICT DO NOTHING` + `SELECT` posterior, ou usar `findOrCreate` transacional do TypeORM
- **Impacto**: **destrava o retorno pra 3 réplicas sem race** — objetivo primário do plano
- **Risco**: médio — precisa cuidar pra não quebrar o caminho de create-new-service legitimo

### 4. `explicitBounds` parse error no ClickHouse
- **Arquivo**: `App/FeatureSet/Telemetry/Services/OtelMetricsIngestService.ts` (provável) — onde histograms são convertidos pra JSONEachRow format
- **Fix**: sanitize `explicitBounds` antes do INSERT (substituir `inf`/`nan`/`1e38+` por valores finitos ou skip do bucket problemático)
- **Impacto**: 170 metrics/5min deixam de ser perdidos
- **Risco**: baixo — fix isolado no formatter

### 5. `seed-global-config` initContainer race
- **Arquivo**: `Chart/` (do upstream) — mover o seed-global-config de initContainer pra Helm hook `post-install,post-upgrade`
- **Nota**: O Medgrupo **NÃO usa** o chart oficial do OneUptime, usa um chart custom em `gitops-plataform/platform/med-uptime/chart/`. Então esse fix vai pro chart do Medgrupo (já no gitops-plataform) E pra PR upstream separado no chart oficial.
- **Impacto**: primeiro boot pós-wipe não precisa de restart manual
- **Risco**: baixo — fix de ordering, no chart

## Fases de execução

### Fase 0 — Preparação (~15min)
1. Criar `tasks/learnings-oneuptime.md` com o histórico completo dos 4 dias (já parcial, consolidar)
2. Validar que as memórias foram salvas (`MEMORY.md` + `project_oneuptime_upstream_bugs.md` + `reference_oneuptime_code_map.md`)
3. Verificar ghcr.io access do user `nidiodolfini` (package write scope)
4. Confirmar espaço em disco local pro build (~5-10GB) e docker daemon rodando

### Fase 1 — Fork + setup do repo (~10min)
1. Já existe: `https://github.com/nidiodolfini/oneuptime` (forkado pro PR #2393)
2. Sincronizar fork com upstream master
3. Checkout da tag `10.0.55` como baseline (OneUptime server rodando no Medgrupo é 10.0.55)
4. Criar branch `medgrupo/10.0.55-fixes` a partir da tag
5. Cherry-pick do commit do PR #2393 (max_tokens) — já está no fork, só trazer pro branch

### Fase 2 — Investigação (~60–90min)
Para cada um dos bugs 2, 3, 4:
1. Ler código relevante no fork local (sem network — clonado na Fase 1)
2. Identificar a fix mínima upstream-compatible
3. Documentar no arquivo `tasks/learnings-oneuptime.md` a raiz de cada bug
4. Confirmar que o fix não quebra feature adjacente

**Abort condition**: se algum bug se provar muito mais complexo que o esperado (>2h sozinho), pular ele nesta rodada e reportar pro user antes de continuar.

### Fase 3 — Fixes em commits separados (~60min)
Um commit por bug, com mensagem no padrão `fix(<area>): <short>` + corpo explicativo (mesmo padrão do PR #2393). Ordem:

1. `fix(llm): send max_tokens on Anthropic completion requests` (já pronto, cherry-pick)
2. `fix(telemetry): probe-ingest jobs losing type field in worker`
3. `fix(telemetry): service creation race via ON CONFLICT DO NOTHING`
4. `fix(telemetry): sanitize explicitBounds before ClickHouse insert`
5. (Chart) `fix(chart): move seed-global-config to post-install helm hook`

Cada commit precisa ser **standalone** (pode ser PR independente) e **upstream-friendly** (segue o style do repo).

### Fase 4 — Build da imagem (~30–45min de wall time)
1. `docker build -f App.Dockerfile -t ghcr.io/nidiodolfini/oneuptime-app:10.0.55-medgrupo.1 .`
2. `docker build -f Probe.Dockerfile -t ghcr.io/nidiodolfini/oneuptime-probe:10.0.55-medgrupo.1 .`
3. Push ambas pro GHCR (autenticado via gh cli)
4. Validar que o pull funciona sem auth (packages públicos)

**Nomeação**:
- Server: `ghcr.io/nidiodolfini/oneuptime-app:10.0.55-medgrupo.1`
- Probe: `ghcr.io/nidiodolfini/oneuptime-probe:10.0.55-medgrupo.1`

Tag semver-ish: `<upstream-version>-medgrupo.<patch>`, onde o patch incrementa a cada nova build com novos fixes.

**Abort condition**: se build falhar, documentar o erro e voltar pro user. Não tentar fixar build broken do OneUptime — é fora do escopo.

### Fase 5 — Deploy no Medgrupo (~15min)
1. Editar `platform/med-uptime/chart/values.yaml`:
   - `oneuptime.image.repository`: `ghcr.io/nidiodolfini/oneuptime-app`
   - `oneuptime.image.tag`: `10.0.55-medgrupo.1`
   - Mesma coisa pras probes (`probes.*.image.*`)
2. `oneuptime.replicas: 3` (volta ao original, objetivo primário do plano!)
3. Commit + push + ArgoCD sync
4. Aguardar rollout completo

### Fase 6 — Validação end-to-end (~30min)
Critérios de sucesso (GO/NO-GO para próxima fase):

**Errors in last 10 minutes** (via `kubectl logs deploy/oneuptime`):
- `Invalid service token`: **0** (já está zerado pelo delete do k8s-agent)
- `Service with the same name already exists`: **0** (fix #3) — **obrigatório**
- `Unknown telemetry type: undefined`: **0** (fix #2) — **obrigatório**
- `Error processing resource (span|metric|log)`: **0 ou <5/10min**

**Throughput** (via ClickHouse query):
- LogItemV2: ≥ 500K rows/60s (baseline atual)
- MetricItemV2: ≥ 10K rows/60s
- SpanItemV2: ≥ 1K rows/60s

**DB state**:
- `Monitor.updatedAt` < agora - 2min (fix #2) — **obrigatório**
- `MonitorProbe.updatedAt` < agora - 2min — confirma que o probe pipeline está atualizando ambas as tables

**UI funcional**:
- Login ok com admin
- Monitor list mostra status "Up" com última verificação recente
- Tentar **Generate Postmortem with AI** num incident real → deve gerar sem erro (fix #1)

**ClickHouse**:
- `Failed parsing explicitBounds` count/5min deve ser **0** (fix #4)
- OR: se ainda tiver erros, deve ser por outro motivo não relacionado a explicitBounds

**Resource usage**:
- CPU total do OneUptime (3 reps) ≤ CPU baseline pre-scale (~5.1 CPU)
- ClickHouse CPU proporcional ao throughput (não deve voltar aos 1.5 CPU antigos)
- Sem pods em CrashLoopBackOff ou restarts por OOM

**Abort condition**: se qualquer um dos critérios OBRIGATÓRIOS falhar, voltar pra imagem oficial + 2 réplicas (estado pré-fork). Documentar o motivo no `tasks/learnings-oneuptime.md`.

### Fase 7 — PRs upstream (~30–45min)
1. Sincronizar cada commit individualmente com `master` do upstream (rebase ou cherry-pick)
2. Abrir 5 PRs separados, cada um referencing o fix específico
3. PR bodies seguem o padrão do #2393: Summary + Root cause + Change + Test plan
4. **Não** cross-reference entre os PRs (cada um standalone)
5. Adicionar link dos PRs no `project_oneuptime_upstream_bugs.md`

### Fase 8 — Documentação + cleanup (~15min)
1. Atualizar `MEMORY.md` com os PR numbers
2. Atualizar `CLAUDE.local.md` do gitops-plataform com o estado "rodando imagem fork"
3. Criar task follow-up: "monitorar merges dos PRs upstream; quando todos mergearem em release nova, voltar `values.yaml` pra imagem oficial"

## Riscos e mitigações

| # | Risco | Prob | Impacto | Mitigação |
|---|---|---|---|---|
| 1 | Bug do `probe-ingest` é complexo e consome >2h sem solução | 30% | Alto | Pular pra próximos bugs, voltar depois. Ou reportar issue sem fix se a raiz for muito profunda. |
| 2 | Fix do Service race quebra fluxo legítimo de criação de service novo | 15% | Alto | Validação end-to-end na Fase 6 + abort clause |
| 3 | Build da imagem OneUptime falha localmente (memória insuficiente, deps corrompidas) | 20% | Médio | Usar GitHub Actions do fork em vez de build local (+30min de setup do workflow) |
| 4 | Push pro GHCR bloqueado por falta de permission no token | 10% | Baixo | Já temos `gh auth` com scope `repo` e `gist`. Scope `write:packages` pode precisar ser adicionado manualmente pelo user. Verificar na Fase 0. |
| 5 | Imagem fork roda no Medgrupo mas tem regressão silenciosa (bug novo introduzido pelos fixes) | 15% | Alto | Validação profunda na Fase 6 + metrics comparison + rollback em <5min |
| 6 | Upstream rejeita os PRs por desacordo com a abordagem | 25% | Baixo | Fix local do Medgrupo funciona independente. PRs são side benefit |
| 7 | OneUptime faz release nova (10.0.56+) durante o trabalho | 20% | Baixo | Fork é baseado em tag, não branch — imagem continua estável. Sincronizar depois |

## Rollback completo

Se algo der muito errado na Fase 6 e precisar reverter:

```bash
# 1. Revert o values.yaml
cd gitops-plataform
git revert <commit-fork-deploy>
git push origin main

# 2. Forçar sync do ArgoCD
kubectl --context=Management-0226 -n argocd patch app med-uptime \
  --type merge -p '{"operation":{"sync":{}}}'

# 3. OneUptime volta pra imagem oficial em ~3min
# 4. Estado final: igual ao pré-Fase 5 (2 réplicas, imagem ghcr.io/oneuptime/app:10.0.55)
```

## O que NÃO fazer

- Não tentar fixar bugs fora do catálogo do `project_oneuptime_upstream_bugs.md` nesta rodada
- Não introduzir features Medgrupo-specific (viola escopo "upstream-compatible")
- Não mexer no chart oficial do OneUptime upstream (só no chart custom do Medgrupo) — chart oficial fica num PR separado
- Não pushar imagens sem tag versionada (sem `latest`)
- Não fazer force-push no branch do fork depois de abrir PRs (respeitar commits publicados)

## Checklist pré-execução (user precisa confirmar)

- [ ] Acesso gh CLI com scope `write:packages` habilitado (pra push no ghcr.io)
- [ ] Docker Desktop rodando e com ≥8GB RAM alocados
- [ ] ≥10GB livres em disco pro build
- [ ] OK com imagem custom em ghcr.io público (não privado) — é mais simples e grátis
- [ ] OK com 4–6h de trabalho ativo nesta empreitada antes da validação end-to-end
- [ ] Aceita abort clause se fix do bug #2 (probe-ingest type undefined) se provar muito complexo (>2h)
- [ ] OK com operação continuar em 2 réplicas + race condition residual se o plano abortar

## Critério de sucesso do plano

**Mínimo aceitável**: OneUptime rodando 3 réplicas com 0 race condition de Service + 0 `Unknown telemetry type` + `Monitor.updatedAt` atualizando real-time. Bugs #4 e #5 podem ficar pra próxima rodada se muito complexos.

**Ideal**: os 5 fixes deployados, 5 PRs abertos upstream, e a fork bem documentada pra futura recorrência.
