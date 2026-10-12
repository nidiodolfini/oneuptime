# Runbook: bootstrap/rebuild da stack med-uptime

Data da última execução: 2026-04-11 (primeira execução — rebuild completo)

## Quando usar este runbook

Use este procedimento quando precisar **reconstruir do zero** a stack `med-uptime` no cluster `Management-0226`. Cenários típicos:

- DB do OneUptime ficou corrompido ou foi zerado por engano
- Upgrade grande de versão (OneUptime major, ClickHouse LTS)
- Migração de engine de Redis (ex: Valkey Serverless → Redis in-cluster, feita em 2026-04-11)
- Troubleshooting prolongado onde a causa raiz não se resolve e o custo de re-bootstrap é menor que o de debug

**Não use** para mudanças pequenas: upgrade de imagem patch, ajuste de env var, adicionar datasource. Essas vão pelo fluxo GitOps normal (commit → ArgoCD sync).

## Pré-requisitos

- Acesso `kubectl` ao cluster `Management-0226` com permissão de admin no namespace `med-uptime` e no Application ArgoCD
- Credenciais AWS com permissão de `rds:CreateDBClusterSnapshot`, `secretsmanager:GetSecretValue/PutSecretValue`, `elasticache:DeleteServerlessCache` (Fase 5)
- `argocd` CLI (ou acesso à UI do ArgoCD) com permissão para dar sync manual em apps
- Acesso ao repo `gitops-plataform` com permissão de push em branches e merge
- 1-2h de janela de manutenção (OTLP ingestion fica offline temporariamente durante o wipe)

## Visão geral das fases

| Fase | Duração | Nível de risco | Reversível |
|---|---|---|---|
| 0. Pré-requisitos e docs | 10-15 min | Zero | Sim |
| 1. PR com mudanças de chart | 15-30 min | Zero (não merge ainda) | Sim |
| 2. Wipe destrutivo | 10-15 min | **Alto** | Via snapshot RDS |
| 3. Merge PR + sync | 10-20 min | Médio | Revert do PR |
| 4. Bootstrap scriptado | 15-30 min | Baixo | Reset do Project |
| 5. Verification + cleanup | 30-60 min | Zero | — |

---

## Fase 0: Pré-requisitos

### 0.1. Snapshot RDS (baseline, safety net)

```bash
# Descobrir o cluster ID do RDS (se não souber)
aws rds describe-db-clusters \
  --query 'DBClusters[?contains(Endpoint, `observability`)].DBClusterIdentifier' \
  --output text

# Criar snapshot
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier <cluster-id> \
  --db-cluster-snapshot-identifier oneuptime-pre-rebuild-$(date +%Y-%m-%d)
```

Aguardar snapshot ficar `available`:
```bash
aws rds describe-db-cluster-snapshots \
  --db-cluster-snapshot-identifier oneuptime-pre-rebuild-$(date +%Y-%m-%d) \
  --query 'DBClusterSnapshots[0].Status'
```

### 0.2. Inventariar secrets do AWS SM

```bash
aws secretsmanager get-secret-value \
  --secret-id Management-0326/med-uptime/credentials \
  --query SecretString --output text > /tmp/med-uptime-secrets-backup.json

# Verificar as 11 keys
jq 'keys' /tmp/med-uptime-secrets-backup.json
```

**IMPORTANTE**: esse arquivo contém secrets em claro. Nunca commitar. Deletar ao final do runbook (passo 5.4).

### 0.3. Validar DNS homol (se for incluir datasources homol)

```bash
# De um pod qualquer no management
kubectl -n med-uptime exec deploy/oneuptime -c oneuptime -- \
  sh -c 'nslookup mimir-query-eks-homol-0326.management.internal; nslookup loki-query-eks-homol-0326.management.internal; nslookup tempo-query-eks-homol-0326.management.internal'
```

Se algum não resolver, remover do `values-management.yaml` ou aceitar que o datasource vai falhar silenciosamente no HolmesGPT (Holmes não crasha — ele pula toolsets quebrados).

