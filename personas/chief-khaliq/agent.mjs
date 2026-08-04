import { defineAgent, draftFile, encodeSegment, writeJsonFile } from "@agentworkforce/runtime";
import { CHIEF_CONTEXT, CHIEF_CONTEXT_TEXT } from "./context.generated.mjs";

const EXPECTED_AGENT = "chief-khaliq";
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_REPLY_LENGTH = 32_000;
const TELEGRAM_MAX_REPLY_LENGTH = 4_096;
const WRITEBACK_TIMEOUT_MS = 12_000;
const WRITEBACK_HARD_TIMEOUT_MS = 15_000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstRecord(...values) {
  return values.find(isRecord);
}

function eventPayload(expanded) {
  const data = isRecord(expanded) ? expanded.data : undefined;
  const root = isRecord(data) ? data : {};
  return firstRecord(root.payload, root.resource, root.event, root) ?? {};
}

function safeEventToken(value) {
  return String(value).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 96) || "event";
}

function isBotSlackPayload(payload) {
  return Boolean(
    stringValue(payload.bot_id) ||
      isRecord(payload.bot_profile) ||
      payload.subtype === "bot_message" ||
      payload.is_bot === true,
  );
}

function normalizeSlack(event, expanded) {
  const root = eventPayload(expanded);
  const payload = firstRecord(root.slack, root.event, root.message, root) ?? {};
  if (isBotSlackPayload(payload)) return null;
  const text = stringValue(payload.text);
  const channelId = stringValue(event.channel) ?? stringValue(payload.channel) ?? stringValue(payload.channel_id);
  const messageId =
    stringValue(event.messageId) ?? stringValue(payload.ts) ?? stringValue(payload.event_ts);
  const threadId =
    stringValue(event.threadId) ?? stringValue(payload.thread_ts) ?? messageId;
  if (
    !text ||
    !/<@[A-Z0-9]{2,}>/i.test(text) ||
    !channelId ||
    !messageId ||
    !threadId ||
    text.length > MAX_MESSAGE_LENGTH
  ) return null;
  return {
    surface: "slack",
    text: text.trim(),
    senderId: stringValue(payload.user),
    channelId,
    messageId,
    threadId,
    eventId: event.id,
  };
}

function normalizeTelegram(event, expanded) {
  const root = eventPayload(expanded);
  const telegram = firstRecord(root.telegram, root.message, root) ?? {};
  const rawMessage = firstRecord(root.message, telegram.raw?.message, telegram.raw) ?? {};
  const from = firstRecord(telegram.from, rawMessage.from) ?? {};
  if (from.is_bot === true || telegram.isBot === true) return null;
  const text = stringValue(telegram.text) ?? stringValue(rawMessage.text);
  const chatId =
    stringValue(telegram.chatId) ?? stringValue(telegram.chat_id) ?? stringValue(rawMessage.chat?.id);
  const messageId =
    stringValue(telegram.messageId) ?? stringValue(telegram.message_id) ?? stringValue(rawMessage.message_id);
  if (!text || !chatId || !messageId || text.length > MAX_MESSAGE_LENGTH) return null;
  return {
    surface: "telegram",
    text: text.trim(),
    senderId: stringValue(telegram.fromUserId) ?? stringValue(from.id),
    channelId: chatId,
    messageId,
    threadId: stringValue(telegram.messageThreadId) ?? stringValue(rawMessage.message_thread_id),
    eventId: event.id,
  };
}

export function normalizeIncomingMessage(event, expanded) {
  if (!isRecord(event) || !stringValue(event.id) || !isRecord(event.resource)) return null;
  if (event.type === "slack.message.created" && event.resource.provider === "slack") {
    return normalizeSlack(event, expanded);
  }
  if (event.type === "telegram.message" && event.resource.provider === "telegram") {
    return normalizeTelegram(event, expanded);
  }
  return null;
}

