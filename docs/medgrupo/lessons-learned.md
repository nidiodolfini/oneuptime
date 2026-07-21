# Learnings OneUptime — consolidation 2026-04-11

Documento vivo consolidando tudo que foi aprendido sobre o OneUptime 10.x durante a operação do med-uptime no Medgrupo. Serve de input pra plano de fork + fixes upstream.

## Timeline de alto nível

- **2026-04-05** — `oneuptime-k8s-agent` instalado manualmente via Helm por alguém (chart v10.0.45) no EKS-Prod-0326. Não entrou em GitOps. Ficou orphan com token antigo `60a10a7b-3d3b-4832-8e5d-6b970651de57`.
- **2026-04-09 14:43 UTC** — DB do OneUptime zerado por causa desconhecida. Schema (277 migrations) e `GlobalConfig` (1 row) sobreviveram; User/Project/Probe/Monitor/Incident todos em 0. Pipeline de incident management parou de funcionar.
- **2026-04-11** — Rebuild completo decidido. Stack reescrita com Redis in-cluster (elimina CROSSSLOT do Valkey), upgrade pra OneUptime 10.0.55 + HolmesGPT 0.24.3 + ClickHouse 25.3, script Python de bootstrap via API. Rebuild bem-sucedido, estado determinístico.
- **2026-04-11 (mesmo dia)** — Operação pós-rebuild expõe vários bugs upstream acumulados. Começo da investigação desses bugs.

## Bugs upstream identificados

### Bug #1: Anthropic `max_tokens: Field required`

**Sintoma**: `Generate Postmortem with AI` na UI do OneUptime retorna:
```
Error - Anthropic API error: {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}
```

**Investigação**: Li o arquivo `Common/Server/Utils/LLM/LLMService.ts` no upstream via `gh api`. A função `getAnthropicCompletion` constrói o request body assim:
```typescript
const requestData: JSONObject = {
  model: modelName,
  messages: userMessages,
  temperature: request.temperature ?? 0.7,
};
```
Sem `max_tokens`. A Anthropic Messages API requer esse campo (diferente da OpenAI API).

**Raiz**: Regression entre 3 commits no mesmo dia 2025-12-16:
- 11:21 `5eca1a5` Remove maxTokens from LLMCompletionRequest
- 15:33 `bdd894f` Add maxTokens parameter (someone noticed)
- 15:39 `8d79a38` Remove maxTokens (remove again, 6min later)

Alguém removeu, outro devolveu, removeram de novo. Desde então todas as releases têm o bug.

**Fix**: adicionar `max_tokens: 4096` no `requestData`. 4096 é safe pra todos os modelos Claude atuais.

**Status**: PR **OneUptime/oneuptime#2393** aberto (mergeable, +5/-0), aguardando review.

**Impacto**: OpenAI e Ollama não afetados.

---

### Bug #2: Probe-ingest jobs chegam com `type: undefined` no worker

**Sintoma**: Logs do OneUptime server spam:
```
Error processing telemetry job:
Error: Unknown telemetry type: undefined
    at Worker.QueueWorker_1.default.getWorker.concurrency [as processFn]
       (/usr/src/app/FeatureSet/Telemetry/Jobs/TelemetryIngest/ProcessTelemetry.ts:154:17)
```
Volume: ~50/min em 3 réplicas, ~420/min em 1 réplica.

**Investigação**:
1. Inspecionei o Redis queue direto: `kubectl exec sts/redis -- redis-cli HGET "bull:Telemetry:probe-probe-response-general-<timestamp>" data`
2. Retornou: `{"type":"probe-ingest","ingestionTimestamp":"...","probeIngest":{...}}`
3. **O JSON tem `type: "probe-ingest"` corretamente**.
4. O enum em `TelemetryQueueService.ts` (tag 10.0.55) define `ProbeIngest = "probe-ingest"` — match exato.
5. O `ProcessTelemetry.ts` no 10.0.55 TEM case pra `TelemetryType.ProbeIngest`.

Então: JSON ok no Redis, enum ok no código, case ok no switch... mas no runtime `jobData.type === undefined`. **Inconsistência**.

**Hipóteses a verificar no fork**:
- (a) Bullmq version mismatch (package.json pin): producer enfileira serializado de um jeito, consumer deserialize de outro
- (b) `job.data` é `undefined` inteiro (não só `.type`) — o cast `as TelemetryIngestJobData` mascara isso em tempo de compilação
- (c) Há um segundo producer paralelo (ex.: legacy endpoint) enfileirando jobs numa estrutura diferente
- (d) Race de deserialização entre múltiplos workers concorrentes do mesmo processo (por isso piora com 1 réplica + 100 concurrent)

