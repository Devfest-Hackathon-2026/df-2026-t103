import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionGenInput } from "../../src/deps.js";
import { ErrorCodes, ApiError } from "../../src/lib/errors.js";
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

  it("HTTP failureを安全なUPSTREAM_UNAVAILABLEへ変換する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic failure", { status: 503 })),
    );

    await expect(adapter().generateQuestions(input)).rejects.toMatchObject({
      statusCode: 502,
      code: ErrorCodes.UPSTREAM_UNAVAILABLE,
      message: "質問生成サービスがエラーを返しました。",
    });
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