---

## Fase 1: PR com mudanças do chart

Branch: `rebuild/med-uptime-stack` em `gitops-plataform`.

### 1.1. `chart/values.yaml`

```yaml
redis:
  enabled: true                     # era false
  image:
    repository: redis
    tag: "7.4-alpine"                # pin minor, era "7-alpine"

clickhouse:
  image:
    tag: "25.3"                      # era "24.8"

oneuptime:
  image:
    tag: "10.0.55"                   # era "10.0.45"

holmesgpt:
  image:
    tag: "0.24.3"                    # era "0.24.0"

probes:
  image:
    tag: "10.0.55"                   # casa com oneuptime
  management:
    probeId: "REPLACE-DURING-BOOTSTRAP"  # será substituído no segundo commit
  eksProd:
    probeId: "REPLACE-DURING-BOOTSTRAP"
```

### 1.2. `chart/values-management.yaml`

Adicionar entries `homol` em prometheus, loki, tempo:

```yaml
holmesgpt:
  datasources:
    prometheus:
      - name: prod
        url: http://mimir-query-eks-prod-0326.management.internal/prometheus
        cluster: EKS-Prod-0326
      - name: homol                                              # novo
        url: http://mimir-query-eks-homol-0326.management.internal/prometheus
        cluster: EKS-Homol-0326
      - name: management
        url: http://mimir-query-frontend.observability.svc.cluster.local:8080/prometheus
        cluster: Management-0226
    loki:
      - name: prod
        url: http://loki-query-eks-prod-0326.management.internal
        cluster: EKS-Prod-0326
      - name: homol                                              # novo
        url: http://loki-query-eks-homol-0326.management.internal
        cluster: EKS-Homol-0326
      - name: management
        url: http://loki-read.observability.svc.cluster.local:3100
        cluster: Management-0226
    tempo:
      - name: prod
        url: http://tempo-query-eks-prod-0326.management.internal
        cluster: EKS-Prod-0326
      - name: homol                                              # novo
        url: http://tempo-query-eks-homol-0326.management.internal
        cluster: EKS-Homol-0326
      - name: management
        url: http://tempo-query-frontend.observability.svc.cluster.local:3100
        cluster: Management-0226
```

### 1.3. `chart/templates/oneuptime.yaml`

Trocar:
```yaml
- name: REDIS_HOST
  value: valkey-observability-6ker6e.serverless.use1.cache.amazonaws.com
- name: REDIS_TLS_CA
  valueFrom:
    configMapKeyRef:
      name: aws-ca-bundle
      key: amazon-root-ca-1.pem
```

Por:
```yaml
- name: REDIS_HOST
  value: redis.med-uptime.svc.cluster.local
# REDIS_TLS_CA removido — Redis in-cluster não usa TLS
```

Manter `REDIS_PORT: "6379"`, `REDIS_DB: "0"`.

### 1.4. `chart/templates/holmes-bridge.yaml`

Trocar:
```yaml
- name: REDIS_URL
  value: "rediss://valkey-observability-6ker6e.serverless.use1.cache.amazonaws.com:6379/0"
```

Por:
```yaml
- name: REDIS_URL
  value: "redis://redis.med-uptime.svc.cluster.local:6379/0"
```

`redis-py` infere TLS pelo scheme (`redis://` vs `rediss://`). Nenhum outro ajuste no código Python.

### 1.5. Commit + push + abrir PR

```bash
cd gitops-plataform
git checkout -b rebuild/med-uptime-stack
git add platform/med-uptime/chart/values.yaml \
        platform/med-uptime/chart/values-management.yaml \
        platform/med-uptime/chart/templates/oneuptime.yaml \
        platform/med-uptime/chart/templates/holmes-bridge.yaml
git commit -m "med-uptime: rebuild stack with in-cluster Redis + bumped versions"
git push -u origin rebuild/med-uptime-stack
gh pr create --title "med-uptime: rebuild stack" --body "Ver docs/med-uptime-arquitetura.md e docs/med-uptime-runbook-bootstrap.md"
```