**Descoberta adicional**: `MonitorProbe.updatedAt` continua sendo atualizada (parcialmente) mas `Monitor.updatedAt` fica stale há 3h+. Só uma fração das jobs probe-ingest falha. Os monitors visíveis (`site Medgrupo`, `SQL Server Desenv`) estão com último `updatedAt` de 2026-04-11 17:48 e 18:07 UTC respectivamente — ~3h45m atrás.

**Fix candidato** (precisa confirmar no fork): adicionar log do `typeof jobData` + `JSON.stringify(jobData).length` no início do handler pra diagnosticar. Se jobData for string, parsear. Se for object wrapped, desembrulhar.

**Status**: **não investigado profundamente**, precisa fork + code reading. É o bug mais crítico do lote.

---

### Bug #3: Service creation race condition

**Sintoma**:
```
Error: Failed to create or find service: Service-Acesso
BadDataException [Error]: Service with the same name already exists.
Error processing resource span:
Error: Failed to create or find service: Service-Acesso
```
Volume: 251/10min com 3 réplicas (~25/min). Afeta spans, metrics e logs.

**Raiz**: N réplicas recebem OTLP do mesmo `service.name` novo simultaneamente. Cada réplica faz:
```
SELECT * FROM Service WHERE name='X' AND projectId=...
-- vazio
INSERT INTO Service (name, ...) VALUES ('X', ...)
-- primeira ganha, restantes recebem unique constraint violation
```
O handler trata a exception como `BadDataException` e **descarta o batch inteiro** do OTLP (não só a linha problemática). Isso significa ~207 spans/10min + 44 metrics/10min perdidos.

**Por que scale 3→1 melhorou mas não zerou**: Mesmo com 1 réplica, o `TELEMETRY_CONCURRENCY=100` faz 100 workers do bullmq rodarem concorrentes no mesmo processo, disputando o estado. O race diminui mas não desaparece. Com 2 réplicas ficou em 2/min (bem baixo mas não zero).

**Fix candidato**: trocar `SELECT → INSERT → catch exception` por:
- Option A: `INSERT ... ON CONFLICT DO NOTHING RETURNING id` + fallback SELECT
- Option B: `findOrCreate` atômico via TypeORM (se suportado)
- Option C: advisory lock no Postgres no nome do service durante create (overkill)

Preferência: Option A — SQL standard, simples, atomic.

**Status**: não fixed ainda. Precisa localizar o handler no fork (~15min de exploração).

---

### Bug #4: ClickHouse `explicitBounds` parse error

**Sintoma**:
```
<Error> AsynchronousInsertQueue: Failed parsing for query
'INSERT INTO oneuptime.MetricItemV2 (...) FORMAT JSONEachRow'.
DB::Exception: Cannot read array from text, expected comma or end of array,
found 'e': (while reading the value of key explicitBounds)
```
Volume: 170/5min. Afeta histograms OTLP.

**Raiz**: Histograms OTLP podem ter `explicitBounds` com valores não-finitos (`+Inf`, `-Inf`, `NaN`, ou notação científica grande como `1e38`). Quando o OneUptime serializa isso pro JSONEachRow do ClickHouse, o parser JSON do ClickHouse recusa esses valores. Batch inteiro rejeitado.

**Fix candidato**: sanitize no `OtelMetricsIngestService.ts` (provável local) antes do INSERT:
```typescript
bounds.map(b => {
  if (!isFinite(b)) return null; // ou um sentinel value
  if (Math.abs(b) > 1e15) return 1e15 * Math.sign(b); // cap
  return b;
})
```

**Status**: não fixed. Precisa localizar o formatter no fork.

**Note**: Baixo impacto prático — só afeta um subset de histograms específicos. Counters, gauges e a maioria dos histograms funcionam OK.

---

### Bug #5: `seed-global-config` initContainer race

**Sintoma**: Primeiro deploy pós-wipe do schema, UI do OneUptime não abre. Pod `oneuptime` sobe e parece saudável mas a row `GlobalConfig` está vazia. Workaround manual: `kubectl rollout restart deploy/oneuptime` depois que as migrations terminam.

**Raiz**: O initContainer `seed-global-config` checa se a tabela `GlobalConfig` existe:
- Se existe: faz `INSERT IF NOT EXISTS` da row default
- Se não existe: **skip** (o script falha silenciosamente)

