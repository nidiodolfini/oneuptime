import UserService from "../../../Server/Services/UserService";
import CreateBy from "../../../Server/Types/Database/CreateBy";
import User from "../../../Models/DatabaseModels/User";
import ColumnLength from "../../../Types/Database/ColumnLength";
import Email from "../../../Types/Email";
import Name from "../../../Types/Name";
import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
 * The name an identity provider sends on a person's first sign-in can be
 * longer than an account's name holds (ColumnLength.Name, 50): a directory
 * that writes every given and family name into the `name` claim does it.
 * createByEmail cuts the name to fit, so the account is made and the person
 * signs in, where the create used to be refused with "name length cannot be
 * more than 50 characters". No database: `create` is a stub that hands back
 * what it was given.
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

  test("a name longer than an account's name holds is cut to fit", async () => {
    stubCreate();

    const longName: string =
      "Jose Francisco Rodrigues Francisco Rodrigues Mariano";

    expect(longName.length).toBeGreaterThan(ColumnLength.Name);

    const user: User = await UserService.createByEmail({
      email: new Email("jose.mariano@example.com"),
      name: new Name(longName),
      props: { isRoot: true },
    });

    expect(user.name?.toString()).toBe(
      "Jose Francisco Rodrigues Francisco Rodrigues Maria",
    );
    expect(user.name?.toString().length).toBe(ColumnLength.Name);
  });

  test("a cut that lands on a space leaves no space at the end", async () => {
    stubCreate();

    // The 50th character is the space between "Pinto" and "Mariano".
    const user: User = await UserService.createByEmail({
      email: new Email("maria.pinto@example.com"),
      name: new Name(
        "Maria Aparecida Fernandes de Oliveira Souza Pinto Mariano",
      ),
      props: { isRoot: true },
    });

    expect(user.name?.toString()).toBe(
      "Maria Aparecida Fernandes de Oliveira Souza Pinto",
    );
  });

  test("a name that fits is kept as it is", async () => {
    stubCreate();

    const user: User = await UserService.createByEmail({
      email: new Email("new.member@example.com"),
      name: new Name("New Member"),
      props: { isRoot: true },
    });

    expect(user.name?.toString()).toBe("New Member");
  });

  test("no name leaves the account without one", async () => {
    stubCreate();

    const user: User = await UserService.createByEmail({
      email: new Email("no.name@example.com"),
      name: undefined,
      props: { isRoot: true },
    });

    expect(user.name).toBeUndefined();
  });
});
