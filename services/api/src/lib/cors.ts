import type { FastifyInstance } from "fastify";

const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const HEADERS = ["authorization", "content-type", "x-firebase-appcheck", "idempotency-key", "x-request-id"];

/** CORS はブラウザの読み取り制限であり、API の認証・認可の代わりではない。 */
export function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  app.addHook("onSend", async (_req, reply) => {
    const current = reply.getHeader("vary");
    const vary = (Array.isArray(current) ? current.join(",") : String(current ?? ""))
      .split(",").map((value) => value.trim()).filter(Boolean);
    if (!vary.includes("*")) {
      for (const name of ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]) {
        if (!vary.some((value) => value.toLowerCase() === name.toLowerCase())) vary.push(name);
      }
      void reply.header("Vary", vary.join(", "));
    }
  });
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    const allowedOrigin = typeof origin === "string" && origins.includes(origin);

    if (req.method === "OPTIONS") {
      const method = req.headers["access-control-request-method"];
      const requestedHeaders = req.headers["access-control-request-headers"];
      const headers = typeof requestedHeaders === "string"
        ? requestedHeaders.split(",").map((header) => header.trim().toLowerCase())
        : [];
      if (!allowedOrigin || typeof method !== "string" || !METHODS.includes(method) ||
          (requestedHeaders !== undefined && typeof requestedHeaders !== "string") ||
          headers.some((header) => !HEADERS.includes(header))) {
        return reply.code(403).send();
      }
      return reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Allow-Methods", METHODS.join(", "))
        .header("Access-Control-Allow-Headers", HEADERS.join(", "))
        .code(204).send();
    }

    if (allowedOrigin && METHODS.includes(req.method)) {
      void reply.header("Access-Control-Allow-Origin", origin);
    }
  });
}
