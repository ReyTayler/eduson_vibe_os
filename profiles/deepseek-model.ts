/** Provider-discovered output, constrained atomically by the student's weekly gateway budget. */
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { resolveAdapterOptions } from "@deepseek-ai/dsh-llm-deepseek";
import { readFileSync } from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { serialize, parseSse, translate } from "./deepseek-codec.js";
export const name = "school-deepseek";
export const inject = ["llm"];
export interface Config {
  credentialId: number;
  socketPath: string;
  capabilityFile: string;
}
export const Config: Schema<Config> = Schema.object({
  credentialId: Schema.number().step(1).min(20).max(27).default(20),
  socketPath: Schema.string().default("/model/gateway.sock"),
  capabilityFile: Schema.string().default("/model-capability"),
});
class SchoolDeepSeek extends LlmAdapter {
  private readonly capability: string;
  private discovery?: Promise<LlmResolvedModelInfo>;
  constructor(private readonly config: Config) {
    super();
    this.capability = readFileSync(config.capabilityFile, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(this.capability))
      throw new Error("Invalid model capability");
  }
  private discover(): Promise<LlmResolvedModelInfo> {
    return new Promise((resolve, reject) => {
      const request = http.get(
        {
          socketPath: this.config.socketPath,
          path: "/v1/models",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: "Bearer " + this.capability,
            "X-Vibe-Credential": String(this.config.credentialId),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536)
              request.destroy(new Error("Model metadata overflow"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              if (response.statusCode !== 200)
                throw new Error("Model discovery rejected");
              const payload: unknown = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              );
              if (
                !payload ||
                typeof payload !== "object" ||
                !("models" in payload) ||
                !Array.isArray(payload.models)
              )
                throw new Error("Invalid model metadata");
              const model = payload.models.find(
                (row: unknown) =>
                  row &&
                  typeof row === "object" &&
                  "id" in row &&
                  row.id === "deepseek-flash",
              );
              if (
                !model ||
                !Number.isSafeInteger(model.contextWindow) ||
                model.contextWindow < 1 ||
                !Number.isSafeInteger(model.maxOutputTokens) ||
                model.maxOutputTokens < 1
              )
                throw new Error("Invalid provider token limits");
              resolve({
                provider: "school-deepseek",
                id: "deepseek-flash",
                name: "DeepSeek Flash",
                context: { contextWindow: model.contextWindow },
                defaultMaxTokens: model.maxOutputTokens,
                reasoning: {
                  efforts: ["off", "low", "high", "max"].map((id) => ({
                    id: ReasoningEffortId(id),
                    name: id,
                  })),
                  defaultEffort: ReasoningEffortId("off"),
                },
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
    });
  }
  async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    if (provider !== "school-deepseek" || model !== "deepseek-flash")
      throw new LlmError("School route unavailable", "INVALID_REQUEST");
    if (!this.discovery)
      this.discovery = this.discover().catch(() => {
        this.discovery = undefined;
        throw new LlmError("Provider model discovery unavailable", "TRANSPORT");
      });
    return this.discovery;
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const info = await this.resolveModel(options.provider, options.model);
    const providerMax = info.defaultMaxTokens;
    const contextWindow = info.context?.contextWindow;
    if (!providerMax || !contextWindow)
      throw new LlmError("Provider limits unavailable", "TRANSPORT");
    const connection = resolveAdapterOptions({
      thinking: "enabled",
      reasoningEffort: "off",
      maxTokens: providerMax,
      models: [
        {
          id: "deepseek-flash",
          contextWindow,
          maxTokens: providerMax,
        },
      ],
      retryPolicy: { mode: "normal", maxRetries: 0 },
    });
    const body = JSON.stringify(
      serialize(
        {
          ...options,
          reasoningEffort: options.reasoningEffort ?? ReasoningEffortId("off"),
          maxTokens: providerMax,
        },
        connection,
        options.messages,
        new Map(),
        () => undefined,
      ),
    );
    if (Buffer.byteLength(body) > 524288)
      throw new LlmError(
        "School model request exceeds 512 KiB",
        "INVALID_REQUEST",
      );
    const request = http.request({
      socketPath: this.config.socketPath,
      path: "/v1/messages",
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: "Bearer " + this.capability,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Vibe-Credential": String(this.config.credentialId),
        "X-Vibe-Request-Id": randomUUID(),
      },
    });
    request.end(body);
    let response: http.IncomingMessage | undefined;
    try {
      response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
      });
      if (response.statusCode !== 200) {
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const p of response) {
          n += p.length;
          if (n > 4096)
            throw new LlmError("Gateway error overflow", "TRANSPORT");
          chunks.push(Buffer.from(p));
        }
        let code = "GATEWAY_REJECTED";
        try {
          const decoded: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          if (
            decoded &&
            typeof decoded === "object" &&
            "error" in decoded &&
            typeof decoded.error === "string" &&
            /^[A-Z][A-Z0-9_]+$/.test(decoded.error)
          )
            code = decoded.error;
        } catch (_malformedGatewayError) {
          /* Status remains authoritative. */
        }
        throw new LlmError(
          "School gateway: " + code,
          ["TOKEN_BUDGET_EXHAUSTED", "CREDIT_BUDGET_EXHAUSTED"].includes(code)
            ? "QUOTA"
            : "INVALID_REQUEST",
        );
      }
      const web = Readable.toWeb(response) as ReadableStream<BufferSource>;
      yield* translate(
        parseSse(web, () => {}),
        options.model,
      );
    } catch (error) {
      if (options.signal?.aborted)
        throw new LlmError("School model request cancelled", "ABORTED");
      if (error instanceof LlmError) throw error;
      throw new LlmError("School model gateway transport failed", "TRANSPORT");
    } finally {
      response?.destroy();
      request.destroy();
    }
  }
}
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(["school-deepseek"], new SchoolDeepSeek(config));
}
