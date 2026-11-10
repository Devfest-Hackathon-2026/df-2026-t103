import type { Deps } from "../deps.js";
import { ApiError } from "../lib/errors.js";
import {
  getFacilityById,
  getFacilitiesByPlaceIds,
  isSyntheticRecipient,
} from "../repos/facilities.js";

export interface FacilitySearchItem {
  source: "places";
  placeId: string;
  displayName: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  primaryType: string | null;
  receivingEnabled: boolean;
  verifiedFacilityId: string | null;
}

export interface FacilityDetail {
  facilityId: string;
  displayName: string;
  formattedAddress: string;
  verificationStatus: string;
  receivingEnabled: boolean;
  syntheticRecipient: boolean;
  syntheticStorageOnly: boolean;
}

export interface SearchNearbyInput {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  limit: number;
  includeTypes: string[];
}

/**
 * 近隣施設を検索し、参加施設マッチング結果を返す（02 §8.2）。
 * 症状・PHI は Places に渡さない。
 */
export async function searchNearbyFacilities(
  deps: Deps,
  input: SearchNearbyInput,
): Promise<FacilitySearchItem[]> {
  const maxCount = Math.min(input.limit, deps.config.placesMaxResults);

  let places;
  try {
    places = await deps.placesGateway.searchNearby({
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      maxResultCount: maxCount,
      includeTypes: input.includeTypes,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.upstreamUnavailable("google_places");
  }

  if (places.length === 0) return [];

  const placeIds = places.map((p) => p.placeId);
  const matched = await getFacilitiesByPlaceIds(deps.db, placeIds);

  const matchMap = new Map<string, { facilityId: string; receivingEnabled: boolean }>();
  for (const f of matched) {
    if (f.placeId && f.verificationStatus === "verified" && f.syntheticDemo !== true && f.syntheticSelfService !== true) {
      matchMap.set(f.placeId, {
        facilityId: f.facilityId,
        receivingEnabled: f.receivingEnabled,
      });
    }
  }

  return places.map((p) => {
    const match = matchMap.get(p.placeId);
    return {
      source: "places" as const,
      placeId: p.placeId,
      displayName: p.displayName,
      formattedAddress: p.formattedAddress,
      lat: p.lat,
      lng: p.lng,
      primaryType: p.primaryType,
      receivingEnabled: match?.receivingEnabled ?? false,
      verifiedFacilityId: match?.facilityId ?? null,
    };
  });
}

/** 参加施設の詳細を返す。存在しなければ 404。 */
export async function getFacilityDetail(
  deps: Deps,
  facilityId: string,
  uid: string,
): Promise<FacilityDetail> {
  const facility = await getFacilityById(deps.db, facilityId);
  if (!facility) throw ApiError.notFound("施設が見つかりません。");
  const patient = await deps.db.doc(`syntheticDemoPatients/${uid}`).get();

  return {
    facilityId: facility.facilityId,
    displayName: facility.displayName,
    formattedAddress: facility.address.formatted ?? "",
    verificationStatus: facility.verificationStatus,
    receivingEnabled: facility.receivingEnabled,
    syntheticStorageOnly: facility.syntheticSelfService === true,
    syntheticRecipient: facility.receivingEnabled === true &&
      (facility.syntheticSelfService !== true || deps.config.syntheticSelfServiceEnabled) &&
      isSyntheticRecipient(facility, uid, facilityId, patient.data()),
  };
}
