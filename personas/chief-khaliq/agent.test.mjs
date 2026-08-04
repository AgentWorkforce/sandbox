import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import agent, {
  createChiefHandler,
  normalizeIncomingMessage,
  replyForSurface,
  writebackRequestFor,
} from "./agent.mjs";

function event({
  id = "delivery-1",
  type,
  provider,
  channel,
  messageId,
  threadId,
  data,
}) {
  return {
    id,
    type,
    resource: { provider },
    ...(channel ? { channel } : {}),
    ...(messageId ? { messageId } : {}),
    ...(threadId ? { threadId } : {}),
    async expand(level) {
      assert.equal(level, "full");
      return { data };
    },
  };
}

function context(overrides = {}) {
  const logs = [];
  let relayReads = 0;
  const ctx = {
    persona: { id: "chief-khaliq" },
    agentName: "chief-khaliq",
    workspaceId: "workspace-khaliq",
    sandbox: { cwd: "/sandbox" },
    agent: { id: "agent-1", deployedName: "chief-khaliq", spawnedByAgentId: null },
    harness: {
      async run() {
        return { output: "A concise answer.", exitCode: 0, durationMs: 1 };
      },
    },
    log(level, message, attrs) {
      logs.push({ level, message, attrs });
    },
    get relay() {
      relayReads += 1;
      throw new Error("Relay must not be used for customer replies");
    },
    ...overrides,
  };
  return { ctx, logs, relayReads: () => relayReads };
}

test("cloud persona has static schema-backed Slack and Telegram listeners", async () => {
  const persona = JSON.parse(await readFile(new URL("./persona.json", import.meta.url), "utf8"));
  assert.equal(persona.id, "chief-khaliq");
  assert.equal(persona.cloud, true);
  assert.equal(persona.onEvent, "./agent.mjs");
  assert.equal(persona.sandbox, true);
  assert.deepEqual(Object.keys(persona.integrations).sort(), ["slack", "telegram"]);
  assert.equal(persona.relay, undefined);
  assert.deepEqual(agent.triggers, {
    slack: [{ on: "message.created", match: "@mention" }],
    telegram: [{ on: "message" }],
  });
  assert.equal(typeof agent.handler, "function");
});

test("normalizes a Slack app mention and rejects bot or spoofed payloads", () => {
  const incoming = event({
    type: "slack.message.created",
    provider: "slack",
    channel: "C123",
    data: { event: { text: "<@CHIEF> what matters?", user: "U1", ts: "171.2" } },
  });
  assert.deepEqual(normalizeIncomingMessage(incoming, { data: incoming.expand ? { event: { text: "<@CHIEF> what matters?", user: "U1", ts: "171.2" } } : {} }), {
    surface: "slack",
    text: "<@CHIEF> what matters?",
    senderId: "U1",
    channelId: "C123",
    messageId: "171.2",
    threadId: "171.2",
    eventId: "delivery-1",
  });
  const bot = { ...incoming };
  assert.equal(
    normalizeIncomingMessage(bot, { data: { event: { text: "loop", ts: "1", bot_id: "B1" } } }),
    null,
  );
  assert.equal(
    normalizeIncomingMessage({ ...incoming, resource: { provider: "telegram" } }, { data: {} }),
    null,
  );
});

test("ordinary Slack messages are ignored even if upstream match filtering regresses", () => {
  const ordinary = event({
    type: "slack.message.created",
    provider: "slack",
    channel: "C123",
    data: { event: { text: "what matters?", user: "U1", ts: "171.2" } },
  });
  assert.equal(
    normalizeIncomingMessage(ordinary, {
      data: { event: { text: "what matters?", user: "U1", ts: "171.2" } },
    }),
    null,
  );
});

test("normalizes the Cloud Telegram webhook payload and rejects malformed messages", () => {
  const incoming = event({
    type: "telegram.message",
    provider: "telegram",
    data: { telegram: { chatId: 123, messageId: 7, text: "status?", fromUserId: 42 } },
  });
  assert.deepEqual(
    normalizeIncomingMessage(incoming, {
      data: { telegram: { chatId: 123, messageId: 7, text: "status?", fromUserId: 42 } },
    }),
    {
      surface: "telegram",
      text: "status?",
      senderId: "42",
      channelId: "123",
      messageId: "7",
      threadId: undefined,
      eventId: "delivery-1",
    },
  );
  assert.equal(
    normalizeIncomingMessage(incoming, { data: { telegram: { chatId: 123, messageId: 7 } } }),
    null,
  );
});

