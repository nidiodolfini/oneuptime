# Arquitetura da stack med-uptime

Data: 2026-04-11

Status: documento de referência escrito imediatamente antes do rebuild completo da stack (ver `docs/med-uptime-runbook-bootstrap.md`). Descreve a intenção do desenho, não necessariamente o estado exato do cluster num momento qualquer.

## Objetivo

A stack `med-uptime` é a plataforma central de **incident management e AIOps** do Medgrupo. Ela roda no cluster hub `Management-0226` (EKS) e combina quatro funções:

1. **Monitoramento ativo** de endpoints internos e externos via probes sintéticos.
2. **Agregação de alertas** vindos dos clusters spoke (produção, homologação, devops) via Robusta.
3. **Investigação automatizada** de incidentes usando HolmesGPT (AIOps com Claude Sonnet 4.6) que consulta métricas, logs e traces dos spokes.
4. **Notificação e histórico** de incidentes via OneUptime (UI + API), com posts para Slack.

A stack **não substitui** Mimir/Loki/Tempo/Grafana nos spokes — eles continuam sendo storage e UI primários de observabilidade. O med-uptime é a camada de "acima disso": alertas estruturados, incidentes com contexto, runbooks e investigação assistida por IA.

## Componentes

Todos rodam no namespace `med-uptime` do cluster `Management-0226`, exceto onde indicado.

| Componente | Tipo | Função | Dependências |
|---|---|---|---|
| **OneUptime server** | Deployment, 3 réplicas | UI/API principal. Monitora estado de Monitors, registra Incidents, gerencia Probes, expõe OTLP receiver (gRPC 4317 + HTTP). | RDS PostgreSQL, Redis, ClickHouse |
| **OneUptime probes (2)** | Deployment, 1 réplica cada | Executam health checks ativos. `Probe-Management` monitora serviços externos (NLBs públicos). `Probe-EKS-Prod` monitora serviços internos via `management.internal`. | OneUptime server |
| **ClickHouse** | StatefulSet, 1 réplica, PVC 200Gi gp3 | Storage colunar para telemetry ingerida via OTLP (logs, métricas, traces). Retenção 30d logs, 90d métricas, 30d traces. | — |
| **Redis** | StatefulSet, 1 réplica, PVC 10Gi gp3 | Cache, sessões, filas internas do OneUptime e findings-store do Holmes Bridge. **Standalone in-cluster** (não Valkey cluster — ver seção "Por que Redis in-cluster"). | — |
| **RDS PostgreSQL** | AWS RDS externo | Storage relacional: Project, User, Monitor, Incident, Probe, GlobalConfig e demais entidades do OneUptime. Secret em `Management-0226/oneuptime/postgres` no AWS Secrets Manager. | AWS RDS |
| **HolmesGPT** | Deployment, 1 réplica | AIOps engine. Recebe ask via Holmes Bridge, consulta datasources (Mimir/Loki/Tempo dos spokes) e retorna investigações em markdown/JSON. Usa `anthropic/claude-sonnet-4-6`. | Anthropic API, datasources cross-cluster |
| **Holmes Bridge** | Deployment, 1 réplica | FastAPI (Python 3.12-slim, `server.py` em ConfigMap). Recebe webhooks de OneUptime (`/webhook/incident`) e de Robusta (`/webhook/robusta`), enfileira investigações no HolmesGPT, posta resultados como internal notes no OneUptime e mensagens no Slack. Findings ficam em Redis com fallback `deque(maxlen=200)`. | HolmesGPT, OneUptime, Redis, Slack |
| **Robusta agent** | DaemonSet em **cada spoke** (prod, prod-medsoft, homol, devops) | Detecta eventos Kubernetes ruidosos (crashloop, OOM, deploy) e envia webhook enriquecido para `holmes-bridge.mgmt.medgrupo.com.br/webhook/robusta`. **Fora do namespace med-uptime** — deployado via `spoke-platform-*` ApplicationSets. | Holmes Bridge endpoint público |

## Fluxos principais

### 1. Alertas de spoke → investigação → incident → Slack

