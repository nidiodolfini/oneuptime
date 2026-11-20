# Contribuições para o upstream (OneUptime/oneuptime)

**Branch pattern no fork `nidiodolfini/oneuptime`**: `fix/<area>-<short-name>`, a partir de uma base limpa do upstream (`upstream-<versão>`, hoje `upstream-16.0.0`, ou o `master` do upstream), NUNCA de uma branch `medgrupo/*`. Um fix por branch, um PR por fix, sem referência cruzada.

## Estado em 2026-11-20

Conferido por leitura de código na tag 16.0.0 do upstream (2026-11-18), a base da linha `medgrupo/16.0.0-r1`. Nada aqui foi testado numa instância, e o estado dos PRs antigos no GitHub do upstream (abertos, fechados, mergeados) não foi consultado. Os commits citados são os da linha `medgrupo/16.0.0-r1`.

### O que foi feito dos PRs de 2026-04

| PR upstream | Assunto | Situação no código |
|---|---|---|
| #2393 | `max_tokens` do Anthropic | Absorvido: patch descartado no rebase 12.0.6 (`LLMService` reescrito) |
| #2394 | Órfãos de stalled-job no worker de telemetria | Patch descartado no rebase 16.0.0: o upstream trata job de tipo desconhecido com `UnknownQueueJob.handBack` (#5546) antes de onde a guarda ficava. Ver o candidato 5 |
| #2395 | Preâmbulo `getJob + remove` do `Queue.addJob` | Fora do stack desde a 11.0.3. Na 16.0.0 o `Queue.ts` ainda chama `getJob` antes do `add` em dois pontos e tem um caminho que pula essa ida e volta; não reavaliado |
| #2396 | Race no find/create de Service | Absorvido: descartado no rebase 12.0.6 (`QueryHelper.findWithSameText`) |
| #2397 | Valores não finitos em métricas OTLP | Absorvido: `OtelMetricsIngestService.toNumberOrNull` usa `Number.isFinite` no ramo de string |
| (draft #6) | Seção do Slack acima de 3000 caracteres | Absorvido: descartado no rebase 14.0.46 (`SECTION_TEXT_MAX_LENGTH` e split nativo) |

### Candidatos de hoje

Todos presentes na 16.0.0. Os três primeiros são bug puro, pequenos e já têm teste no fork.

1. **`DetectionRuleService`: `.trim()` em `null` derruba criar e salvar regra (500).** O `onBeforeCreate` e o `onBeforeUpdate` só conferem `!== undefined` antes do `.trim()` de `groupByField` e `distinctCountField`, e o formulário manda campo vazio como `null`. Fork: `5a59da5287` (update) e `63048299ae` (create), teste em `Tests/Server/Services/DetectionRuleService.test.ts`.
2. **`UserService.createByEmail`: nome vindo do IdP acima de 50 caracteres derruba o primeiro login.** O claim `name` do OIDC/SAML vai direto para `User.name` (`ColumnLength.Name`). Fork: `1c4fc61340`, teste em `Tests/Server/Services/UserServiceCreateByEmailNameLength.test.ts`.
3. **Login SSO/OIDC conta convite pendente como membership.** O `teamMemberCount` dos quatro callbacks (`OIDC.ts`, `SSO.ts`, `GlobalOIDC.ts`, `GlobalSSO.ts`) não filtra `hasAcceptedInvitation`: quem tem só um convite pendente ganha sessão, não entra em time nenhum e cai em "create your first project". Fork: primeira metade do `09273328be` (só `OIDC.ts` e `SSO.ts`). Para o upstream, vale propor que o login aceite o convite pendente, como o `ProjectSsoSignInConfirmation` já faz, em vez de criar uma segunda membership. A segunda metade daquele commit (`SSO_DEFAULT_PROJECT_IDS`) é da Medgrupo e não vai: o Global OIDC com projetos anexados cobre o caso.
4. **`AwsDataSecurityReader`: o S3 gasta o orçamento inteiro da leitura.** `DEFAULT_MAX_REQUESTS = 5000`, cerca de nove requisições por bucket, S3 lido antes de qualquer Region e sem continuação entre rodadas: conta com mais de ~550 buckets nunca tem RDS, DynamoDB, DocumentDB nem IAM lidos. Fork: `0dc5236527` (teto em 15000). Para o upstream o número é paliativo; propor orçamento por fase, Regions antes do S3 ou continuação entre rodadas. Pode começar como issue.
5. **Job órfão de telemetria é tratado como "outra release" (hipótese).** Um job cujo hash perdeu o `data` chega com `type` indefinido, entra em `describeUnknownTelemetryJob` e vai para o `handBack`. Pela leitura do `UnknownQueueJob.getDueAt`, sem `timestamp` no hash a conta de espera dá "30 minutos vencidos" e o job falha na hora com a mensagem "a server running another release of OneUptime queued it", que manda o operador procurar uma divergência de versão que não existe. Antes de propor: procurar `telemetry of type "undefined"` nos logs do deployment para saber se órfãos ainda acontecem.
6. **Tiles de CloudWatch para banco gerenciado** (Aurora, DocumentDB, ElastiCache) no catálogo da Overview de Databases. Fork: `c89109ae84`. É feature, não bug: precisa de conversa sobre nomes de métrica antes do PR.
7. **Dropdown de filtro do `BaseModelTable` com `LIMIT_PER_PROJECT`.** Fork: `2b7435f6ef` (limite 100). A reavaliar antes de propor.

Não são candidatos: os patches de Slack (opinião da Medgrupo, e o upstream já deixa escolher por regra o que posta; ver `lessons-learned.md`, 2026-11-20), o botão de SSO por env (o upstream tem o Global OIDC para isso) e o `AI_RESPONSE_LANGUAGE` (o upstream resolveu por outro caminho).

---

# Histórico: drafts escritos entre 2026-04 e 2026-07

O que segue é o texto original dos drafts, mantido como referência de formato (Summary, Root cause, Change, Test plan). A situação de cada um está na tabela acima.

---

## PR #1 — `fix(llm): send max_tokens on Anthropic completion requests`

**Status**: Já aberto como **OneUptime/oneuptime#2393**. Apenas atualizar referência no body se necessário.

Commit SHA no fork (do branch de tag): `318846c`
Commit SHA no fork (do branch de master): `6811686` (o original, usado no PR aberto)

---

## PR #2 — `fix(telemetry): skip stalled-job orphans instead of throwing`

**Body sugerido**:

## Summary

The telemetry worker throws `Unknown telemetry type: undefined` whenever BullMQ hands it a job whose underlying Redis hash has lost its `data` field. These stalled-job orphans fall through the `switch (jobData.type)` default and crash the worker callback, producing hundreds of noisy log entries per minute on busy telemetry queues.

## Root cause

Under load (e.g. 10M+ telemetry rows/min), the following race materializes:

1. Job A is in the `active` state, being processed by worker 1.
2. Worker 1's event loop blocks longer than `lockDuration` (default 30s). Lock expires.
3. BullMQ's stalled-job recovery moves A back to `wait`.
4. Worker 2 picks up A, processes it successfully. `removeOnComplete: { count: 500 }` rotates A's hash out of the completed set and strips its `data` field.
5. Worker 1 unblocks and still has A loaded locally. It re-hydrates the job — but the Redis hash no longer contains `data`, so `job.data` comes back as `{}`.
6. `jobData = job.data as TelemetryIngestJobData` — no runtime validation from the cast.
7. `switch (jobData.type)` falls through to `default: throw new Error("Unknown telemetry type: undefined")`.

Evidence from a real deployment: `SCARD bull:Telemetry:stalled` returns 12, `ZCARD bull:Telemetry:failed` returns 5909, and the failed set IDs are hashes that only contain BullMQ bookkeeping keys (`atm`, `stc`, `processedOn`, `finishedOn`, `failedReason`, `stacktrace`) without `data`/`opts`/`name`.

## Change

Add a defensive guard at the top of the worker callback:

```typescript
if (
  !jobData ||
  typeof jobData !== "object" ||
  Object.keys(jobData as object).length === 0 ||
  !jobData.type
) {
  logger.debug(
    `Skipping telemetry job ${job.id ?? "?"}: missing or empty data (likely a stalled-job orphan)`,
  );
  return;
}
```

Legitimate jobs are unaffected — if `data` really has a valid payload, `jobData.type` is a truthy `TelemetryType` string and the switch proceeds normally. Orphans get a debug log and return, letting BullMQ mark the job as completed without throwing.

## Test plan

- [x] Manual: observed on a production deployment that this guard drops ~400 `Unknown telemetry type` errors/min without affecting throughput (`oneuptime.LogItemV2` insertion rate unchanged, `MonitorProbe.updatedAt` keeps advancing).

## Related

Pairs well with the companion PR that removes the non-atomic `getJob + remove` preamble in `Common/Server/Infrastructure/Queue.ts:addJob`, which is part of what creates these orphan records in the first place. This PR stands alone though — it's a minimal runtime safety net.

---

## PR #3 — `fix(queue): drop non-atomic getJob+remove preamble from addJob`

**Body sugerido**:

## Summary

`Queue.addJob` in `Common/Server/Infrastructure/Queue.ts` does `getJob(id)` + `job.remove()` before calling `queue.add()`. The intent is to force-replace existing jobs that share the same custom id. The preamble is not atomic and creates orphan records under concurrent producers and stalled-job recovery.

## Root cause

Current flow (simplified):

```typescript
const job = await queue.getJob(sanitizedJobId);
if (job) {
  await job.remove();  // Not atomic with the add that follows
}
const jobAdded = await queue.add(jobName, data, { jobId: sanitizedJobId });
```

Three problems:

1. **Racy**: between `job.remove()` and `queue.add()`, another producer can concurrently re-add the same id. The eventual `add` then sees an existing job and returns it, silently dropping the second producer's data.
2. **Interacts badly with stalled-job recovery**: if `getJob` returns a record that's already in the failed set with its hash partially cleaned up (via `removeOnFail: {count: 100}` rotation), `job.remove()` finishes the cleanup non-atomically and the subsequent `add` can leave the hash missing its `data` field. Downstream workers then observe the orphan and crash — see the companion PR for the safety net.
3. **Unnecessary**: every non-repeatable caller in this repo (`TelemetryQueueService`, `ProbeIngestService`, `ServerMonitorIngestService`, `IncomingRequestIngestService`) generates a nanosecond-unique `jobId` per enqueue. Collisions between live producers are effectively impossible. For repeatable jobs, the `removeRepeatableByKey` block earlier in `addJob` already handles replacement via the supported BullMQ API.

## Change

Drop the `getJob + remove` preamble. BullMQ already deduplicates by `jobId` natively — when a caller passes an id that exists in wait/active/delayed, `queue.add()` returns the existing job rather than throwing or creating a duplicate, which is the behavior every caller in this repo actually wants.

## Test plan

- [x] Manual: validated in a production deployment under ~10M telemetry rows/min. No regression in throughput; the companion fix for orphan jobs no longer triggers because orphans stop being created at the source.

---

## PR #4 — `fix(telemetry): make service find/create race-safe with case-insensitive retry`

**Body sugerido**:

## Summary

`OTelIngestService.telemetryServiceFromName` can throw `Failed to create or find service: X` when two OTLP batches for the same service name arrive concurrently and differ in case or whitespace. The handler's initial lookup and the post-conflict re-fetch use an exact string match, while `DatabaseService.checkUniqueColumnBy` rejects duplicates case-insensitively. That mismatch causes the re-fetch to miss the row the winning worker just committed, and the whole OTLP batch is dropped.

## Root cause

```typescript
// Initial lookup (current code) — exact match
await ServiceService.findOneBy({
  query: { projectId, name: data.serviceName },
});

// Pre-create hook in DatabaseService.checkUniqueColumnBy
// uses QueryHelper.findWithSameText which matches LOWER(name) = LOWER(?)
```

The race:

1. Worker A receives OTLP with `service.name = "Service-Acesso"`, exact-match `findOneBy` returns null.
2. Worker B receives OTLP with `service.name = "service-acesso"` simultaneously, exact-match also returns null.
3. Worker A calls `ServiceService.create` — pre-create hook's `countBy` finds no existing row via `LOWER(?)`, commit succeeds with `"Service-Acesso"`.
4. Worker B calls `ServiceService.create` — pre-create hook's `countBy` finds Worker A's row via `LOWER(?)`, throws `BadDataException("Service with the same name already exists")`.
5. Worker B catches and re-fetches via exact-match on `"service-acesso"` — misses because the stored value is `"Service-Acesso"`.
6. Worker B throws `Failed to create or find service`, losing the entire OTLP batch.

A second, briefer failure mode exists even when cases match: under read-committed isolation, Worker B's re-fetch can run inside the commit window of Worker A's winning transaction and return null on a row that is about to be visible.

## Change

- Use `QueryHelper.findWithSameText` consistently for both the initial lookup and the post-conflict re-fetch, so Worker B reliably sees the row Worker A just committed regardless of case/whitespace variations.
- Add a bounded retry loop (5 attempts, 25/50/75/100/125ms backoff = ~375ms worst case) around the post-conflict re-fetch to cover the commit-propagation window under read-committed isolation.
- Early-return when the initial lookup succeeds to simplify the control flow and drop a level of nesting.
- Bubble the `Failed to create or find` error only after every retry has missed.

## Test plan

- [x] Manual: validated in a production deployment where a .NET service's OTLP pipeline ships `service.name` in mixed case across pods. Pre-fix: ~251 errors/10min dropping full OTLP batches. Post-fix: 0 errors in the same window, no throughput regression.

---

## PR #5 — `fix(metrics): drop non-finite numeric values when parsing OTLP strings`

**Body sugerido**:

## Summary

`OtelMetricsIngestService.toNumberOrNull` correctly filters NaN/±Infinity when the input is already a JS number, but accepts any string that `parseFloat` can consume — including `"Infinity"` and `"-Infinity"`, which `parseFloat` returns unchanged and `isNaN` reports as valid. These non-finite values then flow through to ClickHouse's JSONEachRow parser, which rejects the whole INSERT batch.

## Root cause

```typescript
private static toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return isNaN(parsed) ? null : parsed;  // ← accepts Infinity
  }
  return null;
}
```

OTLP histograms routinely serialize the trailing `explicitBound` as `"Infinity"` when the final bucket is unbounded — this is spec-compliant. On the JSON transport, the value arrives as the string literal `"Infinity"`, hits the string branch, is parsed back to `Infinity`, and is then placed into the row that the worker ships to ClickHouse via JSONEachRow format. ClickHouse's parser rejects the entire INSERT with:

```
DB::Exception: Cannot read array from text, expected comma or end of array,
found 'e': (while reading the value of key explicitBounds)
```

dropping the full `oneuptime.MetricItemV2` batch — not just the offending metric.

## Change

One-line change: use `Number.isFinite(parsed)` instead of `!isNaN(parsed)` in the string branch. `Number.isFinite` rejects NaN AND ±Infinity, causing `toNumberOrNull` to return null for non-finite strings, which the caller's `.filter(entry !== null)` then drops.

This applies transparently to every numeric field that flows through `toNumberOrNull` — `valueFromInt`, `valueFromDouble`, `count`, `sum`, `min`, `max`, `bucketCounts` entries and `explicitBounds` entries — not just the field that triggered the visible error. Histograms whose last `explicitBound` is Infinity now store the bucket count for the unbounded final bucket while dropping only the unrepresentable bound, matching the implicit +∞ semantics of the OTLP spec.

## Test plan

- [x] Manual: validated in a production deployment where .NET Prometheus histograms with `le="+Inf"` final buckets were dropping ~170 metrics/5min. Post-fix: zero parser errors over 10 minutes, metrics persist.

## Related

This is one of several race/parsing fixes applied on top of OneUptime 10.0.55 for a production deployment. See also: PRs for probe-ingest stalled-job orphans and service creation race condition.

---

## PR #6 — `fix(slack): keep markdown blocks within Slack 3000-char section limit`

Commit SHA no fork (branch de tag `medgrupo/11.0.3-fixes`): `1a35268a18`. Para o PR upstream, cherry-pick sobre `master` (branch `fix/slack-3000-char-section-limit`).

**Body sugerido**:

## Summary

Slack rejects any `section` block whose `text.text` exceeds 3000 characters with `ok: false, error: "invalid_blocks"`. Because Slack returns HTTP 200, the axios retry path never triggers, and the per-channel catch in `SlackUtil.sendMessage` logs and swallows the error — the whole message, action buttons included, silently disappears. Incident-created messages with long descriptions (e.g. auto-created incidents fed by alerting pipelines) and private-note mirrors of ~3000-char notes never reach the channel, while short state-change messages keep posting. `WorkspaceNotificationLog` only records successes, so there is no trace in the DB either.

## Root cause

`WorkspaceUtil.getMessageBlocksByMarkdown` wraps the whole markdown (incident description included) in a single `WorkspacePayloadMarkdown`, and `SlackUtil.getMarkdownBlock` converts it to one `section` block with no length handling. The existing batching in `SlackUtil.sendMessage` only splits messages at 50 *blocks*; a single oversized block sails through untouched and poisons the whole `chat.postMessage` payload.

## Change

Two defensive layers:

1. `WorkspaceUtil.getMessageBlocksByMarkdown` splits the markdown into chunks of <=2800 characters (paragraph-boundary preferred, hard cut for giant paragraphs) BEFORE block generation, producing N markdown blocks. Blocks appended later (action buttons) stay on the same message, and the existing 50-block batching still applies. 2800 leaves headroom for `SlackifyMarkdown` transforms.
2. `SlackUtil.getMarkdownBlock` truncates at 3000 characters post-`SlackifyMarkdown` as a safety net for call sites that build `WorkspacePayloadMarkdown` directly.

## Test plan

- [x] Production deployment (self-hosted 11.0.3 + patch): incident auto-created with 3361-char description now posts the created-message with buttons (2 sections); ~3000-char private notes mirror to the channel; zero `invalid_blocks` in logs.
- [ ] Unit test for the chunking helper (boundary: empty, exactly limit, giant paragraph, multi-paragraph).
