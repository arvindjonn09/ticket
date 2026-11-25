FROM r.xmox.nl/mox:v0.0.17@sha256:8889e7b48fdd5b0b07b51dd11a6d06536334ec442652f2ffb1e1df3a9d45074e AS mox

FROM node:24-bookworm-slim AS bootstrap
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=mox /bin/mox /usr/local/bin/mox
COPY infra/mail-oss/init.mjs /init.mjs
ENTRYPOINT ["node", "/init.mjs"]
