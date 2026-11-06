import type { PlacesGateway, PlacesSearchParams, PlaceResult } from "../deps.js";

/** APIキー未設定時のスタブ。常に空配列を返す。 */
export class DummyPlacesGateway implements PlacesGateway {
  async searchNearby(_params: PlacesSearchParams): Promise<PlaceResult[]> {
    return [];
  }
}