**NÃO MERGE AINDA.** O merge acontece na Fase 3.

---

## Fase 2: Wipe destrutivo

**Ponto de não-retorno após 2.3.** Confirmar que o snapshot da Fase 0 está `available`.

### 2.1. Pausar auto-sync do Application ArgoCD

```bash
kubectl -n argocd patch application med-uptime --type merge \
  -p '{"spec":{"syncPolicy":{"automated":null}}}'

# Verificar
kubectl -n argocd get app med-uptime -o jsonpath='{.spec.syncPolicy}'
# Deve retornar: {} ou sem "automated"
```

Isso **não deleta** o Application nem os recursos já criados — apenas impede que o ArgoCD reaja às mudanças manuais.

### 2.2. Escalar componentes de escrita para 0

```bash
kubectl -n med-uptime scale deploy oneuptime --replicas=0
kubectl -n med-uptime scale deploy oneuptime-probe-management --replicas=0
kubectl -n med-uptime scale deploy oneuptime-probe-eks-prod --replicas=0
kubectl -n med-uptime scale deploy holmes-bridge --replicas=0

# Aguardar pods sumirem
kubectl -n med-uptime get pods -w
# (Ctrl+C quando só restarem clickhouse-0, holmesgpt, e nenhum pod das deployments acima)
```

### 2.3. Wipe ClickHouse

```bash
# StatefulSet primeiro (libera o claim no PVC)
kubectl -n med-uptime delete sts clickhouse --cascade=foreground

# PVC (200Gi vão embora)
kubectl -n med-uptime delete pvc data-clickhouse-0

# Confirmar
kubectl -n med-uptime get sts,pvc | grep clickhouse
# Deve retornar vazio
```

### 2.4. Wipe PostgreSQL schema

Criar pod efêmero com psql:

```yaml
# Salvar como /tmp/psql-wipe.yaml
apiVersion: v1
kind: Pod
metadata:
  name: psql-wipe
  namespace: med-uptime
spec:
  restartPolicy: Never
  nodeSelector:
    workload: med-uptime
  containers:
    - name: psql
      image: postgres:16-alpine
      command:
        - sh
        - -c
        - |
          set -e
          psql -tAc "SELECT 'before: ' || COUNT(*) || ' tables' FROM information_schema.tables WHERE table_schema='public';"
          psql -c "DROP SCHEMA public CASCADE;"
          psql -c "CREATE SCHEMA public;"
          psql -c "GRANT ALL ON SCHEMA public TO \"$PGUSER\";"
          psql -c "GRANT ALL ON SCHEMA public TO postgres;" || echo "WARN: postgres grant failed (non-fatal)"
          psql -tAc "SELECT 'after: ' || COUNT(*) || ' tables' FROM information_schema.tables WHERE table_schema='public';"
      env:
        - name: PGHOST
          valueFrom:
            secretKeyRef: { name: postgresql-credentials, key: POSTGRES_HOST }
        - name: PGPORT
          valueFrom:
            secretKeyRef: { name: postgresql-credentials, key: POSTGRES_PORT }
        - name: PGDATABASE
          valueFrom:
            secretKeyRef: { name: postgresql-credentials, key: POSTGRES_DB }
        - name: PGUSER
          valueFrom:
            secretKeyRef: { name: postgresql-credentials, key: POSTGRES_USER }
        - name: PGPASSWORD
          valueFrom:
            secretKeyRef: { name: postgresql-credentials, key: POSTGRES_PASSWORD }
        - name: PGSSLMODE
          value: "require"
```

```bash
kubectl apply -f /tmp/psql-wipe.yaml
kubectl -n med-uptime wait --for=jsonpath='{.status.phase}'=Succeeded pod/psql-wipe --timeout=120s
kubectl -n med-uptime logs psql-wipe
# Esperado: "before: ~277 tables" e "after: 0 tables"
kubectl -n med-uptime delete pod psql-wipe
rm /tmp/psql-wipe.yaml
```

