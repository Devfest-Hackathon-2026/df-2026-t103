# syntax=docker/dockerfile:1
# services/api（Cloud Run API相当）用。devはソースをバインドマウントし、
# コンテナ起動時の `npm install && npm run dev` に依存を任せるため COPYしない。
# prod は実装追加後に npm scripts (build/start) を定義すること。

FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS dev
ENV NODE_ENV=development
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM base AS prod-deps
ENV NODE_ENV=production
COPY services/api/package*.json ./
RUN npm install --omit=dev

FROM base AS prod
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY services/api ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
