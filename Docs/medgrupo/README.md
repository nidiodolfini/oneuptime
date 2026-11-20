# Medgrupo — customizations and operational docs

This directory contains documentation specific to the Medgrupo deployment of this OneUptime fork. Upstream contributors and other users can safely ignore this folder.

## Contents

| File | Purpose | State |
|---|---|---|
| `lessons-learned.md` | Living log: every rebase, every tag, every patch and why | **Current** — the source of truth for the patch stack |
| `upstream-prs-draft.md` | What is worth sending back to OneUptime/oneuptime, and what became of the earlier PRs | Current (reviewed 2026-11-20, against 16.0.0) |
| `architecture.md` | Architecture overview of the deployment (clusters, networking, spokes) | Written 2026-04-11, before the rebuild; versions cited there are historical |
| `runbook-bootstrap.md` | Runbook for bootstrapping a fresh instance in the Medgrupo infrastructure | Last run 2026-04-11 |
| `fork-strategy.md` | The original plan for the fork (April 2026) | Historical — the model in use is the one below |

## Related repositories

- **gitops-platform** (private): ArgoCD manifests that deploy this OneUptime fork via Helm chart (`platform/med-uptime/`)
- **sre-forge** (private): Operational Python scripts for OneUptime instance management (bulk import, audit, Slack notifications, monitor silencing)

## Branch and versioning convention

| Ref | Role |
|---|---|
| `medgrupo/<upstream-version>-r<N>` | **Release line.** Upstream tag `<upstream-version>` plus the Medgrupo patches, cherry-picked one by one at each rebase. Current: `medgrupo/16.0.0-r1` |
| `<upstream-version>-medgrupo.<n>` (git tags) | One per image. Pushing the tag runs `.github/workflows/medgrupo-build.yml`, which builds the app (Community Edition) and the probe from the tagged commit, checks the patches inside the image, runs their tests, and publishes both images |
| `upstream-<version>` | A clean upstream tag with nothing on top: the base for branches sent upstream. Current: `upstream-16.0.0` |
| `master` | An old mirror of upstream (10.0.56). **Never build from it** |
| `medgrupo/<upstream-version>-fixes` | The naming used up to 11.0.3. Kept for history |

- Images: `ghcr.io/nidiodolfini/oneuptime-app`, `ghcr.io/nidiodolfini/oneuptime-probe`, tagged as the git tag.
- A new tag starts from the previous one and carries the whole line (`lessons-learned.md`, 2026-07-21).
- A red build or a red test means no image: delete the tag, fix, tag again.

## Rebasing onto a new upstream version

The recipe lives in `lessons-learned.md`, in the entry of the latest rebase (2026-11-19, 16.0.0): create the branch at the upstream tag, cherry-pick the commits of the previous line one by one, decide each conflict, and re-check every patch against what upstream now does natively.

## Contributing upstream

One fix per branch, branched from a clean upstream base (`upstream-<version>` or upstream's `master`), never from a `medgrupo/*` branch. The candidates and their evidence are in `upstream-prs-draft.md`.

## Status

Private content. Will likely remain private unless specific files are sanitized for public reference.
