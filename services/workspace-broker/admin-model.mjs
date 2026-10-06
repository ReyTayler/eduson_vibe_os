/** Private root-only administration relay; model capabilities never reach the API. */
import http from "node:http";
import { readFileSync } from "node:fs";
export async function adminModelRequest(path, body) {
  const capability = readFileSync(
    "/var/lib/vibe-os/poc-model/capability",
    "utf8",
  ).trim();
  const raw = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: "/run/vibe-os-model/gateway.sock",
        path,
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + capability,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024)
            req.destroy(new Error("ADMIN_BUDGET_UNAVAILABLE"));
          else chunks.push(chunk);
        });
        res.on("error", () =>
          reject(
            Object.assign(new Error("ADMIN_BUDGET_UNAVAILABLE"), {
              status: 503,
            }),
          ),
        );
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks));
            if (res.statusCode !== 200) {
              const allowed = [
                "GRANT_INPUT_INVALID",
                "GRANT_REQUEST_CONFLICT",
                "GRANT_WINDOW_CHANGED",
                "BUDGET_CLOCK_ROLLBACK",
              ];
              throw Object.assign(
                new Error(
                  allowed.includes(value.error)
                    ? value.error
                    : "ADMIN_BUDGET_UNAVAILABLE",
                ),
                {
                  status: allowed.includes(value.error) ? res.statusCode : 503,
                },
              );
            }
            resolve(value);
          } catch (error) {
            reject(
              error.status
                ? error
                : Object.assign(new Error("ADMIN_BUDGET_UNAVAILABLE"), {
                    status: 503,
                  }),
            );
          }
        });
      },
    );
    req.on("error", () =>
      reject(
        Object.assign(new Error("ADMIN_BUDGET_UNAVAILABLE"), { status: 503 }),
      ),
    );
    req.end(raw);
  });
}