### 2.5. Deletar secret `med-uptime-credentials`

```bash
kubectl -n med-uptime delete secret med-uptime-credentials
```

ExternalSecret vai recriar no próximo refresh ou quando forçarmos sync. Higiene contra drift entre o estado no cluster e o que está no AWS SM.

---

## Fase 3: Rebuild

### 3.1. Merge do PR da Fase 1

Fazer via UI do GitHub (`gh pr merge --squash` também vale).

### 3.2. Reativar auto-sync e forçar sync imediato

```bash
kubectl -n argocd patch application med-uptime --type merge \
  -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'

argocd app sync med-uptime --prune
# (se não tem argocd CLI, usar UI)
```

### 3.3. Aguardar convergência inicial

```bash
# Acompanhar pods
kubectl -n med-uptime get pods -w
```

Ordem esperada:
1. `redis-0` (StatefulSet novo) Running em ~30s
2. `clickhouse-0` Running (recria PVC) em ~1-2min
3. `oneuptime-*` tentam subir, rodam migrations por ~1-5min, Running
4. `holmesgpt-*`, `holmes-bridge-*`, probes seguem em sequência

### 3.4. WORKAROUND: segundo rollout restart do OneUptime

**Motivo**: o initContainer `seed-global-config` do deployment `oneuptime` só insere a row de `GlobalConfig` se a tabela JÁ existe. No primeiro pod pós-wipe, a tabela não existe → init pula o seed → container principal roda migrations → tabela é criada → mas o seed nunca mais roda. Resultado: UI do OneUptime não abre (falta GlobalConfig).

**Solução**: forçar um segundo pod após migrations completarem.

```bash
# Confirmar que o schema foi criado (deve ter ~277 tabelas)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: psql-check
  namespace: med-uptime
spec:
  restartPolicy: Never
  containers:
    - name: psql
      image: postgres:16-alpine
      command: ["sh", "-c", "psql -tAc \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'\""]
      envFrom:
        - secretRef:
            name: postgresql-credentials
      env:
        - name: PGHOST
          valueFrom: { secretKeyRef: { name: postgresql-credentials, key: POSTGRES_HOST } }
        - name: PGPORT
          valueFrom: { secretKeyRef: { name: postgresql-credentials, key: POSTGRES_PORT } }
        - name: PGUSER
          valueFrom: { secretKeyRef: { name: postgresql-credentials, key: POSTGRES_USER } }
        - name: PGPASSWORD
          valueFrom: { secretKeyRef: { name: postgresql-credentials, key: POSTGRES_PASSWORD } }
        - name: PGDATABASE
          valueFrom: { secretKeyRef: { name: postgresql-credentials, key: POSTGRES_DB } }
        - name: PGSSLMODE
          value: "require"
EOF
kubectl -n med-uptime wait --for=jsonpath='{.status.phase}'=Succeeded pod/psql-check --timeout=120s
kubectl -n med-uptime logs psql-check
kubectl -n med-uptime delete pod psql-check
```

Se retornar `>= 270`: schema OK. Forçar restart:

```bash
kubectl -n med-uptime rollout restart deploy/oneuptime
kubectl -n med-uptime rollout status deploy/oneuptime --timeout=300s
```

### 3.5. Sanity check

```bash
kubectl -n med-uptime get pods
# Todos Running 1/1

kubectl -n med-uptime logs deploy/oneuptime --tail=100 | grep -i 'crossslot\|error' | head
# Deve estar vazio (ou só warnings inócuos)

curl -s https://oneuptime.mgmt.medgrupo.com.br/api/status
# {"status":"ok"}
```

---

## Fase 4: Bootstrap scriptado

### 4.1. Validar endpoints da API do OneUptime 10.0.55

Antes de rodar o script, confirmar que os paths assumidos batem com o que a versão expõe.

