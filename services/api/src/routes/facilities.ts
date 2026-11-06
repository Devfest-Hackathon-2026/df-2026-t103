import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import {
  facilityDetailResponseSchema,
  facilitySearchResponseSchema,
  errors,
} from "./apiDocs.js";
import {
  searchNearbyFacilities,
  getFacilityDetail,
} from "../services/facilities.js";

const facilityIdParam = z.object({ facilityId: z.string().min(1).max(200) });

const searchNearbyBodySchema = z.object({
  center: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  radiusMeters: z.number().int().positive().max(50_000).default(5_000),
  limit: z.number().int().min(1).max(20).default(10),
  includeTypes: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(10)
    .default(["hospital", "doctor"]),
});

/**
 * 施設検索 API（API-027/028, FR-H01〜H04）。
 * 症状・PHIは Places に渡さない（02 §8.1）。
 */
export function registerFacilityRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // API-027 近隣施設検索（位置情報同意時のみ利用可）
  typed.post(
    "/v1/facilities/search-nearby",
    {
      config: { access: { tier: "active" } },
      schema: {
        body: searchNearbyBodySchema,
        response: {
          200: facilitySearchResponseSchema,
          ...errors(400, 401, 403, 429, 503),
        },
        tags: ["facilities"],
        summary: "近隣施設検索（Places New + 参加施設マッチング）",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const facilities = await searchNearbyFacilities(deps, {
        latitude: req.body.center.latitude,
        longitude: req.body.center.longitude,
        radiusMeters: req.body.radiusMeters,
        limit: req.body.limit,
        includeTypes: req.body.includeTypes,
      });
      return { facilities };
    },
  );

  // API-028 参加施設詳細
  typed.get(
    "/v1/facilities/:facilityId",
    {
      config: { access: { tier: "active" } },
      schema: {
        params: facilityIdParam,
        response: {
          200: facilityDetailResponseSchema,
          ...errors(401, 403, 404),
        },
        tags: ["facilities"],
        summary: "参加施設詳細取得",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => getFacilityDetail(deps, req.params.facilityId),
  );
}
