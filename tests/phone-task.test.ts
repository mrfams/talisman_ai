import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneTaskTools } from "../src/connectors/phone-task.js";
import type { PhoneDevice } from "../src/db/phone-repos.js";
import type { PhoneService, PublicPhoneApproval } from "../src/phone/service.js";

const context = { signal: new AbortController().signal, callId: "call-1" };

function approval(goal = "Send a greeting to Sam"): PublicPhoneApproval {
  return {
    id: "task-1",
    deviceId: "device-1",
    op: "task",
    args: { goal, max_steps: 12 },
    summary: `Work on ${goal} on Example Phone`,
    status: "approved",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  };
}

test("phone tasks are a generic observe, decide, act loop", async () => {
  const device = {
    id: "device-1",
    orgId: "org-1",
    userId: "user-1",
    name: "Example Phone",
    status: "active",
  } as unknown as PhoneDevice;
  let active: PublicPhoneApproval | null = null;
  const requested: Array<{ goal: string }> = [];
  const actions: Array<Record<string, unknown>> = [];
  let completed = false;

  const service = {
    activeTask: async () => active,
    requestTask: async (
      _orgId: string,
      _userId: string,
      _deviceId: string,
      input: { goal: string },
    ) => {
      requested.push(input);
      return approval(input.goal);
    },
    completeTask: async () => {
      completed = true;
      return approval();
    },
    execute: async (_device: PhoneDevice, op: string) => {
      if (op === "observe") {
        return {
          screen: {
            package: "com.example.app",
            nodes: [
              {
                ref: 1,
                text: "Search",
                clickable: true,
                bounds: { x: 0, y: 0, w: 100, h: 40 },
              },
              {
                ref: 2,
                text: "Message",
                editable: true,
                bounds: { x: 0, y: 100, w: 200, h: 60 },
              },
            ],
          },
          width: 1080,
          height: 2400,
        };
      }
      if (op === "apps") {
        return { apps: [{ package: "com.example.app", label: "Example" }] };
      }
      return {};
    },
    executeApproved: async (
      _device: PhoneDevice,
      _taskId: string,
      args: Record<string, unknown>,
    ) => {
      actions.push(args);
      return { status: "done", result: { ok: true }, error: null };
    },
  } as unknown as PhoneService;

  const tools = phoneTaskTools({
    service,
    device,
    orgId: "org-1",
    userId: "user-1",
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

  const started = (await byName
    .get("phone_task_start")!
    .execute({ goal: "Send a greeting to Sam" }, context)) as {
    status: string;
    task: boolean;
    approval_id: string;
  };
  assert.equal(started.status, "approval_required");
  assert.equal(started.task, true);
  assert.equal(started.approval_id, "task-1");
  assert.deepEqual(requested, [{ goal: "Send a greeting to Sam", maxSteps: 20 }]);

  active = approval();
  const looked = (await byName.get("phone_task_look")!.execute({}, context)) as {
    app: string;
    elements: Array<{ text?: string; ref?: number }>;
  };
  assert.equal(looked.app, "com.example.app");
  assert.equal(looked.elements[0]?.text, "Search");

  const launched = (await byName.get("phone_task_act")!.execute(
    { action: "launch", app: "Example" },
    context,
  )) as { ok: boolean; action: string };
  assert.equal(launched.ok, true);
  assert.equal(launched.action, "open com.example.app");
  assert.deepEqual(actions[0], { action: "launch", package: "com.example.app" });

  await byName.get("phone_task_act")!.execute(
    { action: "tap_text", text: "Search" },
    context,
  );
  assert.deepEqual(actions[1], { action: "tap", x: 50, y: 20 });

  await byName.get("phone_task_act")!.execute(
    { action: "type", text: "Sam" },
    context,
  );
  assert.deepEqual(actions[2], { action: "type", text: "Sam" });

  const listed = (await byName.get("phone_task_update")!.execute(
    {
      summary: "Message Sam",
      items: [
        { title: "Open the app", status: "done" },
        { title: "Send the greeting", status: "pending" },
      ],
    },
    context,
  )) as { items: Array<{ title: string; status: string }> };
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items[0]?.status, "done");

  const finished = (await byName.get("phone_task_done")!.execute(
    {
      summary: "Greeting sent",
      items: [{ title: "Send the greeting", status: "done" }],
    },
    context,
  )) as { status: string; summary: string };
  assert.equal(finished.status, "complete");
  assert.equal(finished.summary, "Greeting sent");
  assert.equal(completed, true);

  assert.equal(tools.some((tool) => tool.definition.name === "phone_plan"), false);
});