test("handler replies once on the originating Slack surface and never Relay", async () => {
  const writes = [];
  const handler = createChiefHandler({
    async writeJson(...args) {
      writes.push(args);
      return { deliveryStatus: "confirmed" };
    },
  });
  const state = context();
  await handler(
    state.ctx,
    event({
      id: "slack-delivery-1",
      type: "slack.message.created",
      provider: "slack",
      channel: "C123",
      data: { event: { text: "<@CHIEF> hello", user: "U1", ts: "171.2", thread_ts: "170.1" } },
    }),
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], "slack");
  assert.equal(writes[0][2], "reply");
  assert.match(writes[0][3], /^\/slack\/channels\/C123\/messages\/170.1\/replies\/chief-slack-delivery-1 /);
  assert.deepEqual(writes[0][4], {
    text: "A concise answer.",
    thread_ts: "170.1",
    idempotencyKey: "chief-khaliq:workspace-khaliq:slack:slack-delivery-1",
  });
  assert.equal(state.relayReads(), 0);
});

test("handler replies to the originating Telegram message", async () => {
  const writes = [];
  const handler = createChiefHandler({
    async writeJson(...args) {
      writes.push(args);
      return { deliveryStatus: "confirmed" };
    },
  });
  const state = context();
  await handler(
    state.ctx,
    event({
      id: "telegram-delivery-1",
      type: "telegram.message",
      provider: "telegram",
      data: { telegram: { chatId: -1001, messageId: 9, text: "hello", fromUserId: 42 } },
    }),
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], "telegram");
  assert.equal(writes[0][2], "send-message");
  assert.match(writes[0][3], /^\/telegram\/chats\/-1001\/messages\/chief-telegram-delivery-1 /);
  assert.deepEqual(writes[0][4], {
    text: "A concise answer.",
    reply_to_message_id: "9",
    idempotencyKey: "chief-khaliq:workspace-khaliq:telegram:telegram-delivery-1",
  });
  assert.equal(state.relayReads(), 0);
});

test("Telegram replies preserve an exact 4,096-character boundary", () => {
  const exactBoundary = "x".repeat(4_096);
  assert.equal(replyForSurface("telegram", exactBoundary), exactBoundary);
});

test("Telegram replies over 4,096 characters are capped without splitting Unicode", () => {
  const overBoundary = `${"x".repeat(4_095)}\u{1F680}extra`;
  const reply = replyForSurface("telegram", overBoundary);
  assert.equal(reply, "x".repeat(4_095));
  assert.ok(reply.length <= 4_096);
  assert.doesNotMatch(reply, /[\uD800-\uDBFF]$/);
});

test("Slack replies retain the existing reply limit", () => {
  const reply = "x".repeat(4_097);
  assert.equal(replyForSurface("slack", reply), reply);
});

test("delivery retries reuse one provider idempotency identity", () => {
  const message = {
    surface: "telegram",
    channelId: "123",
    messageId: "7",
    eventId: "delivery-7",
  };
  const first = writebackRequestFor(message, "answer", "workspace-khaliq");
  const retry = writebackRequestFor(message, "answer", "workspace-khaliq");
  assert.equal(first.body.idempotencyKey, retry.body.idempotencyKey);
  assert.equal(new Set([first.body.idempotencyKey, retry.body.idempotencyKey]).size, 1);
});

test("wrong tenant context, malformed payloads, and unsupported surfaces fail closed", async () => {
  let harnessRuns = 0;
  let writes = 0;
  const handler = createChiefHandler({
    async writeJson() {
      writes += 1;
    },
  });
  const wrongTenant = context({
    persona: { id: "chief-will" },
    harness: {
      async run() {
        harnessRuns += 1;
        return { output: "no", exitCode: 0, durationMs: 1 };
      },
    },
  });
  await handler(
    wrongTenant.ctx,
    event({ type: "slack.message.created", provider: "slack", channel: "C1", data: {} }),
  );
  const supportedTenant = context({
    harness: {
      async run() {
        harnessRuns += 1;
        return { output: "no", exitCode: 0, durationMs: 1 };
      },
    },
  });
  await handler(
    supportedTenant.ctx,
    event({ type: "github.issue.created", provider: "github", data: { text: "spoof" } }),
  );
  assert.equal(harnessRuns, 0);
  assert.equal(writes, 0);
});
