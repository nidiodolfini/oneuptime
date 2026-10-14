import UserService from "../../../Server/Services/UserService";
import CreateBy from "../../../Server/Types/Database/CreateBy";
import User from "../../../Models/DatabaseModels/User";
import Email from "../../../Types/Email";
import Name from "../../../Types/Name";
import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
 * Medgrupo: o nome que o IdP manda no 1o login SSO pode passar da coluna
 * User.name (50) — o Keycloak repete os nomes do meio (mappers LDAP cn + sn).
 * createByEmail corta em vez de deixar o create recusar o login inteiro.
 * Sem banco: `create` e um stub que devolve o que recebeu.
 */

function stubCreate(): void {
  jest
    .spyOn(UserService, "create")
    .mockImplementation(async (createBy: CreateBy<User>) => {
      return createBy.data;
    });
}

describe("UserService.createByEmail name length", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("an IdP name longer than the column is clamped to 50 characters", async () => {
    stubCreate();

    const user: User = await UserService.createByEmail({
      email: new Email("jose.mariano@example.com"),
      name: new Name("Jose Francisco Rodrigues Francisco Rodrigues Mariano"),
      props: { isRoot: true },
    });

    expect(user.name?.toString()).toBe(
      "Jose Francisco Rodrigues Francisco Rodrigues Maria",
    );
  });

  test("a name that fits is kept as is", async () => {
    stubCreate();

    const user: User = await UserService.createByEmail({
      email: new Email("new.member@example.com"),
      name: new Name("New Member"),
      props: { isRoot: true },
    });

    expect(user.name?.toString()).toBe("New Member");
  });
});