```
Spoke (prod/homol/etc)         Management-0226
─────────────────────          ────────────────
Robusta DaemonSet
  │ detecta crashloop
  │ enriquece com pod/logs/events
  │
  ▼ POST /webhook/robusta
holmes-bridge.mgmt ─────────► Holmes Bridge
                                 │
                                 │ severity >= warning?
                                 │
                                 ├─► HolmesGPT (chamada POST /api/chat)
                                 │     │
                                 │     │ consulta Mimir/Loki/Tempo
                                 │     │ do cluster que alertou
                                 │     │
                                 │     ▼ markdown investigation
                                 │
                                 │ severity in (critical, error, high)?
                                 │     │
                                 │     ▼ POST /api/incident
                                 │     OneUptime server
                                 │         │
                                 │         ▼ POST internal note
                                 │
                                 ▼ POST Slack webhook (slack-webhook-incidents)
                                 finding stored in Redis
```

**Filtros importantes no Holmes Bridge**: `NOISE_PATTERNS` (deployment updated, secret updated) são descartados antes de chamar HolmesGPT. `ALWAYS_INVESTIGATE` (crashloop, oomkill, sigsegv, etc.) são investigados independente de severity.

### 2. Probes → OneUptime

```
Probe-Management (Deployment no hub)
  │ initContainer wait-for-oneuptime (wget /api/status até 200)
  ▼
Probe container
  │ registra via POST /api/probe/register com PROBE_ID + PROBE_KEY
  │ (IDs em values.yaml, keys em med-uptime-credentials)
  ▼
OneUptime server
  │ valida contra tabela Probe no RDS
  ├─ se válido: probe vira "connected"
  └─ se inválido: retorna "Invalid Probe ID or Probe Key", probe crasha

Uma vez registrada:
  │ OneUptime dispatcha Monitors via HTTP internal
  ▼
Probe executa check (HTTP, ping, synthetic) e reporta status
```

**Dois probes, dois ângulos**:
- `Probe-Management` → monitora URLs **públicas** (NLBs, health endpoints externos do Medgrupo)
- `Probe-EKS-Prod` → monitora endpoints **internos do EKS-Prod** via `management.internal` (Route53 Private Zone + Istio Gateway cross-cluster)

### 3. Telemetry → OTLP → ClickHouse

```
Spokes (OTEL Collectors)
  │ OTLP gRPC/HTTP
  ▼
otlp-oneuptime-grpc.mgmt.medgrupo.com.br:4317  (público, cross-account)
otlp-oneuptime-grpc.management.internal:4317   (privado, cross-cluster)
otlp-oneuptime.mgmt.medgrupo.com.br             (público, HTTP)
otlp-oneuptime.management.internal              (privado, HTTP)
  │
  ▼ GRPCRoute/HTTPRoute → Service oneuptime-otlp:4317 ou oneuptime:80
  ▼
OneUptime server (OTLP receiver)
  │ TELEMETRY_CONCURRENCY=10 (batching controlado)
  │
  ▼ async_insert em ClickHouse
oneuptime.LogItemV2    (logs)
oneuptime.MetricItemV2 (métricas)
oneuptime.TraceV2      (traces)
```

Retenção aplicada via TTL nas tabelas ClickHouse (30d/90d/30d). Bloom filter indexes em `LogItemV2.severityText` e `MetricItemV2.name` para queries rápidas.

### 4. OneUptime UI externo

```
internet
  │
  ▼ HTTPS
oneuptime.mgmt.medgrupo.com.br
  │
  ▼ HTTPRoute (medgrupo-shared-gateway, Istio)
  │ rewrites de path:
  │   /identity/*      → /api/identity/*
  │   /file/*          → /api/file/*
  │   /status-page-api/* → /api/status-page/*
  │   /                → (sem rewrite)
  ▼
Service oneuptime:80 → Pods :3002
```

Autenticação via email + senha armazenada em `oneuptime-admin-password`. Integração SAML/SSO não está habilitada nesta instância.

## Topologia de cluster