function relayfileClient(ctx) {
  return {
    workspaceCwd: ctx.sandbox.cwd,
    workspaceId: ctx.workspaceId,
    writebackTimeoutMs: WRITEBACK_TIMEOUT_MS,
  };
}

function withHardTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function replyForSurface(surface, output) {
  const reply = output.trim();
  if (surface !== "telegram") return reply.slice(0, MAX_REPLY_LENGTH);
  let end = 0;
  for (const character of reply) {
    if (end + character.length > TELEGRAM_MAX_REPLY_LENGTH) break;
    end += character.length;
  }
  return reply.slice(0, end);
}

export function writebackRequestFor(message, reply, workspaceId) {
  const idempotencyKey = `${EXPECTED_AGENT}:${workspaceId}:${message.surface}:${message.eventId}`;
  if (message.surface === "slack") {
    return {
      provider: "slack",
      operation: "reply",
      path: `/slack/channels/${encodeSegment(message.channelId)}/messages/${encodeSegment(message.threadId)}/replies/${draftFile(`chief-${safeEventToken(message.eventId)}`)}`,
      body: { text: reply, thread_ts: message.threadId, idempotencyKey },
    };
  }
  return {
    provider: "telegram",
    operation: "send-message",
    path: `/telegram/chats/${encodeSegment(message.channelId)}/messages/${draftFile(`chief-${safeEventToken(message.eventId)}`)}`,
    body: { text: reply, reply_to_message_id: message.messageId, idempotencyKey },
  };
}

function renderPrompt(message) {
  return [
    "Answer the customer message as chief-khaliq.",
    "Use only the allowlisted, read-only context below. Do not claim live access or action you do not have.",
    "Do not merge, deploy, dispatch Factory work, activate Sage/NightCTO wiring, or access another principal.",
    `Reply for originating surface: ${message.surface}. Keep it concise and do not include transport metadata.`,
    "",
    CHIEF_CONTEXT_TEXT,
    "",
    "# Customer message",
    message.text,
  ].join("\n");
}

export function createChiefHandler({ writeJson = writeJsonFile } = {}) {
  return async function chiefHandler(ctx, event) {
    if (
      ctx.persona?.id !== EXPECTED_AGENT ||
      ctx.agentName !== EXPECTED_AGENT ||
      CHIEF_CONTEXT.tenant !== "khaliq" ||
      CHIEF_CONTEXT.agent !== EXPECTED_AGENT
    ) {
      ctx.log("error", "chief tenant boundary rejected runtime context", {
        personaId: ctx.persona?.id,
        agentName: ctx.agentName,
      });
      return;
    }

    const expanded = await event.expand("full");
    const message = normalizeIncomingMessage(event, expanded);
    if (!message) {
      ctx.log("warn", "chief ignored malformed or untrusted surface event", {
        eventId: event.id,
        type: event.type,
        provider: event.resource?.provider,
      });
      return;
    }

    const result = await ctx.harness.run({ prompt: renderPrompt(message) });
    if (result.exitCode !== 0) {
      throw new Error(`chief harness failed with exit code ${result.exitCode}`);
    }
    const reply = replyForSurface(message.surface, result.output);
    if (!reply) {
      ctx.log("info", "chief produced no customer-visible reply", { eventId: event.id });
      return;
    }

    const request = writebackRequestFor(message, reply, ctx.workspaceId);
    await withHardTimeout(
      writeJson(
        relayfileClient(ctx),
        request.provider,
        request.operation,
        request.path,
        request.body,
      ),
      WRITEBACK_HARD_TIMEOUT_MS,
      `${request.provider} reply writeback`,
    );
    ctx.log("info", "chief replied on originating customer surface", {
      eventId: event.id,
      surface: message.surface,
    });
  };
}

export const chiefHandler = createChiefHandler();

export default defineAgent({
  triggers: {
    slack: [{ on: "message.created", match: "@mention" }],
    telegram: [{ on: "message" }],
  },
  handler: chiefHandler,
});
