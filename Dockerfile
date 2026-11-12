# Resolve this tag to a reviewed digest in the final release manifest.
ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build
RUN node scripts/prepare-runtime.mjs

# Local certification only. Never publish or deploy this source/test image.
FROM build AS verification
CMD ["node", "scripts/check-local-linux.mjs"]

FROM ${NODE_BASE_IMAGE} AS runtime
LABEL io.warthog.deletion-journal="v1"
# The standalone server uses node directly; the build-only npm CLI carries its
# own dependency tree and is unnecessary in the shipped runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# The web process never administers OS users or mounts filesystems. Remove the
# base image's setuid/setgid privilege transitions before running as node.
RUN find /usr/bin /usr/sbin -type f -perm /6000 -exec chmod a-s {} +
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/.runtime/ ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
