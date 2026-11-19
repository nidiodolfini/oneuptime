# Fork Medgrupo do OneUptime

Fork do [OneUptime](https://github.com/OneUptime/oneuptime) (Apache 2.0) usado pela
plataforma da Medgrupo, self-hosted. O deploy é por GitOps, no repositório privado
`gitops-platform` (`platform/med-uptime/`).

> **O `master` não é fonte de build.** Ele é um espelho antigo do upstream (10.0.56),
> sem OIDC e sem os patches da Medgrupo. A imagem de produção sai sempre de uma tag
> `<upstream>-medgrupo.<n>` da linha de release.

## Onde está cada coisa

| Ref | Papel |
|---|---|
| `medgrupo/<upstream>-r<N>` | **Linha de release.** Tag do upstream mais os patches da Medgrupo. Em 2026-11-19: `medgrupo/14.3.0-r1` |
| `<upstream>-medgrupo.<n>` (tags) | Uma por imagem. O push da tag dispara o workflow `Medgrupo Build` (`.github/workflows/medgrupo-build.yml`, na linha de release), que builda o app (Community Edition) e o probe do commit da tag, confere os patches, roda os testes deles e publica em `ghcr.io/nidiodolfini/oneuptime-app` e `ghcr.io/nidiodolfini/oneuptime-probe` |
| `upstream-<versão>` | Tag do upstream sem nada em cima: base do próximo rebase e das branches de contribuição. Em 2026-11-19: `upstream-16.0.0` |
| `master` | Este branch. Não use para build |

## Documentação

Vive na linha de release, em `Docs/medgrupo/`:

- `README.md`: convenções e índice.
- `lessons-learned.md`: o registro vivo. Cada rebase, cada tag, cada patch e o porquê.
- `upstream-prs-draft.md`: o que vale devolver ao upstream e o que foi feito dos PRs antigos.
- `architecture.md` e `runbook-bootstrap.md`: desenho da stack e bootstrap de uma instância.

## Contribuir com o upstream

Um fix por branch, a partir de uma base limpa (`upstream-<versão>` ou o `master` do
upstream), nunca de uma branch `medgrupo/*`: o PR tem de levar só o fix.
