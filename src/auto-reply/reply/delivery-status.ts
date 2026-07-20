// Delivery-status audit model for source-visible reply completion.
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

export type DeliveryStatusFinalReplyVisibility =
  | "automatic_visible"
  | "message_tool_visible"
  | "private_suppressed"
  | "intentional_silence"
  | "none";

export type DeliveryStatusCompletionReceipt =
  | "automatic_receipt"
  | "message_tool_receipt"
  | "not_required"
  | "missing";

export type DeliveryStatusMessageToolSends = {
  attempted: number;
  completed: number;
};

export type DeliveryStatus = {
  source_delivery_mode: SourceReplyDeliveryMode | "unknown";
  visible_delivery_required: boolean;
  message_tool_sends: DeliveryStatusMessageToolSends;
  final_reply_visibility: DeliveryStatusFinalReplyVisibility;
  completion_receipt: DeliveryStatusCompletionReceipt;
  delivery_suppression_reason?: string;
  missing_receipt: boolean;
};

export function summarizeMessageToolSends(params: {
  toolCallIds: Iterable<string>;
  completedToolCallIds: Iterable<string>;
}): DeliveryStatusMessageToolSends {
  return {
    attempted: Array.from(params.toolCallIds).filter((id) => id.trim()).length,
    completed: Array.from(params.completedToolCallIds).filter((id) => id.trim()).length,
  };
}

export function buildDeliveryStatus(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sendPolicyDenied?: boolean;
  observedReplyDelivery?: boolean;
  queuedFinal?: boolean;
  finalPayloadCount?: number;
  privateFinalTextPresent?: boolean;
  messageToolSends?: Partial<DeliveryStatusMessageToolSends>;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
}): DeliveryStatus {
  const sourceDeliveryMode = params.sourceReplyDeliveryMode ?? "unknown";
  const messageToolSends = {
    attempted: Math.max(0, params.messageToolSends?.attempted ?? 0),
    completed: Math.max(0, params.messageToolSends?.completed ?? 0),
  };
  const observedReplyDelivery = params.observedReplyDelivery === true;
  const automaticDelivery = params.queuedFinal === true;
  const intentionallySilent =
    (params.silentExpected === true || params.allowEmptyAssistantReplyAsSilent === true) &&
    !observedReplyDelivery &&
    !automaticDelivery &&
    !params.privateFinalTextPresent &&
    (params.finalPayloadCount ?? 0) === 0;
  const visibleDeliveryRequired =
    !intentionallySilent &&
    params.sendPolicyDenied !== true &&
    params.sourceReplyDeliveryMode === "message_tool_only";

  const finalReplyVisibility: DeliveryStatusFinalReplyVisibility = automaticDelivery
    ? "automatic_visible"
    : observedReplyDelivery
      ? "message_tool_visible"
      : intentionallySilent
        ? "intentional_silence"
        : params.privateFinalTextPresent || (params.finalPayloadCount ?? 0) > 0
          ? "private_suppressed"
          : "none";

  const completionReceipt: DeliveryStatusCompletionReceipt = automaticDelivery
    ? "automatic_receipt"
    : observedReplyDelivery || messageToolSends.completed > 0
      ? "message_tool_receipt"
      : !visibleDeliveryRequired
        ? "not_required"
        : "missing";

  const status: DeliveryStatus = {
    source_delivery_mode: sourceDeliveryMode,
    visible_delivery_required: visibleDeliveryRequired,
    message_tool_sends: messageToolSends,
    final_reply_visibility: finalReplyVisibility,
    completion_receipt: completionReceipt,
    missing_receipt: completionReceipt === "missing",
  };

  if (params.sendPolicyDenied === true) {
    status.delivery_suppression_reason = "sendPolicy: deny";
  } else if (params.sourceReplyDeliveryMode === "message_tool_only") {
    status.delivery_suppression_reason = "sourceReplyDeliveryMode: message_tool_only";
  }

  return status;
}
