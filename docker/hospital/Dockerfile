# syntax=docker/dockerfile:1
# Next server: Cookie/BFF/nonce CSP requires a server, never static export.
FROM node:26-trixie-slim AS base
WORKDIR /app

FROM base AS dev
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS build
# Next type-checks the real-API test fixtures, which import the API source.
COPY services/api/package*.json /repo/services/api/
RUN npm ci --prefix /repo/services/api --ignore-scripts
COPY services/api/src /repo/services/api/src
WORKDIR /repo/apps/hospital
COPY apps/hospital/package*.json ./
RUN npm ci
COPY apps/hospital ./
# Public client settings only. Never pass a service account or debug token here.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_APP_CHECK_SITE_KEY
ENV NEXT_PUBLIC_USE_FIREBASE_EMULATOR=false
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_APP_CHECK_SITE_KEY=$NEXT_PUBLIC_APP_CHECK_SITE_KEY
RUN npm run build

FROM base AS prod
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
COPY --from=build --chown=node:node /repo/apps/hospital/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/hospital/.next/static ./.next/static
COPY --from=build --chown=node:node /repo/apps/hospital/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