```bash
# Ler OpenAPI se disponível
curl -s https://oneuptime.mgmt.medgrupo.com.br/api-docs | jq . | head -50

# Ou testar login
curl -s -X POST https://oneuptime.mgmt.medgrupo.com.br/api/identity/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@oneuptime.local","password":"<admin-password>"}'
```

Se o path `/api/identity/login` retornar 404 ou estrutura diferente, ajustar o script antes de rodar.

### 4.2. Script de bootstrap (Python)

Pré-requisitos: Python 3, `requests`, variável de ambiente `ONEUPTIME_ADMIN_PASSWORD` populada a partir do secret.

```bash
export ONEUPTIME_ADMIN_PASSWORD=$(kubectl -n med-uptime get secret med-uptime-credentials \
  -o jsonpath='{.data.oneuptime-admin-password}' | base64 -d)
```

Salvar como `/tmp/bootstrap-med-uptime.py`:

```python
#!/usr/bin/env python3
"""Bootstrap da stack med-uptime pós-rebuild.
Cria Project, ApiKey master, 2 Probes e webhook rule.
Imprime stdout: PROJECT_ID, ONEUPTIME_API_KEY, PROBE_MGMT_ID, PROBE_MGMT_KEY,
PROBE_EKS_ID, PROBE_EKS_KEY para serem copiados pro AWS Secrets Manager e values.yaml.
"""
import os
import sys
import json
import requests

BASE = "https://oneuptime.mgmt.medgrupo.com.br"
ADMIN_EMAIL = "admin@oneuptime.local"  # ajustar se o admin user usar outro email
ADMIN_PWD = os.environ["ONEUPTIME_ADMIN_PASSWORD"]
PROJECT_NAME = "Medgrupo"

session = requests.Session()
session.headers.update({"Content-Type": "application/json"})

def die(msg, resp=None):
    print(f"ERRO: {msg}", file=sys.stderr)
    if resp is not None:
        print(f"Status: {resp.status_code}", file=sys.stderr)
        print(f"Body: {resp.text[:500]}", file=sys.stderr)
    sys.exit(1)

# 1. Login
r = session.post(f"{BASE}/api/identity/login", json={
    "email": ADMIN_EMAIL,
    "password": ADMIN_PWD,
})
if r.status_code != 200:
    die("login failed", r)

data = r.json()
# OneUptime retorna token em JWT header ou body — ajustar conforme versão real
token = data.get("token") or data.get("accessToken")
if not token:
    # Pode estar em cookie — a session já armazena
    pass
else:
    session.headers["Authorization"] = f"Bearer {token}"

# 2. Create Project
r = session.post(f"{BASE}/api/project", json={
    "data": {"name": PROJECT_NAME, "slug": PROJECT_NAME.lower()}
})
if r.status_code not in (200, 201):
    die("project creation failed", r)
project = r.json()
project_id = project.get("_id") or project.get("data", {}).get("_id")
print(f"PROJECT_ID={project_id}")

# 3. Create ApiKey
r = session.post(f"{BASE}/api/api-key", json={
    "data": {
        "projectId": project_id,
        "name": "holmes-bridge-integration",
        "expiresAt": "2027-04-11T00:00:00Z",
    }
})
if r.status_code not in (200, 201):
    die("api-key creation failed", r)
api_key_data = r.json()
# O valor da key só aparece na criação — capturar
oneuptime_api_key = api_key_data.get("apiKey") or api_key_data.get("data", {}).get("apiKey")
print(f"ONEUPTIME_API_KEY={oneuptime_api_key}")

# 4. Create Probe-Management
r = session.post(f"{BASE}/api/probe", json={
    "data": {
        "projectId": project_id,
        "name": "Probe-Management",
        "description": "Probe no cluster Management, verifica EKS-Prod externamente",
    }
})
if r.status_code not in (200, 201):
    die("probe-management creation failed", r)
probe_mgmt = r.json()
print(f"PROBE_MGMT_ID={probe_mgmt.get('_id') or probe_mgmt.get('data', {}).get('_id')}")
print(f"PROBE_MGMT_KEY={probe_mgmt.get('key') or probe_mgmt.get('data', {}).get('key')}")

# 5. Create Probe-EKS-Prod
r = session.post(f"{BASE}/api/probe", json={
    "data": {
        "projectId": project_id,
        "name": "Probe-EKS-Prod",
        "description": "Probe no Management, verifica EKS-Prod via DNS interno",
    }
})
if r.status_code not in (200, 201):
    die("probe-eks-prod creation failed", r)
probe_eks = r.json()
print(f"PROBE_EKS_ID={probe_eks.get('_id') or probe_eks.get('data', {}).get('_id')}")
print(f"PROBE_EKS_KEY={probe_eks.get('key') or probe_eks.get('data', {}).get('key')}")

# 6. Create webhook rule (OneUptime → Holmes Bridge)
r = session.post(f"{BASE}/api/incident-webhook", json={
    "data": {
        "projectId": project_id,
        "name": "holmes-bridge-webhook",
        "url": "http://holmes-bridge.med-uptime.svc.cluster.local/webhook/incident",
        "triggerOn": ["CREATED", "STATE_CHANGED"],
    }
})
if r.status_code not in (200, 201):
    print(f"WARN: webhook creation failed: {r.status_code} {r.text[:200]}", file=sys.stderr)
    print("WARN: criar webhook manualmente via UI depois", file=sys.stderr)

print("\n=== Bootstrap concluído ===", file=sys.stderr)
print("Próximo passo: copiar as keys acima para AWS Secrets Manager e values.yaml", file=sys.stderr)
```

