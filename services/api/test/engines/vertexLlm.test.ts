import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { QuestionGenInput } from "../../src/deps.js";
import { ErrorCodes, ApiError, sendError } from "../../src/lib/errors.js";
import { VertexAiLlmAdapter } from "../../src/engines/vertexLlm.js";

const input: QuestionGenInput = {
  symptomText: "合成症状テキストのみ",
  bodyLocations: ["synthetic-location-a", "synthetic-location-b"],
  locale: "ja-JP",
  answers: [],
  askedTopics: [],
  remainingTopics: ["onset_timing"],
  maxQuestions: 1,
};

function adapter(): VertexAiLlmAdapter {
  return new VertexAiLlmAdapter({
    // 明らかなテスト用ダミー。実credential・実GCPへ接続しない。
    apiKey: "not-a-real-key-for-tests",
    model: "synthetic-test-model",
    location: "us-central1",
    projectId: "synthetic-test-project",
    timeoutMs: 1000,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VertexAiLlmAdapter (synthetic fetch only)", () => {
  it("症状文と身体部位を独立した入力フィールドとして送信し、応答を読む", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      questions: [
                        {
                          questionText: "合成質問ですか？",
                          topic: "onset_timing",
                          options: [
                            { code: "YES", label: "はい" },
                            { code: "NO", label: "いいえ" },
                          ],
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter().generateQuestions(input);

    expect(result.questions[0]?.topic).toBe("onset_timing");
    expect(result.modelVersion).toBe("synthetic-test-model/us-central1");
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe("POST");
    const body = JSON.parse(String(request?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const prompt = body.contents[0]?.parts[0]?.text;
    expect(prompt).toBeDefined();
    const marker = "入力(JSON):\n";
    const payload = JSON.parse(prompt!.split(marker)[1]!.split("\n\n")[0]!) as {
      symptomText: string;
      bodyLocations: string[];
    };
    expect(payload.symptomText).toBe("合成症状テキストのみ");
    expect(payload.bodyLocations).toEqual([
      "synthetic-location-a",
      "synthetic-location-b",
    ]);
  });

  it.each([400, 401, 403, 404, 429, 503])("HTTP %iを安全なUPSTREAM_UNAVAILABLEへ変換し診断用statusを保持する", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic failure", { status })),
    );

    await expect(adapter().generateQuestions(input)).rejects.toMatchObject({
      statusCode: 502,
      code: ErrorCodes.UPSTREAM_UNAVAILABLE,
      message: "質問生成サービスがエラーを返しました。",
      upstreamStatus: status,
    });
  });

  it("内部ログには上流statusだけを残し、応答本文・キー・URLを含めない", async () => {
    const marker = "SYNTHETIC_PRIVATE_UPSTREAM_BODY";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(marker, { status: 403 })),
    );
    const error = await adapter().generateQuestions(input).catch((caught: unknown) => caught);
    const lines: string[] = [];
    const app = Fastify({ logger: { stream: { write(line: string) { lines.push(line); } } } });
    app.setErrorHandler((err, request, reply) => sendError(request, reply, err));
    app.get("/", async () => { throw error; });
    try {
      app.log.warn({ err: error }, "llm question generation failed; fallback");
      const output = lines.join("");
      const record = JSON.parse(output) as { err: { upstreamStatus: number; statusCode: number } };
      expect(record.err.upstreamStatus).toBe(403);
      expect(record.err.statusCode).toBe(502);
      expect(output).not.toContain(marker);
      expect(output).not.toContain("not-a-real-key-for-tests");
      expect(output).not.toContain("aiplatform.googleapis.com");
      expect(output).not.toContain(input.symptomText);
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe(ErrorCodes.UPSTREAM_UNAVAILABLE);
      expect(response.body).not.toContain("upstreamStatus");
      expect(response.body).not.toContain(marker);
    } finally {
      await app.close();
    }
  });

  it("通信例外の cause に含まれる query key や入力内容をログ可能なエラーへ渡さない", async () => {
    const fakeKey = "SYNTHETIC_QUERY_KEY_DO_NOT_LOG";
    const fakePatientText = "SYNTHETIC_PATIENT_TEXT_DO_NOT_LOG";
    const transportError = new TypeError(
      `fetch failed for https://example.invalid/?key=${fakeKey} ${fakePatientText}`,
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(transportError));

    const error = await adapter().generateQuestions({
      ...input,
      symptomText: fakePatientText,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 502,
      code: ErrorCodes.UPSTREAM_UNAVAILABLE,
      message: "質問生成サービスに接続できません。",
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(fakeKey);
    expect(String(error)).not.toContain(fakePatientText);
  });

  it("モデル応答が不正JSONなら内容をエラーへ含めず拒否する", async () => {
    const privateMarker = "SYNTHETIC_PRIVATE_RESPONSE_MARKER";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ candidates: [{ content: { parts: [{ text: `${privateMarker}{` }] } }] }),
      ),
    );

    const error = await adapter().generateQuestions(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 502,
      code: ErrorCodes.MODEL_SCHEMA_REJECTED,
      message: "質問生成の応答がJSONではありません。",
    });
    expect(String(error)).not.toContain(privateMarker);
  });

  it("JSONだがスキーマ不正な応答も拒否する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ questions: [] }) }] } }],
        }),
      ),
    );

    await expect(adapter().generateQuestions(input)).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCodes.MODEL_SCHEMA_REJECTED,
    });
  });
});
