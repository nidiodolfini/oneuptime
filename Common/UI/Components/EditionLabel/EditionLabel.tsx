import React, { FunctionComponent, ReactElement } from "react";
import { BILLING_ENABLED } from "../../Config";

export interface ComponentProps {
  className?: string | undefined;
}

// Medgrupo fork: badge ESTATICO de marca no rodape.
//
// Substitui o componente upstream (Community/Enterprise Edition + modal de
// validacao de licenca + fetch /global-config/license). Rodamos com
// IS_ENTERPRISE_EDITION=true apenas para liberar SSO/OIDC no self-host (Apache
// 2.0, sem licenca comercial), entao nao ha UX de Enterprise nem chamadas de
// licenca a exibir. Mantido apenas um rotulo nao-clicavel "Medgrupo".
//
// BILLING_ENABLED preservado: em modo SaaS (billing) o upstream esconde o badge.
const EditionLabel: FunctionComponent<ComponentProps> = (
  props: ComponentProps,
): ReactElement => {
  if (BILLING_ENABLED) {
    return <></>;
  }

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-white px-3 py-1 text-xs font-medium text-indigo-700 shadow-sm ${
        props.className ? props.className : ""
      }`}
    >
      <span className="h-2 w-2 rounded-full bg-indigo-400"></span>
      <span className="tracking-wide">Medgrupo</span>
    </span>
  );
};

export default EditionLabel;
