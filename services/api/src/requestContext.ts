/** リクエスト単位の相関情報。認証基盤の導入後は auth/context.ts へ拡張する。 */
export interface RequestContext {
  requestId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
}
