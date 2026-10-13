/** Translate private native failures into stable codes without exposing error text. */
const gatewayCodes = new Map([
  ["CREDIT_BUDGET_EXHAUSTED", "AI_WEEKLY_CREDITS_EXHAUSTED"],
  ["TOKEN_BUDGET_EXHAUSTED", "AI_WEEKLY_BUDGET_EXHAUSTED"],
  ["REQUEST_BYTES_LIMIT", "MODEL_CONTEXT_LIMIT"],
  ["CONTENT_LIMIT", "MODEL_HISTORY_REJECTED"],
  ["MESSAGE_LIMIT", "MODEL_HISTORY_REJECTED"],
  ["CONTENT_FORMAT", "MODEL_HISTORY_REJECTED"],
  ["MESSAGE_FORMAT", "MODEL_HISTORY_REJECTED"],
  ["THINKING_REPLAY_FORMAT", "MODEL_HISTORY_REJECTED"],
  ["TOOL_FORMAT", "MODEL_HISTORY_REJECTED"],
  ["TEXT_ONLY", "MODEL_HISTORY_REJECTED"],
  ["PROVIDER_HTTP_429", "MODEL_RATE_LIMITED"],
  ["PROVIDER_HTTP_400", "MODEL_REQUEST_REJECTED"],
  ["PROVIDER_HTTP_413", "MODEL_CONTEXT_LIMIT"],
  ["PROVIDER_HTTP_422", "MODEL_REQUEST_REJECTED"],
  ["PROVIDER_HTTP_401", "AI_UNAVAILABLE"],
  ["PROVIDER_HTTP_403", "AI_UNAVAILABLE"],
  ["PROVIDER_HTTP_500", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_HTTP_502", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_HTTP_503", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_HTTP_504", "MODEL_CONNECTION_FAILED"],
  ["GATEWAY_REQUEST_FAILED", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_STREAM_ERROR", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_STREAM_INCOMPLETE", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_STREAM_INVALID", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_BODY_MISSING", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_BYTES_LIMIT", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_FRAME_LIMIT", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_USAGE_INVALID", "MODEL_CONNECTION_FAILED"],
  ["PROVIDER_INPUT_EXCEEDS_ENVELOPE", "AI_UNAVAILABLE"],
  ["PROVIDER_USAGE_EXCEEDS_ENVELOPE", "AI_UNAVAILABLE"],
  ["UNAUTHORIZED", "AI_UNAVAILABLE"],
  ["CREDENTIAL_SCOPE", "AI_UNAVAILABLE"],
]);
export function classifyRunFailure(value) {
  if (value == null || value === "") return null;
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "";
  const gateway = /^School gateway: ([A-Z][A-Z0-9_]+)$/.exec(message);
  // The pinned SSE parser reports gateway_error.message as the bare code,
  // whereas HTTP rejections are wrapped by our adapter.
  const reason = gateway?.[1] ?? message;
  if (gatewayCodes.has(reason))
    return { code: gatewayCodes.get(reason), reason };
  if (message === "School model request exceeds 512 KiB")
    return { code: "MODEL_CONTEXT_LIMIT", reason: "REQUEST_BYTES_LIMIT" };
  if (message === "SESSION_HISTORY_LIMIT: create a new independent session")
    return { code: "HISTORY_LIMIT", reason: "SESSION_HISTORY_LIMIT" };
  if (
    message === "School model gateway transport failed" ||
    message === "Provider model discovery unavailable"
  )
    return { code: "MODEL_CONNECTION_FAILED", reason: "MODEL_TRANSPORT" };
  return { code: "MODEL_RUN_FAILED", reason: "UNCLASSIFIED" };
}

/** An RPC envelope can fail before session/prompt, including provider discovery. */
export function classifyRpcFailure(value) {
  const failure = classifyRunFailure(
    typeof value?.message === "string" ? value.message : null,
  );
  return failure && failure.reason !== "UNCLASSIFIED"
    ? failure
    : { code: "HARNESS_REQUEST_FAILED", reason: "UNCLASSIFIED_RPC" };
}