Mas no primeiro boot pós-wipe, a tabela `GlobalConfig` ainda **não existe** — ela é criada pelas migrations, que rodam no container principal (não no initContainer). Então:
1. InitContainer roda primeiro, tabela não existe → skip
2. Container principal roda, migrations rodam, tabela criada (vazia)
3. Container principal espera a `GlobalConfig` row inicial, não encontra, UI quebra

Workaround: rollout restart → segunda instância do Pod → initContainer roda de novo, agora a tabela existe → seed insere a row → UI funciona.

**Fix estrutural**: mover o `seed-global-config` de initContainer pra Helm hook `post-install,post-upgrade` que roda **depois** das migrations completarem. Hook garante ordenação: main container sobe + migrations rodam + hook dispara + seed funciona.

**Status**: workaround manual aplicado no rebuild. Fix estrutural pendente — afeta o chart (oficial + custom do Medgrupo).

---

## Feature gaps (não bugs, mas melhorias upstream)

### Gap A: `TELEMETRY_CONCURRENCY=100` default muito agressivo

- Default em `App/FeatureSet/Telemetry/Config.ts`: 100 concurrent workers por processo
- Com 100 workers, a race condition de Service creation acontece mesmo em 1 réplica
- Default mais razoável: 10-20
- Low effort PR: trocar `|| 100` por `|| 20` no parse

### Gap B: `max_tokens` não é caller-configurable no LLMService

