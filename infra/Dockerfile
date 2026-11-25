FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.34.9
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/site/package.json apps/site/package.json
COPY apps/operator/package.json apps/operator/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN mkdir -p /exports && chown node:node /exports && chmod 700 /exports

FROM build AS api
EXPOSE 4311
USER node
CMD ["pnpm", "--filter", "@astrama/api", "start"]

FROM build AS site
RUN chown -R node:node /app/apps/site/node_modules
EXPOSE 4320
USER node
CMD ["pnpm", "--filter", "@astrama/site", "dev"]

FROM build AS operator
RUN chown -R node:node /app/apps/operator/node_modules
EXPOSE 4321
USER node
CMD ["pnpm", "--filter", "@astrama/operator", "dev"]

FROM build AS package-api
RUN pnpm --filter @astrama/api deploy --prod --legacy /runtime
# Prisma's generated client is a build artifact, not an install-time network operation.
RUN mkdir -p /runtime/node_modules/.prisma && cp -a /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/. /runtime/node_modules/.prisma/

FROM node:24-bookworm-slim AS api-production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /exports && chown node:node /exports && chmod 700 /exports
COPY --from=package-api --chown=node:node /runtime /app
ENV NODE_ENV=production
USER node
EXPOSE 4311
CMD ["node", "dist/main.js"]

# Keep package/image aligned; 1.65.x Firefox crashes on ARIA reflection (playwright#44135).
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS e2e
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN npm install -g pnpm@10.34.9
WORKDIR /app
COPY --from=build /app /app
CMD ["pnpm", "exec", "playwright", "test", "e2e/hosted-onboarding.spec.ts"]

FROM caddy:2.10-alpine AS web
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY infra/Caddyfile.hosted /etc/caddy/Caddyfile.hosted
COPY --from=build /app/apps/web/dist /srv
COPY --from=build /app/apps/site/dist /public
COPY --from=build /app/apps/operator/dist /operator
EXPOSE 80 443