Executar:

```bash
python3 /tmp/bootstrap-med-uptime.py | tee /tmp/bootstrap-output.txt
```

**Se o script falhar**: ler o erro, ajustar o endpoint (frequentemente os paths variam entre versões do OneUptime — veja `/api-docs` ou o source em `github.com/OneUptime/oneuptime/App`). Fallback manual via UI seguindo os mesmos passos (login → Project → ApiKey → Probes → webhook).

### 4.3. Salvar novas credenciais no AWS Secrets Manager

```bash
# Pegar secret atual
aws secretsmanager get-secret-value \
  --secret-id Management-0326/med-uptime/credentials \
  --query SecretString --output text > /tmp/secret.json

# Extrair valores do bootstrap
PROBE_MGMT_KEY=$(grep PROBE_MGMT_KEY= /tmp/bootstrap-output.txt | cut -d= -f2-)
PROBE_EKS_KEY=$(grep PROBE_EKS_KEY= /tmp/bootstrap-output.txt | cut -d= -f2-)
API_KEY=$(grep ONEUPTIME_API_KEY= /tmp/bootstrap-output.txt | cut -d= -f2-)

# Atualizar as 3 keys (preservando as outras 8)
jq --arg k "$PROBE_MGMT_KEY" '.["probe-management-key"] = $k' /tmp/secret.json | \
jq --arg k "$PROBE_EKS_KEY" '.["probe-eks-prod-key"] = $k' | \
jq --arg k "$API_KEY" '.["oneuptime-api-key"] = $k' > /tmp/secret-new.json

# Verificar
jq 'keys' /tmp/secret-new.json

# Aplicar
aws secretsmanager put-secret-value \
  --secret-id Management-0326/med-uptime/credentials \
  --secret-string file:///tmp/secret-new.json

# Limpar (contém secrets em claro)
rm /tmp/secret.json /tmp/secret-new.json
```

### 4.4. Force refresh do ExternalSecret

```bash
kubectl -n med-uptime annotate externalsecret med-uptime-credentials \
  force-sync=$(date +%s) --overwrite

# Aguardar ≤30s e verificar
sleep 15
kubectl -n med-uptime get secret med-uptime-credentials -o json | \
  jq -r '.data["probe-management-key"]' | base64 -d
# Deve bater com o PROBE_MGMT_KEY capturado
```

### 4.5. Segundo commit: substituir placeholders pelos UUIDs reais

Em `platform/med-uptime/chart/values.yaml`:

