import { notFound } from "next/navigation";
import { CatalogClient } from "./catalog-client";

/** 開発者向けデザインシステムカタログ。本番では 404。 */
export default function CatalogPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <CatalogClient />;
}