```
                    ┌─────────────────────────────────────┐
                    │  Management-0226  (EKS hub)         │
                    │  workload: med-uptime               │
                    │                                     │
                    │  ┌──────────┐  ┌──────────────┐    │
                    │  │ oneuptime│  │  probes (2)  │    │
                    │  │ (3 rep)  │  │              │    │
                    │  └────┬─────┘  └──────────────┘    │
                    │       │                             │
                    │  ┌────┴────┐  ┌───────┐  ┌───────┐ │
                    │  │ClickHouse│  │ Redis │  │Holmes │ │
                    │  │ 200Gi    │  │  10Gi │  │Bridge │ │
                    │  └──────────┘  └───────┘  └───┬───┘ │
                    │                                │     │
                    │                   ┌────────────┤     │
                    │                   ▼            │     │
                    │              ┌─────────┐       │     │
                    │              │HolmesGPT│       │     │
                    │              └─────────┘       │     │
                    │                                │     │
                    └────────────────────────────────┼─────┘
                                     ▲               │
                                     │ webhooks      │ notes/incidents
                                     │               │
                                     │               ▼
                    ┌────────────────┴───┐     ┌─────────────┐
                    │                    │     │    Slack    │
                    │  Spokes:           │     └─────────────┘
                    │  eks-prod-0326     │
                    │  eks-prod-medsoft  │     ┌─────────────┐
                    │  eks-homol-0326    │     │Anthropic API│
                    │  eks-devops-0326   │     └─────────────┘
                    │                    │
                    │  - Robusta (DS)    │     ┌──────────────┐
                    │  - Mimir           │◄────┤  HolmesGPT   │
                    │  - Loki            │     │  datasources │
                    │  - Tempo           │     │  queries     │
                    │  - OTEL Gateway ───┼─────► OTLP para   │
                    │                    │     │  med-uptime  │
                    └────────────────────┘     └──────────────┘
```

**Regra chave**: todo o "brain" do med-uptime (server, probes, ClickHouse, Redis, HolmesGPT, Bridge) roda no hub. Os spokes só contribuem com Robusta (alertas) e OTLP (telemetry export). Nenhum componente do med-uptime é duplicado nos spokes.

**Clusters reconhecidos**:

| Cluster | Papel | Med-uptime | Observabilidade local |
|---|---|---|---|
| `Management-0226` | Hub EKS | **Sim** (stack completa) | Mimir/Loki/Tempo/Grafana centralizados também |
| `eks-prod-0326` | Produção workload | Não (só Robusta + OTEL) | Stack completa |
| `eks-prod-medsoft-0326` | Produção workload MedSoft | Não (só Robusta + OTEL) | Stack completa |
| `eks-homol-0326` | Homologação | Não (só Robusta + OTEL) | Stack completa |
| `eks-devops-0326` | DevOps/CI | Não (só Robusta + OTEL) | Stack completa |

## Integrações externas

### AWS

| Serviço | Uso | Config |
|---|---|---|
| **RDS PostgreSQL** | DB relacional do OneUptime | Endpoint em secret `Management-0226/oneuptime/postgres`, SSL obrigatório via `aws-ca-bundle` ConfigMap |
| **Secrets Manager** | Credenciais da stack | Path `Management-0326/med-uptime/credentials` (11 keys). Path tem typo histórico (`0326` vs cluster real `0226`) — será corrigido em PR separado. |
| **ExternalSecrets Operator** | Sync AWS SM → K8s Secret | ClusterSecretStore `aws-secrets-manager` via IRSA, refresh 1h |
| **Route53 Private Zone** | DNS `management.internal` | Registros CNAME criados via DNSEndpoint CRDs + ExternalDNS privado |
| **Route53 Public Zone** | DNS `mgmt.medgrupo.com.br` | Registros criados via HTTPRoute source + ExternalDNS público |
| **NLB Management** | Ingress público e privado | Alvos das HTTPRoutes/GRPCRoutes via Istio Gateway |

### Hostnames expostos

