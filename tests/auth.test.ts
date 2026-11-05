import test from "node:test";
import assert from "node:assert/strict";
import { makeDatabase } from "./helpers.js";
import { AuthService } from "../src/auth/service.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

test("password hashing is salted and verifiable", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("signup, login, session lookup and logout", async () => {
  const database = await makeDatabase();
  try {
    const auth = new AuthService(database, "a".repeat(32));
    const created = await auth.signup({
      email: "zoe@example.com",
      password: "a long enough password",
      name: "Zoe",
      orgName: "Zoe Labs",
    });
    assert.equal(created.session.user.email, "zoe@example.com");
    assert.equal(created.session.user.role, "owner");

    const session = await auth.authenticate(created.token);
    assert.equal(session?.user.id, created.session.user.id);
    assert.equal(await auth.authenticate("bogus"), null);

    const login = await auth.login("ZOE@example.com", "a long enough password");
    assert.equal(login.session.user.id, created.session.user.id);
    assert.ok(login.token !== created.token);

    await auth.logout(login.token);
    assert.equal(await auth.authenticate(login.token), null);
    assert.notEqual(await auth.authenticate(created.token), null);

    await assert.rejects(
      auth.login("zoe@example.com", "incorrect password"),
      /Email or password is incorrect/,
    );
    await assert.rejects(
      auth.signup({ email: "zoe@example.com", password: "another password", orgName: "Dup" }),
      /already exists/,
    );
  } finally {
    await database.close();
  }
});

test("short passwords are rejected", async () => {
  const database = await makeDatabase();
  try {
    const auth = new AuthService(database, "b".repeat(32));
    await assert.rejects(
      auth.signup({ email: "short@example.com", password: "short", orgName: "X" }),
      /at least 12/,
    );
  } finally {
    await database.close();
  }
});
