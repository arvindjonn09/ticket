FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.34.9
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS api
EXPOSE 4311
USER node
CMD ["pnpm", "--filter", "@astrama/api", "start"]

FROM build AS package-api
RUN pnpm --filter @astrama/api deploy --prod --legacy /runtime
# Prisma's generated client is a build artifact, not an install-time network operation.
RUN mkdir -p /runtime/node_modules/.prisma && cp -a /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/. /runtime/node_modules/.prisma/

FROM node:24-bookworm-slim AS api-production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=package-api --chown=node:node /runtime /app
ENV NODE_ENV=production
USER node
EXPOSE 4311
CMD ["node", "dist/main.js"]

FROM nginx:stable-alpine AS web
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
