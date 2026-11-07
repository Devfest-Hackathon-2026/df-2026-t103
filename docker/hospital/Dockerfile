# syntax=docker/dockerfile:1
# apps/hospital（Next.js 病院ポータル）用。devはソースをバインドマウントし、
# コンテナ起動時の `npm install && npm run dev` に依存を任せるため COPYしない。
# prod は実装追加後に npm scripts (build/start) を定義すること。

FROM node:22-trixie-slim AS base
WORKDIR /app

FROM base AS dev
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS build
COPY apps/hospital/package*.json ./
RUN npm install
COPY apps/hospital ./
RUN npm run build

FROM base AS prod
ENV NODE_ENV=production
COPY apps/hospital/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/.next ./.next
COPY apps/hospital/public ./public
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