```yaml
probes:
  management:
    probeId: "<PROBE_MGMT_ID real do bootstrap>"
  eksProd:
    probeId: "<PROBE_EKS_ID real do bootstrap>"
```

Commit direto em `main` (rebuild mode, após merge anterior):

```bash
cd gitops-plataform
git checkout main
git pull
# Editar values.yaml
git add platform/med-uptime/chart/values.yaml
git commit -m "med-uptime: set real PROBE_IDs after bootstrap"
git push origin main
```

ArgoCD vai detectar a mudança e re-sync (auto-sync já reativado na Fase 3).

### 4.6. Rollout restart dos probes

```bash
kubectl -n med-uptime rollout restart deploy/oneuptime-probe-management
kubectl -n med-uptime rollout restart deploy/oneuptime-probe-eks-prod

kubectl -n med-uptime logs deploy/oneuptime-probe-management --tail=30 -f
# Deve logar: "Waiting for OneUptime to be ready... ready. Probe registered."
```

### 4.7. Criar Monitors iniciais via UI

Login em `https://oneuptime.mgmt.medgrupo.com.br`:
1. **Monitor 1**: `HTTP Check` em `https://oneuptime.mgmt.medgrupo.com.br/api/status`, label "self-check"
2. **Monitor 2**: `HTTP Check` em `https://holmes-bridge.mgmt.medgrupo.com.br/healthz`, label "holmes-bridge-health"
3. **Monitor 3**: `HTTP Check` na home pública do Medgrupo (confirmar URL)

Associar cada Monitor aos 2 Probes criados.

---

## Fase 5: Verification

### 5.1. Camada base

```bash
kubectl -n med-uptime get pods
# Todos Running 1/1

kubectl -n argocd get app med-uptime -o jsonpath='{.status.sync.status}/{.status.health.status}'
# Esperado: Synced/Healthy

kubectl -n med-uptime logs deploy/oneuptime --tail=200 | grep -iE 'crossslot|ECONNREFUSED'
# Vazio

curl -s https://oneuptime.mgmt.medgrupo.com.br/api/status
# {"status":"ok"}

curl -s https://holmes-bridge.mgmt.medgrupo.com.br/healthz
# healthy ou 200
```

### 5.2. DB

Via pod psql efêmero (mesma estrutura do Fase 2.4):

```sql
SELECT COUNT(*) FROM public."Project";       -- = 1
SELECT COUNT(*) FROM public."Probe";          -- = 2
SELECT COUNT(*) FROM public."GlobalConfig";   -- = 1
SELECT name, "connectionStatus" FROM public."Probe";  -- ambos "connected"
```

### 5.3. Probes

```bash
kubectl -n med-uptime logs deploy/oneuptime-probe-management --tail=50 | grep -i 'registered\|invalid'
# "registered" presente, "Invalid Probe" ausente

kubectl -n med-uptime logs deploy/oneuptime-probe-eks-prod --tail=50
# Sem "TypeError: json is not iterable"
```

### 5.4. Redis

```bash
kubectl -n med-uptime exec sts/redis -- redis-cli INFO clients | grep connected_clients
# >= 4 (3 OneUptime + 1 Holmes Bridge)

kubectl -n med-uptime exec sts/redis -- redis-cli DBSIZE
# > 0

# Sem erros CROSSSLOT nos logs
kubectl -n med-uptime logs deploy/oneuptime --tail=500 | grep -c CROSSSLOT
# 0
```

### 5.5. ClickHouse

```bash
kubectl -n med-uptime exec sts/clickhouse -- clickhouse-client --query "SHOW TABLES FROM oneuptime"
# Lista contém LogItemV2, MetricItemV2, TraceV2 e demais

# Após ~10min de traffic:
kubectl -n med-uptime exec sts/clickhouse -- clickhouse-client --query \
  "SELECT count() FROM oneuptime.LogItemV2 WHERE timestamp > now() - INTERVAL 5 MINUTE"
# > 0

# Bloom index aplicado pelo postStart
kubectl -n med-uptime exec sts/clickhouse -- clickhouse-client --query \
  "SHOW CREATE TABLE oneuptime.LogItemV2" | grep idx_severity
# Retorna linha com bloom_filter
```

