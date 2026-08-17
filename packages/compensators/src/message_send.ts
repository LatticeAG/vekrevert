/** C4 message send: Slack/Discord/Telegram retract; email is an explicit T4 manual. */

import type { ActionSignature, SignatureMatcher } from "@latticeag/vekrevert-core";

function messageRetract(input: {
  id: string;
  match: SignatureMatcher;
  toolConst: string;
  toolName: string;
  argBinds: ActionSignature["binds"];
  argRefs: Record<string, { $ref: `receipt.bindings.${string}` }>;
  validity_window?: string;
}): ActionSignature {
  return {
    id: input.id,
    match: input.match,
    tier: "T3",
    binds: input.argBinds,
    constants: { delete_tool: input.toolConst },
    permits: [input.toolName],
    compensator: {
      kind: "declarative",
      steps: [
        {
          kind: "mcp_tool_call",
          tool: { $ref: "const.delete_tool" },
          args: input.argRefs,
          expect: { no_error: true },
        },
      ],
      postconditions: [{ step_index: 0, kind: "tool_no_error", expected: true, required: true }],
    },
    leak: "observers",
    cascade_risk: "low",
    reversal_completeness: "partial",
    source: "builtin",
    ...(input.validity_window ? { validity_window: input.validity_window } : {}),
  };
}

export const slackPostMessage: ActionSignature = messageRetract({
  id: "cmp_message_send.slack@1",
  match: { kind: "mcp_tool", tool: "chat.postMessage" },
  toolConst: "chat.delete",
  toolName: "chat.delete",
  argBinds: {
    channel: { from: "result.$.channel", required: true },
    ts: { from: "result.$.ts", required: true },
  },
  argRefs: {
    channel: { $ref: "receipt.bindings.channel" },
    ts: { $ref: "receipt.bindings.ts" },
  },
});

export const discordCreateMessage: ActionSignature = {
  id: "cmp_message_send.discord@1",
  match: { kind: "mcp_tool", tool: "discord.createMessage" },
  tier: "T3",
  binds: {
    channel_id: { from: "result.$.channel_id", required: true },
    id: { from: "result.$.id", required: true },
    resource_url: { from: "result.$.url", required: false },
  },
  constants: { delete_tool: "channels.deleteMessage" },
  permits: ["channels.deleteMessage"],
  compensator: {
    kind: "declarative",
    steps: [
      {
        kind: "mcp_tool_call",
        tool: { $ref: "const.delete_tool" },
        args: {
          channel_id: { $ref: "receipt.bindings.channel_id" },
          id: { $ref: "receipt.bindings.id" },
        },
        expect: { no_error: true },
      },
    ],
    postconditions: [{ step_index: 0, kind: "tool_no_error", expected: true, required: true }],
  },
  leak: "observers",
  cascade_risk: "low",
  reversal_completeness: "partial",
  source: "builtin",
};

export const telegramSendMessage: ActionSignature = messageRetract({
  id: "cmp_message_send.telegram@1",
  match: { kind: "mcp_tool", tool: "telegram.sendMessage" },
  toolConst: "deleteMessage",
  toolName: "deleteMessage",
  argBinds: {
    chat_id: { from: "result.$.chat_id", required: true },
    message_id: { from: "result.$.message_id", required: true },
  },
  argRefs: {
    chat_id: { $ref: "receipt.bindings.chat_id" },
    message_id: { $ref: "receipt.bindings.message_id" },
  },
  validity_window: "P2D",
});

function emailManual(id: string, match: SignatureMatcher): ActionSignature {
  return {
    id,
    match,
    tier: "T4",
    binds: {},
    compensator: {
      kind: "declarative",
      steps: [
        {
          kind: "manual",
          instructions: "Contact the recipient. Sent email cannot be unsent.",
          suggested_actions: ["contact_recipient"],
        },
      ],
    },
    leak: "observers",
    cascade_risk: "low",
    reversal_completeness: "partial",
    source: "builtin",
  };
}

export const emailManuals: ActionSignature[] = [
  emailManual("cmp_message_send.smtp@1", { kind: "mcp_tool", tool: "smtp.send" }),
  emailManual("cmp_message_send.resend@1", { kind: "sdk_fn", module: "resend.emails", fn: "send" }),
  emailManual("cmp_message_send.ses@1", { kind: "sdk_fn", module: "ses", fn: "sendEmail" }),
  emailManual("cmp_message_send.postmark@1", { kind: "mcp_tool", tool: "postmark.sendEmail" }),
];

export const messageSend: ActionSignature[] = [
  slackPostMessage,
  discordCreateMessage,
  telegramSendMessage,
  ...emailManuals,
];