- O PR #2393 hardcoda 4096
- Ideal: re-introduzir `LLMCompletionRequest.maxTokens?: number` opcional (reverter parcialmente o refactor que causou o bug #1)
- Permite que diferentes callers (postmortem vs chat vs investigation) peçam diferentes limits
- Escopo maior, ficar pra PR separado depois do #2393 mergear

---

## Aprendizados operacionais (não são bugs)

### 1. HashedString serialization

Senhas e outros hashed fields no OneUptime usam um wrapper TypeScript:
```typescript
class HashedString {
  value: string;  // SHA256(encryption_secret + plaintext) hex 64 chars
}
```
No JSON de API e queue jobs, aparece como:
```json
{"_type": "HashedString", "value": "abc123..."}
```

Ao fazer bootstrap via API (criar User, Project, etc), senhas precisam vir nesse formato — não pode mandar string raw. Hash = `crypto.createHash('sha256').update(encryption_secret + plaintext).digest('hex')`.

### 2. ObjectID serialization

UUIDs em queue jobs e API:
```json
{"_type": "ObjectID", "value": "933778d7-66a2-4e4b-bdfc-35220c4ce4d6"}
```

### 3. Admin user não é auto-criado

Fresh install não cria admin user. Ou via seed, ou manual. No Medgrupo fizemos INSERT direto no Postgres (user `nidio.dolfini@terceirizados.medgrupo.com.br`, `isMasterAdmin=true`, password hash computado).

### 4. Redis precisa ser standalone, não cluster

OneUptime 10.x usa pipelines multi-key sem hash tags. Roda num Valkey Serverless AWS (cluster mode) dá erro constante:
```
ReplyError: CROSSSLOT Keys in request don't hash to the same slot
```
Fix: Redis 7.x standalone. No Medgrupo fizemos isso no rebuild — StatefulSet Redis 7.4-alpine 1 replica PVC 10Gi gp3.

### 5. `TELEMETRY_CONCURRENCY` é por processo, não por réplica

Confusão comum: scale vertical do número de réplicas não diminui concorrência se o worker concurrency é alta. 3 réplicas × 100 workers = 300 concurrent = race alto. 1 réplica × 100 workers = 100 concurrent = race médio. 1 réplica × 10 workers = 10 concurrent = race baixo.

### 6. FK lookup precisa acontecer antes de POST /incident

Ao criar Incident via API, o body precisa dos FKs como ObjectIDs:
- `incidentSeverityId`
- `currentIncidentStateId`
- `projectId`
- etc

Se não passar, retorna `null value in column ...` (NOT NULL constraint). Solução: antes de criar o incident, fazer `GET /incident-severity` e `GET /incident-state` pro project e cache local dos IDs.

---

## Histórico de workarounds aplicados no Medgrupo

| Data | Issue | Workaround | Status |
|---|---|---|---|
| 2026-04-11 | 947 `Invalid service token`/10min | Delete do `oneuptime-k8s-agent` orphan + namespace | ✅ zerou |
| 2026-04-11 | Robusta forwarder OOMKilled | Bump limit 512Mi→1Gi (key `kubewatch` do chart) | ✅ sem OOM |
| 2026-04-11 | 3 namespaces `robusta` vazios + 4 Apps órfãs | Fix do ApplicationSet (remove robusta de devops/homol, noop fallback pra medsoft-prod) + delete manual dos ns | ✅ limpo |
| 2026-04-11 | Service creation race (251/10min) | Scale 3→1 replica → bug novo "Unknown telemetry type" em rate alto → Scale 1→2 replica (meio-termo) | ⚠️ paliativo, precisa fix raiz |
| 2026-04-11 | `Monitor.updatedAt` stale 3h+ | Nenhum — consequência do bug #2 acima | ⏳ aguardando fix |

## Referências

- Upstream repo: https://github.com/OneUptime/oneuptime
- CONTRIBUTING: https://github.com/OneUptime/oneuptime/blob/master/CONTRIBUTING.md
- Maintainer principal: `@simlarsen`
- License: Apache 2.0
- Forkado como: https://github.com/nidiodolfini/oneuptime
- PR #2393 (max_tokens fix): https://github.com/OneUptime/oneuptime/pull/2393
- Tag em uso no Medgrupo: `10.0.55`

---

## Lições meta

1. **Race conditions escondidas não são visíveis até o volume aumentar**. O `Service with same name` spam ficou ~1 mês coexistindo em baixo volume antes do rebuild — foi só quando o OTLP do EKS-Prod-0326 começou a mandar volume de 11.6M rows/min que ficou visível.

2. **Workarounds imediatos expõem bugs menores**. Scale down de 3→1 réplica (workaround pro bug #3) **expôs** o bug #2 (Unknown telemetry type) que tava lá mas em volume baixo. Cada fix pode revelar o próximo gargalo.

3. **Monitorar `MonitorProbe.updatedAt` + `Monitor.updatedAt`** como proxy do health do probe pipeline — se divergem por mais de 5min, tem algo quebrado entre as tables.

4. **`TELEMETRY_CONCURRENCY` deveria ser ajustado para 10-20 em qualquer deploy do OneUptime**. Default de 100 é muito agressivo pra tudo que já vi.

5. **Sempre validar `createdAt` vs `time` em queries ClickHouse de throughput**. `time` é o timestamp do evento (pode ter skew de minutos), `createdAt` é quando foi inserido no DB. Pra medir throughput em tempo real, usar `createdAt`.

---

## Raízes confirmadas dos bugs (investigação do fork — 2026-04-11 segunda leva)

Depois de criar o fork `nidiodolfini/oneuptime`, branch `medgrupo/10.0.55-fixes` a partir da tag `10.0.55`, e ler o código:

### Bug #2 (probe-ingest type undefined) — raiz: BullMQ stalled-job recovery × removeOnComplete cleanup

O código upstream do switch em `ProcessTelemetry.ts` está correto — `TelemetryType.ProbeIngest === "probe-ingest"` bate com o que o producer enfileira. O erro vem do BullMQ **em runtime**:

1. Job A está active, worker 1 processa
2. Worker 1 event loop bloqueia > `lockDuration` (default 30s)
3. Stalled-check move A de volta pra wait
4. Worker 2 pega A da wait, processa com sucesso → `removeOnComplete: {count: 500}` rotaciona o hash e strippa `data` do registro
5. Worker 1 recupera e re-vê A como active na própria memória local, hidrata → `job.data` vira `{}` (hash sem `data` field)
6. `jobData.type === undefined` → default → throw

**Evidência**: `bull:Telemetry:stalled` tinha 12 entries no Medgrupo no momento da investigação, todos `logs-*` ou `metrics-*` (nunca `probe-*` — isso me confundiu inicialmente porque assumi que eram probe jobs). Os hashes dos IDs no `failed` sorted set (5909 entries) só tinham bookkeeping keys (`atm`, `stc`, `processedOn`, `finishedOn`, `failedReason`, `stacktrace`) sem `data`/`opts`/`name`.

**Fix A** (`ProcessTelemetry.ts`): guard defensivo antes do switch:
```typescript
if (!jobData || typeof jobData !== "object"
    || Object.keys(jobData as object).length === 0 || !jobData.type) {
  logger.debug(`Skipping telemetry job ${job.id}: orphan`);
  return;
}
```

**Fix B** (`Queue.addJob`): remover o `getJob + remove` preamble não-atômico. O intent era "force-replace" jobs com mesmo ID, mas o fluxo:
1. `getJob(id)` retorna job existente
2. `job.remove()` limpa
3. `queue.add(id, data)` adiciona novo

Entre (2) e (3) outro producer pode adicionar o mesmo ID com data diferente. Pior: se (2) roda sobre um job no failed state com hash já strippado (por `removeOnFail` rotation), a limpeza é parcial e cria o estado órfão que o bug #2 vê. BullMQ já deduplica por jobId nativamente — o preamble é pura source de race.

### Bug #3 (Service race) — raiz: mismatch case-insensitive vs exact-match

O `DatabaseService.checkUniqueColumnBy` (pre-create hook) usa `QueryHelper.findWithSameText` que faz `LOWER(name) = LOWER(?)` com `.trim()`. O handler `OpenTelemetryIngestService.telemetryServiceFromName` fazia o initial lookup E o re-fetch pós-conflict com match EXATO (`name: data.serviceName`).

Flow do race:
1. Worker A recebe OTLP com `service.name = "Service-Acesso"`, `findOneBy` exato retorna null
2. Worker B recebe OTLP com `service.name = "service-acesso"` simultaneamente, `findOneBy` exato retorna null (case diferente, match exato não acha)
3. Worker A chama `ServiceService.create` — `checkUniqueColumnBy` via LOWER não acha (ainda não tem nada no DB) — commit com "Service-Acesso"
4. Worker B chama `ServiceService.create` — `checkUniqueColumnBy` via LOWER **acha** o "Service-Acesso" de Worker A — throw `BadDataException("Service with the same name already exists")`
5. Worker B entra no catch, re-fetch com match exato em "service-acesso" — não acha porque o que existe é "Service-Acesso"
6. Throw `Failed to create or find service: service-acesso`

**Fix**: Usar `QueryHelper.findWithSameText` nos 2 lookups (inicial + re-fetch) + retry loop de 5 tentativas com backoff (25/50/75/100/125ms ~ 375ms total) para cobrir o commit-propagation window curto.

### Bug #4 (explicitBounds) — raiz: `parseFloat("Infinity")` não é NaN

Classic JS footgun no `OtelMetricsIngestService.toNumberOrNull`:

```typescript
if (typeof value === "number") {
  return Number.isFinite(value) ? value : null;  // filtra Infinity ✓
}
if (typeof value === "string") {
  const parsed = Number.parseFloat(value);
  return isNaN(parsed) ? null : parsed;  // ❌ aceita Infinity!
}
```

`Number.parseFloat("Infinity")` retorna `Infinity`. `isNaN(Infinity)` retorna `false`. Então `toNumberOrNull("Infinity") === Infinity` passa pelo filtro. O valor vai pro ClickHouse como `Infinity` no JSONEachRow format → rejeita com `Cannot read array from text`.

OTLP histograms mandam `"Infinity"` como string no campo final do `explicitBounds` quando o bucket final é unbounded. Spec-compliant behavior.

**Fix**: trocar `!isNaN(parsed)` por `Number.isFinite(parsed)`. Rejeita NaN AND ±Infinity. Uma linha alterada. **Cascata**: afeta todos os campos numéricos que passam pelo `toNumberOrNull` — `count`, `sum`, `min`, `max`, `bucketCounts`, `explicitBounds`, `valueFromInt`, `valueFromDouble`.

### Dead code encontrado

`Common/Server/Services/OpenTelemetryIngestService.getMetricFromDatapoint` (linha 137–228) nunca é chamado de lugar nenhum no repo. É dead code com o mesmo padrão não-sanitized de `explicitBounds`. Não foi tocado no fix pra manter scope mínimo.

---

## Gotchas do build local

### `Dockerfile.tpl` é template, não Dockerfile

`npm run prerun` chama `configure.sh` que usa **gomplate** (v3.11.8) pra renderizar `Dockerfile.tpl` → `Dockerfile` em todos os serviços (`App/`, `Probe/`, `Nginx/`, etc). Templates usam Go-style `{{ if eq .Env.ENVIRONMENT "development" }}`.

Workaround sem instalar gomplate:
```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(cygpath -w /path/to/repo):/work" -w "/work" \
  -e ENVIRONMENT=production \
  hairyhenderson/gomplate:stable \
  --file App/Dockerfile.tpl --out App/Dockerfile
```

(`MSYS_NO_PATHCONV=1` é essencial no Git Bash/Windows pra evitar path translation bagunçando o `-w /work`.)

### Docker login no ghcr.io funciona com scope `repo`

Não precisei adicionar `write:packages` ao `gh auth`. O scope `repo` (combinado com a identidade do usuário GitHub) é suficiente pra `docker login ghcr.io` + push em repos pessoais. Isso economiza um `gh auth refresh` interativo.

```bash
gh auth token | docker login ghcr.io -u <username> --password-stdin
```

### Tag recipe

Decidi usar `<upstream-version>-medgrupo.<patch>` como convenção. Exemplo atual: `10.0.55-medgrupo.1`. Cada rebuild com novos fixes ou cherry-picks incrementa o patch.

```
ghcr.io/nidiodolfini/oneuptime-app:10.0.55-medgrupo.1
ghcr.io/nidiodolfini/oneuptime-probe:10.0.55-medgrupo.1
```

### Windows CRLF breaks docker build do OneUptime

Checkout default do Git no Windows usa `core.autocrlf=true`, que converte LF→CRLF nos arquivos texto (incluindo shell scripts). O container Linux dos builds do OneUptime tenta rodar esses scripts via bash e falha com:

```
./scripts/frontend-run.sh: line 2: $'\r': command not found
./scripts/frontend-run.sh: line 3: set: pipefail: invalid option name
```

Fix antes do primeiro build:
```bash
cd /tmp/oneuptime-fix
git config core.autocrlf false
git rm --cached -rq .
git reset --hard HEAD
# Depois re-renderizar os Dockerfiles (foram wiped pelo reset)
```

Após isso, **os Dockerfiles gerados pelo gomplate também são perdidos no reset**, então precisa re-rodar o gomplate depois.

### Timing observado

Numa máquina com Docker Desktop 16GB RAM, 22 CPUs (Windows):
- **Probe build**: ~5min (mais leve, baixa Chromium headless via `@playwright/browser-chromium`)
- **App build**: ~15-25min. `npm install` ~10min, `build-frontends:prod` ~5-10min (webpack bundling de 5 frontends: accounts/dashboard/admin-dashboard/status-page/public-dashboard), `compile` TypeScript ~2min, exporting layers ~2-3min

Rodando os 2 em paralelo economiza ~5min porque o Probe termina primeiro e libera CPU/IO pro App finalizar.

### GHCR packages precisam ser public pra ArgoCD pullar sem credential

Quando o user (`nidiodolfini`) pushed as imagens pro GHCR, elas ficam **private por default**. O ArgoCD no Management-0226 tentaria pullar e falhar com auth error.

A GitHub API NÃO expõe endpoint pra mudar visibility de user packages programaticamente — só org packages. Pra user packages, precisa ir na UI:

```
https://github.com/users/<username>/packages/container/<package-name>/settings
```

Scroll até "Danger Zone" → "Change visibility" → Public → confirma digitando o nome do package.

Fazer isso nos 2 packages (`oneuptime-app` e `oneuptime-probe`) antes de deployar o chart que aponta pra eles.

### Scope gh CLI pra docker push no GHCR

O scope `repo` **não é** suficiente pra `docker push ghcr.io/...`. Embora `docker login` funcione com `gh auth token`, o push retorna:

```
error from registry: permission_denied: The token provided does not match expected scopes.
```

**Fix 1 (preferido)**: `gh auth refresh -s write:packages,read:packages --hostname github.com` — abre browser pra re-auth com escopos novos.

**Fix 2 (alternativa)**: criar um PAT clássico em `https://github.com/settings/tokens/new` com scope `write:packages`, depois `echo <PAT> | docker login ghcr.io -u <user> --password-stdin`. Mais rápido (nenhum browser dance), mas cria um PAT que precisa ser revogado depois de usar.

---

## Estado pós-deploy do fork (2026-04-11 noite)

Imagens pushed:
- `ghcr.io/nidiodolfini/oneuptime-app:10.0.55-medgrupo.1` (849MB compressed, public)
- `ghcr.io/nidiodolfini/oneuptime-probe:10.0.55-medgrupo.1` (2GB compressed, public)

Chart `platform/med-uptime/chart/values.yaml` aponta pra elas (commit `5e8f31e`).

ArgoCD rolled out em 3 réplicas via rolling update (`maxUnavailable: 0, maxSurge: 1`). Imagem puxada via anonymous pull (sem imagePullSecret).

**Métricas pós-deploy** (medidas 2026-04-11 ~21:00 UTC, janela 2 minutos steady state):

| Métrica | Pre-fix (3 reps) | Pós-fix (3 reps) | Delta |
|---|---|---|---|
| `Invalid service token`/min | ~95 | 0 | ✅ −100% |
| `Service with same name`/min | ~25 | 0 | ✅ −100% |
| `Unknown telemetry type`/min | ~50 | 0 | ✅ −100% |
| `Failed to create or find`/min | várias | 0 | ✅ −100% |
| LogItemV2 throughput | ~553K/60s | **612K/60s** | ✅ +10% |
| MetricItemV2 throughput | ~36K/60s | **64K/60s** | ✅ +78% |
| SpanItemV2 throughput | ~7K/60s | **12K/60s** | ✅ +75% |
| CPU total OneUptime | ~5.17 CPU | **2.91 CPU** | ✅ −44% |
| CPU ClickHouse | ~1.55 CPU | ~0.53 CPU | ✅ −66% |
| MonitorProbe freshness | N/A | **<20s** | ✅ |
| `explicitBounds` CH parse errors/5min | ~170 | ~211 | ⚠️ similar |

**bullmq Telemetry queue state pós-deploy**:
- wait: **0** (baseline tinha ~1085 em backlog)
- active: 7
- stalled: **1** (baseline tinha 12)
- failed: 0 (após limpeza manual do residual de 7903)

**Observações importantes**:

1. **Monitor.updatedAt continua "stale" mas NÃO É BUG** — só atualiza quando há mudança de status (Up→Down), não em cada probe response. Usar `MonitorProbe.updatedAt` como proxy de health do probe pipeline (está em <20s, confirmando pipeline 100% funcional).

2. **explicitBounds parse error NÃO foi 100% resolvido** — fix cobre o branch `string` do `toNumberOrNull` mas o erro real continua ~211/5min. Não conseguimos reproduzir em teste isolado do ClickHouse (`echo '{"bounds":[0.5,1e38,2]}' | clickhouse-client INSERT FORMAT JSONEachRow` aceita). Teoria: outro codepath escreve `explicitBounds` sem passar pelo `toNumberOrNull` — talvez quando OTLP vem via gRPC e chega como JS number nativo. Investigação profunda requer adicionar logging ao serializer e rebuild/deploy outro ciclo. **Follow-up no tasks/todo.md**.

3. **CPU caiu 44%** porque pre-fix o OneUptime queimava CPU reprocessing batches que falhavam na race condition. Cada batch falhado era retry × N workers × N réplicas. Pós-fix todos passam de primeira.

## PRs upstream abertos

- **[OneUptime/oneuptime#2393](https://github.com/OneUptime/oneuptime/pull/2393)** — `fix(llm): send max_tokens on Anthropic completion requests`
- **[OneUptime/oneuptime#2394](https://github.com/OneUptime/oneuptime/pull/2394)** — `fix(telemetry): skip stalled-job orphans instead of throwing`
- **[OneUptime/oneuptime#2395](https://github.com/OneUptime/oneuptime/pull/2395)** — `fix(queue): drop non-atomic getJob+remove preamble from addJob`
- **[OneUptime/oneuptime#2396](https://github.com/OneUptime/oneuptime/pull/2396)** — `fix(telemetry): make service find/create race-safe with case-insensitive retry`
- **[OneUptime/oneuptime#2397](https://github.com/OneUptime/oneuptime/pull/2397)** — `fix(metrics): drop non-finite numeric values when parsing OTLP strings`

Quando todos merged + release nova disponível, voltar `values.yaml` pra imagem oficial `ghcr.io/oneuptime/app:10.0.5X`.

---

## 2026-07-07 — Slack section block >3000 chars: mensagens somem silenciosamente (`invalid_blocks`)

**Sintoma em produção (Medgrupo)**: mensagens "Incident Created" (as únicas com os action buttons) e os espelhos de private notes de ~3000 chars pararam de aparecer no Slack; state-changed e notas curtas continuavam chegando. Incidents INC-459/460 (description 3361 chars, enrichment do Robusta) vs INC-457 (267 chars) provaram a correlação com tamanho.

**Causa raiz**: `IncidentService.createIncidentFeedAsync` embute a description crua no markdown do feed; `WorkspaceUtil.getMessageBlocksByMarkdown` gerava UM `WorkspacePayloadMarkdown` sem split e `SlackUtil.getMarkdownBlock` não trunca. O Slack rejeita section block com text >3000 chars: HTTP **200** com `ok:false, error:"invalid_blocks"` → sem retry do axios (`API.post` só re-tenta em throw); o catch por canal em `SlackUtil.sendMessage` faz `logger.error` e descarta. `WorkspaceNotificationLog` só grava sucesso — falha não deixa rastro no DB.

**Fix (tag `11.0.3-medgrupo.2`)**:
- `1a35268a18` — split em chunks ≤2800 no `getMessageBlocksByMarkdown` (fronteira de parágrafo; botões via `appendMessageBlocks` seguem na mesma mensagem; batching de 50 blocks já existia) + truncamento defensivo a 3000 no `getMarkdownBlock` (cobre call-sites que montam payload direto). **Upstream-worthy** — draft em `upstream-prs-draft.md`.
- `4112e03221` — suprime a workspace notification da entrada de timeline do estado INICIAL (`isCreatedState`): toda criação gerava um "Changed State to Identificado" redundante logo após o "Incident Created". Coerente com `11f7d339d9` (suppress manual actions). Feed in-app continua registrando; Resolvido/Reconhecido seguem notificando. **Patch local Medgrupo** (comportamento opinativo, não candidato a upstream sem feature flag).

**Como diagnosticar de fora**: comparar `descLen` dos incidents via API (`POST /api/incident/get-list`, select `description`) entre um que postou e um que não postou; logs do deployment `oneuptime` com `grep -iE "invalid_blocks|Error from Slack|Error sending message to channel"` (atenção: o ruído de telemetria/ClickHouse afoga o grep — filtrar antes).

### Adendo tag `.3` (2026-07-07, tarde) — notas internas sem espelho no Slack

Decisão de UX pós-validação: com os botões de volta, o espelho "posted private note" duplicava a análise no canal (ela já vai inline na msg técnica do Robusta e vive no Incident). Patch: `IncidentInternalNoteService` com `sendWorkspaceNotification: false` na criação E atualização de private notes (TODAS — bot e humanas, decisão Sir Nídio). Canal fica: Robusta técnico + Incident Created (botões) + mudanças de estado. Public notes (status page) intocadas. Patch local Medgrupo (opinativo; upstream precisaria de flag por projeto). Complemento no bridge (gitops): fatiamento (parte i/N) revertido para nota única — sem espelho, o limite de 3000/section não se aplica a notas; o split/truncate do fork (tag .2) segue protegendo o resto.

---

## 2026-07-21 — tag `.7`: família Alert ganha as supressões de Slack + reconciliação da linhagem

**Contexto (ADR 0027 do robusta-holmes)**: o tier warning virou OneUptime **Alert** (bridge F2/F3) e o shadow no `#devops-alerts` mostrou que a família Alert NÃO tinha os patches da família Incident: toda criação postava um "Changed State to ..." redundante (equivalente ao `.2`) e as notas de dedup "+1 ocorrencia" espelhavam no canal (equivalente ao `.3`). Pré-req do cutover F4 (Robusta deixa de postar warning; canal fica só com o Alert do OneUptime).

**Patches (espelhos exatos dos de Incident)**:
- `AlertStateTimelineService.ts` — `isInitialState = Boolean(alertState?.isCreatedState)` → `sendWorkspaceNotification: !isInitialState`. O "🚨 Alert Created" (`AlertService.ts`) já inclui o estado; Resolved/Acknowledged seguem notificando (auto-resolve visível = "auto-curou"). Obs.: a família Alert não tem o guard `isManualAction` do Incident (`11f7d339d9`) — só o inicial é suprimido.
- `AlertInternalNoteService.ts` — `sendWorkspaceNotification: false` na criação E atualização de private notes. Família `AlertEpisode` NÃO patchada (YAGNI — o bridge cria Alert direto).

**⚠️ Gotcha de linhagem (a lição cara)**: as tags `.5`/`.6` (OIDC/identity) foram construídas sobre a `.1` e **não continham** os commits da branch `medgrupo/11.0.3-fixes` (`.2`/`.3` nunca viraram tag — eram só builds). A imagem `.6` em produção aparentava ter os patches porque o build é `docker build` local da ÁRVORE, não da tag. A `.7` reconcilia: branch `medgrupo/11.0.3-r7` = tag `.6` + cherry-pick de `11.0.3-medgrupo.1..medgrupo/11.0.3-fixes` (4 commits, zero conflito — arquivos disjuntos) + patches Alert. **Regra daqui pra frente: toda tag nova parte da tag anterior e traz a linha inteira; build sempre de árvore limpa em cima da tag.**