| Host | Tipo | Uso |
|---|---|---|
| `oneuptime.mgmt.medgrupo.com.br` | Público | UI + API do OneUptime |
| `otlp-oneuptime.mgmt.medgrupo.com.br` | Público | OTLP HTTP ingest (spokes cross-account) |
| `otlp-oneuptime-grpc.mgmt.medgrupo.com.br` | Público | OTLP gRPC ingest (spokes cross-account) |
| `holmes-bridge.mgmt.medgrupo.com.br` | Público | Webhook receiver Robusta (spokes cross-account) |
| `otlp-oneuptime.management.internal` | Privado | OTLP HTTP ingest (cross-cluster interno) |
| `otlp-oneuptime-grpc.management.internal` | Privado | OTLP gRPC ingest (cross-cluster interno) |
| `holmes-bridge.management.internal` | Privado | Webhook receiver (cross-cluster interno) |

### Slack

Dois webhooks separados em `med-uptime-credentials`:
- `slack-webhook-alerts` → OneUptime dispara diretamente em eventos de monitor (Up/Down)
- `slack-webhook-incidents` → Holmes Bridge posta resultados de investigação e daily summaries

### Datasources do HolmesGPT

Configurados em `chart/values-management.yaml`. HolmesGPT consulta Prometheus/Mimir, Loki e Tempo **dos clusters spoke** para extrair contexto durante investigações. Endpoints usam `management.internal` (Route53 Private Zone) e dependem de peering entre VPCs + Istio Gateway cross-cluster.

Estado pós-rebuild:
- `EKS-Prod-0326` (prod) — 3 datasources
- `Management-0226` (hub) — 3 datasources (Prometheus/Loki/Tempo locais)
- `EKS-Homol-0326` (homol) — 3 datasources (**novo** — adicionado no rebuild para fechar gap)

Clusters `eks-prod-medsoft` e `eks-devops` não têm datasources configurados por padrão — alertas deles chegam via Robusta, mas o HolmesGPT não consulta a observabilidade deles durante investigação. Adicionar sob demanda.

## Secrets e rotação

11 keys em `med-uptime-credentials` (path AWS SM `Management-0326/med-uptime/credentials`):

| Secret | Propósito | Rotacionável | Quem lê |
|---|---|---|---|
| `anthropic-api-key` | Claude API para HolmesGPT | Sim (via console Anthropic) | HolmesGPT |
| `oneuptime-admin-password` | Login admin na UI | **Não rotacionar sem atualizar UI** | OneUptime (na criação do admin user) |
| `oneuptime-secret` | JWT/cookie secret interno | **Não rotacionar** sem resetar sessões | OneUptime |
| `encryption-secret` | Column-level encryption no DB | **NUNCA rotacionar** sem migration — dados existentes ficam ilegíveis | OneUptime |
| `oneuptime-api-key` | API key do Holmes Bridge → OneUptime | Sim — regenerar via UI e atualizar secret | Holmes Bridge |
| `oneuptime-telemetry-key` | Autenticação OTLP (se implementado) | Órfã atualmente — não é consumida pelo server | — |
| `clickhouse-password` | User `default` do ClickHouse | Sim, com bounce do OneUptime e CH simultaneamente | OneUptime server, ClickHouse |
| `probe-management-key` | Registration key do Probe-Management | Sim, regenerar via OneUptime UI | oneuptime-probe-management |
| `probe-eks-prod-key` | Registration key do Probe-EKS-Prod | Sim, regenerar via OneUptime UI | oneuptime-probe-eks-prod |
| `slack-webhook-alerts` | Webhook Slack para alerts | Sim (via Slack admin) | OneUptime |
| `slack-webhook-incidents` | Webhook Slack para incidents | Sim (via Slack admin) | Holmes Bridge |

`postgresql-credentials` (5 keys em `Management-0226/oneuptime/postgres`): `host`, `port`, `username`, `password`, `database`. Rotação coordenada com AWS RDS.

## Por que Redis in-cluster (e não Valkey Serverless)

