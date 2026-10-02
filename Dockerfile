# Multi-stage: build the SPA, compile the server, then copy both into a runtime
# image with production dependencies only. The server drains the job queue
# itself, so there is no second command to run from this image.

# --- stage 1: build the frontend -----------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- stage 2: compile the server -----------------------------------------
#
# `tsc` rather than shipping the sources under --experimental-strip-types: the
# flag is fine for dev and a compiled dist/ is what the type checker has already
# vetted, so a type error cannot reach production as a running process.
FROM node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY evals ./evals
RUN npx tsc

# --- stage 3: runtime ------------------------------------------------------
FROM node:22-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    SERVE_STATIC=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/dist ./dist
COPY migrations ./migrations
COPY --from=web /web/dist ./frontend/dist
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=10 \
    CMD node -e "fetch('http://localhost:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
