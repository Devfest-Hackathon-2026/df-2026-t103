import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Storage as CloudStorage } from "@google-cloud/storage";
import type { Storage } from "firebase-admin/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createStorageGateway } from "../src/storage.js";

// Exercise the actual SDK transport against loopback only: no credentials or
// Firebase/GCS resources. The fixture models an object replaced after discovery.
describe("Storage deletion preconditions", () => {
  let server: Server;
  let gateway: ReturnType<typeof createStorageGateway>;
  let currentGeneration: string | undefined;
  let requests: URL[];

  beforeEach(async () => {
    currentGeneration = "9007199254740993";
    requests = [];
    server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      requests.push(url);
      if (req.method !== "DELETE") {
        res.writeHead(405).end();
        return;
      }
      if (currentGeneration === undefined) {
        res.writeHead(404).end(JSON.stringify({ error: { code: 404, message: "Not found" } }));
        return;
      }
      const expected = url.searchParams.get("ifGenerationMatch");
      if (expected !== null && expected !== currentGeneration) {
        res.writeHead(412).end(JSON.stringify({ error: { code: 412, message: "Generation changed" } }));
        return;
      }
      currentGeneration = undefined;
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = new CloudStorage({
      projectId: "demo-storage-test",
      apiEndpoint: `http://127.0.0.1:${port}`,
      useAuthWithCustomEndpoint: false,
      retryOptions: { autoRetry: false },
    });
    const storage = { bucket: (name: string) => client.bucket(name) } as unknown as Storage;
    gateway = createStorageGateway(storage, loadConfig({
      NODE_ENV: "test", FIREBASE_PROJECT_ID: "storage-config-test",
    }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("deletes the matching generation without numeric precision loss", async () => {
    await gateway.deleteObject("test-bucket", "patient-uploads/test/original", currentGeneration);
    expect(requests[0]!.searchParams.get("ifGenerationMatch")).toBe("9007199254740993");
    expect(currentGeneration).toBeUndefined();
  });

  it("preserves a replacement object and propagates the precondition failure", async () => {
    await expect(gateway.deleteObject("test-bucket", "patient-uploads/test/original", "old-generation"))
      .rejects.toMatchObject({ code: 412 });
    expect(currentGeneration).toBe("9007199254740993");
  });

  it("keeps deletion idempotent when the object is already absent", async () => {
    currentGeneration = undefined;
    await expect(gateway.deleteObject("test-bucket", "patient-uploads/test/original", "123"))
      .resolves.toBeUndefined();
  });

  it("preserves the existing optional-generation contract", async () => {
    await gateway.deleteObject("test-bucket", "patient-uploads/test/original");
    expect(requests[0]!.searchParams.has("ifGenerationMatch")).toBe(false);
    expect(currentGeneration).toBeUndefined();
  });
});
