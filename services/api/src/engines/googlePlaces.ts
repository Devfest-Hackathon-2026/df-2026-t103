import type { PlacesGateway, PlacesSearchParams, PlaceResult } from "../deps.js";
import { ApiError } from "../lib/errors.js";

const PLACES_API_URL =
  "https://places.googleapis.com/v1/places:searchNearby";

/** FieldMask — 課金SKU最小化のため必要フィールドのみ（02 §8.1）。 */
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType";

interface PlacesApiPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
}

interface PlacesApiResponse {
  places?: PlacesApiPlace[];
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export class GooglePlacesGateway implements PlacesGateway {
  constructor(private readonly apiKey: string) {}

  async searchNearby(params: PlacesSearchParams): Promise<PlaceResult[]> {
    const body = {
      includedTypes: params.includeTypes,
      maxResultCount: params.maxResultCount,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: {
          center: {
            latitude: params.latitude,
            longitude: params.longitude,
          },
          radius: params.radiusMeters,
        },
      },
      languageCode: "ja",
    };

    let res: Response;
    try {
      res = await fetch(PLACES_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw ApiError.upstreamUnavailable("google_places");
    }

    if (!res.ok) {
      throw ApiError.upstreamUnavailable("google_places");
    }

    const data = (await res.json()) as PlacesApiResponse;
    return (data.places ?? []).flatMap((p) => {
      if (!p.id || !p.displayName?.text || !p.location?.latitude || !p.location?.longitude) {
        return [];
      }
      return [
        {
          placeId: p.id,
          displayName: p.displayName.text,
          formattedAddress: p.formattedAddress ?? "",
          lat: round4(p.location.latitude),
          lng: round4(p.location.longitude),
          primaryType: p.primaryType ?? null,
        },
      ];
    });
  }
}