A stack foi inicialmente desenhada com **Valkey Serverless AWS** como Redis. Em 2026-04-11, durante investigação de uma task pendente aparentemente trivial, descobriu-se que:

1. O OneUptime 10.0.45 usa pipelines multi-key (MSET, MGET, MULTI/EXEC) **sem hash tags** em algumas operações.
2. Valkey Serverless opera em **cluster mode** — toda operação multi-key em keys de slots diferentes é rejeitada com `ReplyError: CROSSSLOT Keys in request don't hash to the same slot`.
3. Os logs do `deploy/oneuptime` acumulavam esse erro continuamente, causando falhas intermitentes e possivelmente contribuindo para estado inconsistente no DB.

**Decisão**: trocar Valkey Serverless por Redis standalone (não-cluster) **dentro do cluster K8s**. Benefícios:
- Elimina o CROSSSLOT de raiz — Redis standalone não tem hash slots.
- Custo recorrente zero (não paga ElastiCache).
- Controle total sobre versão (pin `7.4-alpine`) e config (AOF + RDB, `allkeys-lru`, `maxmemory 3072mb`).
- TLS desnecessário — tráfego in-cluster não atravessa rede não-confiável.

Trade-offs aceitos:
- **Sem HA**: 1 réplica. Queda do pod perde cache/sessões (tolerável — OneUptime reconstrói cache, usuários fazem login novamente).
- **PVC 10Gi gp3** — persistência local. Snapshot/backup é problema do cluster, não da AWS managed.
- **Sem multi-AZ**: probabilidade de zone failure baixa, impacto contido.

Template Helm em `platform/med-uptime/chart/templates/redis.yaml` já existe desde a gênese do chart, apenas com `enabled: false`. O rebuild ativa.

## Debug e operação

### Logs úteis

```bash
# OneUptime server — procurar CROSSSLOT, erros de migration, connection issues
kubectl -n med-uptime logs deploy/oneuptime --tail=200

# Probes — confirmar registration
kubectl -n med-uptime logs deploy/oneuptime-probe-management --tail=50
kubectl -n med-uptime logs deploy/oneuptime-probe-eks-prod --tail=50

# Holmes Bridge — webhooks recebidos e findings
kubectl -n med-uptime logs deploy/holmes-bridge --tail=100

# HolmesGPT — investigações rodadas
kubectl -n med-uptime logs deploy/holmesgpt --tail=100
```

### Estado do DB

```bash
# Pod efêmero com psql (passar creds via envFrom de postgresql-credentials)
kubectl -n med-uptime run psql-debug --rm -it --restart=Never \
  --image=postgres:16-alpine \
  --overrides='{"spec":{"containers":[{"name":"psql-debug","image":"postgres:16-alpine","envFrom":[{"secretRef":{"name":"postgresql-credentials"}}],"stdin":true,"tty":true,"command":["sh"]}]}}' \
  --command -- sh
# Dentro do pod:
psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT count(*) FROM public."Probe"; SELECT count(*) FROM public."Project";'
```

### ClickHouse queries

```bash
kubectl -n med-uptime exec sts/clickhouse -- clickhouse-client \
  --query "SELECT count() FROM oneuptime.LogItemV2 WHERE timestamp > now() - INTERVAL 5 MINUTE"
```

### Redis

```bash
kubectl -n med-uptime exec sts/redis -- redis-cli INFO clients
kubectl -n med-uptime exec sts/redis -- redis-cli DBSIZE
```

## Referências

- Chart: `platform/med-uptime/chart/`
- Applications ArgoCD: `platform/med-uptime/base/applications.yaml` (project `med-uptime`, waves 14 + 15)
- ExternalSecrets: `platform/med-uptime/config/external-secrets.yaml`
- Networking (HTTPRoutes + DNS): `platform/med-uptime/config/networking.yaml`
- Runbook de bootstrap: `docs/med-uptime-runbook-bootstrap.md`
- Robusta nos spokes: `apps/applicationsets/base/spoke-platform-{prod,homol,devops}.yaml`
- ClusterSecretStore: `platform/external-secrets/config/cluster-secret-store.yaml`
