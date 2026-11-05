import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { makeDatabase, makeDatabaseWithUrl, makeUser, enqueueTask } from "./helpers.js";
import { createConversation, getConversation, listTasks, getTask } from "../src/db/repos.js";

test("tenant isolation: one organisation cannot read or write another's rows", async () => {
  const database = await makeDatabase();
  try {
    const a = await makeUser(database, "a@example.com");
    const b = await makeUser(database, "b@example.com");
    assert.notEqual(a.user.orgId, b.user.orgId);

    const taskA = await enqueueTask(database, a.user.orgId, a.user.id, {
      steps: [{ title: "one", kind: "noop" }],
    });

    const seenByB = await database.withTenant(b.user.orgId, b.user.id, async (conn) => ({
      list: await listTasks(conn, b.user.orgId, b.user.id),
      direct: await getTask(conn, taskA.id),
    }));
    assert.equal(seenByB.list.length, 0);
    assert.equal(seenByB.direct, null);

    // A write that names the other tenant is refused by the policy's WITH CHECK.
    await assert.rejects(
      database.withTenant(b.user.orgId, b.user.id, (conn) =>
        createConversation(conn, {
          orgId: a.user.orgId,
          userId: a.user.id,
          title: "smuggled",
        }),
      ),
      /row-level security|policy/i,
    );

    const seenByA = await database.withTenant(a.user.orgId, a.user.id, (conn) =>
      listTasks(conn, a.user.orgId, a.user.id),
    );
    assert.equal(seenByA.length, 1);
    assert.equal(seenByA[0]!.id, taskA.id);
  } finally {
    await database.close();
  }
});

test("tenant tables deny all rows on a connection with no tenant context", async () => {
  const { database, connectionString } = await makeDatabaseWithUrl();
  try {
    const a = await makeUser(database, "c@example.com");
    await enqueueTask(database, a.user.orgId, a.user.id, {
      steps: [{ title: "one", kind: "noop" }],
    });

    // A fresh connection has never had set_config called on it.
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("SET ROLE talisman_app");
      const diagnostics = await client.query(
        "SELECT current_user AS current_user, current_setting('talisman.org_id', true) AS context",
      );
      assert.equal(diagnostics.rows[0]!.current_user, "talisman_app");
      assert.equal(diagnostics.rows[0]!.context, null);
      const rows = await client.query("SELECT id FROM tasks");
      assert.equal(rows.rows.length, 0);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
      await pool.end();
    }

    // Note: a superuser connection bypasses RLS even with FORCE ROW LEVEL SECURITY.
    // That is why tenant work always switches to the non-superuser app role; direct
    // superuser queries are reserved for auth tables and must never read tenant data.
  } finally {
    await database.close();
  }
});

test("conversations are scoped to their owner within an organisation", async () => {
  const database = await makeDatabase();
  try {
    const a = await makeUser(database, "d@example.com");
    const b = await makeUser(database, "e@example.com");
    // Same organisation, second user.
    await database.driver.query(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'member')",
      [a.user.orgId, b.user.id],
    );
    const conversation = await database.withTenant(a.user.orgId, a.user.id, (conn) =>
      createConversation(conn, { orgId: a.user.orgId, userId: a.user.id, title: "private" }),
    );
    const visible = await database.withTenant(a.user.orgId, b.user.id, (conn) =>
      getConversation(conn, conversation.id, b.user.id),
    );
    assert.equal(visible, null);
  } finally {
    await database.close();
  }
});
