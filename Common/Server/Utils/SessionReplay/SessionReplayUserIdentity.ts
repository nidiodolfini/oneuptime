import crypto from "crypto";
import ObjectID from "../../../Types/ObjectID";
import { SESSION_REPLAY_MAX_USER_REF_LENGTH } from "../../../Types/Rum/SessionReplay";

/*
 * PATCH medgrupo (12.0.6-medgrupo.4): o "identity path" que o ingest promete
 * em comentario e o upstream nunca escreveu — o recorder envia
 * meta.identifiedUserRef (identify()/data-oneuptime-user-ref), o parser o
 * aceita, as colunas identifiedUserKey/identifiedUserLabel existem no
 * RumSessionV1 e a UI as exibe ("Anonymous" quando vazias), mas NENHUM
 * escritor existia: grep repo-wide de identifiedUserRef achava so recorder,
 * parser e types. Mesma familia do snapshotPart (12.0.6-medgrupo.2).
 *
 * key: sha256("<projectId>|user|<ref>") hex truncado em 32 — mesmo espirito
 * das entity keys C4 (keyForService): estavel para busca/agrupamento, sem
 * PII legivel, e escopado por projeto (o prefixo mata linkability entre
 * projetos; o HMAC-com-salt planejado pelo upstream nao paga o custo da
 * infra de salt para um ref que ja e um identificador interno).
 *
 * label: o ref cru, truncado no mesmo cap do parser — e a string exibida na
 * lista de sessoes. A "column ACL" propria do plano upstream nao existe; o
 * label fica atras do mesmo ReadRumSessionReplay do resto da linha.
 */
export interface IdentifiedUser {
  key: string;
  label: string;
}

export default class SessionReplayUserIdentity {
  public static buildIdentifiedUser(data: {
    projectId: ObjectID;
    userRef: string | undefined;
    captureUserIdentity: boolean;
  }): IdentifiedUser {
    const ref: string = (data.userRef || "")
      .trim()
      .slice(0, SESSION_REPLAY_MAX_USER_REF_LENGTH);

    if (!data.captureUserIdentity || !ref) {
      return { key: "", label: "" };
    }

    const key: string = crypto
      .createHash("sha256")
      .update(`${data.projectId.toString()}|user|${ref}`)
      .digest("hex")
      .slice(0, 32);

    return { key: key, label: ref };
  }
}
