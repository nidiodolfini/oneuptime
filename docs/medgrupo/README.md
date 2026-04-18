# Medgrupo — customizations and operational docs

This directory contains documentation specific to the Medgrupo deployment of this OneUptime fork. Upstream contributors and other users can safely ignore this folder.

## Contents

| File | Purpose |
|---|---|
| `architecture.md` | Architecture overview of the OneUptime deployment at Medgrupo (clusters, networking, spokes) |
| `runbook-bootstrap.md` | Runbook for bootstrapping a fresh OneUptime instance in the Medgrupo infrastructure |
| `lessons-learned.md` | Accumulated technical learnings from running and customizing this fork |
| `upstream-prs-draft.md` | Draft content for upstream contributions (changes worth sending back to OneUptime/OneUptime) |
| `fork-strategy.md` | Strategy and rationale for maintaining this fork (branch naming, versioning convention, release process) |

## Related repositories

- **gitops-plataform** (private): ArgoCD manifests that deploy this OneUptime fork via Helm chart
- **sre-forge** (private): Operational Python scripts for OneUptime instance management (bulk import, audit, Slack notifications, monitor silencing)

## Branch and versioning convention

- Feature/fix branches: `medgrupo/<upstream-version>-fixes` (e.g. `medgrupo/10.0.55-fixes`)
- Image tags: `<upstream-version>-medgrupo.<N>` (e.g. `10.0.55-medgrupo.7`)
- Images published at: `ghcr.io/nidiodolfini/oneuptime-app`, `ghcr.io/nidiodolfini/oneuptime-probe`

## Status

Private content. Will likely remain private unless specific files are sanitized for public reference.