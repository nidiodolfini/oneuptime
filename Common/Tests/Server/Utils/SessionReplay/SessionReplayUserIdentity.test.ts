import SessionReplayUserIdentity, {
  IdentifiedUser,
} from "../../../../Server/Utils/SessionReplay/SessionReplayUserIdentity";
import ObjectID from "../../../../Types/ObjectID";
import { SESSION_REPLAY_MAX_USER_REF_LENGTH } from "../../../../Types/Rum/SessionReplay";

/*
 * PATCH medgrupo (12.0.6-medgrupo.4): o identity path que preenche
 * identifiedUserKey/identifiedUserLabel no header provisorio — antes dele as
 * colunas nasciam vazias e a lista ficava eternamente "Anonymous".
 */
describe("SessionReplayUserIdentity", (): void => {
  const projectId: ObjectID = new ObjectID(
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );

  it("builds a stable per-project key and keeps the ref as the label", (): void => {
    const first: IdentifiedUser = SessionReplayUserIdentity.buildIdentifiedUser(
      {
        projectId: projectId,
        userRef: "aluno-42@medgrupo.com.br",
        captureUserIdentity: true,
      },
    );

    const second: IdentifiedUser =
      SessionReplayUserIdentity.buildIdentifiedUser({
        projectId: projectId,
        userRef: "aluno-42@medgrupo.com.br",
        captureUserIdentity: true,
      });

    expect(first.key).toBe(second.key);
    expect(first.key).toMatch(/^[0-9a-f]{32}$/);
    expect(first.label).toBe("aluno-42@medgrupo.com.br");
  });

  it("scopes the key by project (no cross-project linkability)", (): void => {
    const other: ObjectID = new ObjectID("11111111-2222-3333-4444-555555555555");

    const a: IdentifiedUser = SessionReplayUserIdentity.buildIdentifiedUser({
      projectId: projectId,
      userRef: "aluno-42",
      captureUserIdentity: true,
    });

    const b: IdentifiedUser = SessionReplayUserIdentity.buildIdentifiedUser({
      projectId: other,
      userRef: "aluno-42",
      captureUserIdentity: true,
    });

    expect(a.key).not.toBe(b.key);
  });

  it("stays anonymous when identity capture is off or the ref is empty", (): void => {
    expect(
      SessionReplayUserIdentity.buildIdentifiedUser({
        projectId: projectId,
        userRef: "aluno-42",
        captureUserIdentity: false,
      }),
    ).toEqual({ key: "", label: "" });

    expect(
      SessionReplayUserIdentity.buildIdentifiedUser({
        projectId: projectId,
        userRef: "   ",
        captureUserIdentity: true,
      }),
    ).toEqual({ key: "", label: "" });

    expect(
      SessionReplayUserIdentity.buildIdentifiedUser({
        projectId: projectId,
        userRef: undefined,
        captureUserIdentity: true,
      }),
    ).toEqual({ key: "", label: "" });
  });

  it("truncates the label at the parser cap", (): void => {
    const long: string = "x".repeat(SESSION_REPLAY_MAX_USER_REF_LENGTH + 100);

    const result: IdentifiedUser =
      SessionReplayUserIdentity.buildIdentifiedUser({
        projectId: projectId,
        userRef: long,
        captureUserIdentity: true,
      });

    expect(result.label.length).toBe(SESSION_REPLAY_MAX_USER_REF_LENGTH);
  });
});