### 5.6. Fluxo end-to-end (comportamental)

1. Criar Monitor HTTP para um endpoint funcionando (já feito em 4.7) → aguardar `Up`
2. Editar Monitor para URL inexistente → aguardar `Down` (~1min)
3. OneUptime cria Incident automaticamente
4. `kubectl -n med-uptime logs deploy/holmes-bridge | grep 'Webhook received'` — aparece
5. `kubectl -n med-uptime logs deploy/holmesgpt | grep 'investigation'` — aparece
6. UI OneUptime → Incident → Internal Notes → "HolmesGPT Investigation" como nota
7. Slack canal `incidents` → mensagem postada

### 5.7. Smoke test Robusta cross-cluster

```bash
# Em um namespace isolado no cluster homol (não prod!)
kubectl -n <ns-teste-homol> run crash-test --image=busybox --restart=Never \
  --command -- sh -c 'exit 1'

# Esperar ~1min
kubectl -n med-uptime logs deploy/holmes-bridge | grep -i robusta
# Deve aparecer log de webhook recebido com cluster homol
```

### 5.8. Cleanup

```bash
# Deletar backup local do secret (contém secrets em claro)
rm /tmp/med-uptime-secrets-backup.json /tmp/bootstrap-output.txt

# Deletar Valkey Serverless (economia recorrente)
aws elasticache delete-serverless-cache \
  --serverless-cache-name valkey-observability \
  --region us-east-1

# Atualizar memória do Claude
# Deletar ~/.claude/projects/.../memory/project_pending_oneuptime_probe_retry.md
# Atualizar MEMORY.md removendo a entry
```

---

## Troubleshooting

### OneUptime UI não abre (500 ou white screen)

**Causa**: `GlobalConfig` não foi seedado (workaround 3.4 não rodou). Verificar:

```bash
kubectl -n med-uptime exec sts/oneuptime -c oneuptime -- \
  sh -c 'psql ... -tAc "SELECT COUNT(*) FROM \"GlobalConfig\""'
# Se retornar 0, fazer rollout restart:
kubectl -n med-uptime rollout restart deploy/oneuptime
```

### Probe loga `Invalid Probe ID or Probe Key`

**Causas possíveis**:
- PROBE_ID hardcoded em values.yaml não foi atualizado (placeholder "REPLACE-DURING-BOOTSTRAP" ainda lá) → aplicar commit do step 4.5
- PROBE_KEY no secret diferente do que o bootstrap gerou → confirmar com `kubectl get secret | base64 -d` e rodar 4.3+4.4 de novo
- ExternalSecret não refrescou → `kubectl annotate es med-uptime-credentials force-sync=...`

### Redis OOM / pods reiniciando

Bumpar limits em `values.yaml`:
```yaml
redis:
  resources:
    limits:
      cpu: "2"
      memory: 8Gi  # era 4Gi
```

### ClickHouse 25.3 não sobe

Logs típicos: `Unknown setting`, `Config not recognized`. Revert tag:
```yaml
clickhouse:
  image:
    tag: "24.8"  # rollback
```

Commit, sync. Stack era zerada, não há perda.

### HolmesGPT retorna erro em toolsets

Normal se algum datasource homol não resolver (DNS management.internal incompleto). Não crasha HolmesGPT — só pula o toolset. Remover do values-management.yaml se persistente.

---

## Referências

- Arquitetura: `docs/med-uptime-arquitetura.md`
- Chart: `platform/med-uptime/chart/`
- OneUptime API docs: `https://oneuptime.mgmt.medgrupo.com.br/api-docs` (se exposto)
- OneUptime source: https://github.com/OneUptime/oneuptime
- HolmesGPT source: https://github.com/robusta-dev/holmesgpt
