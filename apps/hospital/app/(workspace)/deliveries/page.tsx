import { DeliveriesClient } from "./deliveries-client";

/** H-003 受信問診一覧（本PRではコンテキスト導線のみ。一覧本体は #84 で実装）。 */
export default function DeliveriesPage() {
  return <DeliveriesClient />;
}
