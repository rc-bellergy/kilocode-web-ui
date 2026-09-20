# syntax=docker/dockerfile:1

# ---- Build stage: install all workspace deps and compile server + web ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage: server prod deps only, compiled output, run as non-root ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev -w server
# Layout matters: app.ts resolves the SPA as __dirname/../../web/dist.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# Writable by the node user even when no data volume is mounted.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
