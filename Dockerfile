# Playwright's own image, not a bare `node:` one.
#
# This service renders through Chromium, and a browser needs some three dozen
# shared libraries a slim Node image does not carry. Installing them by hand is
# a list that goes stale with every Chromium bump; Playwright publishes an image
# whose libraries match the browser it ships.
#
# **The tag is pinned to the `playwright` version in package.json and the two
# must move together.** The image carries a pre-installed browser build, and the
# npm package refuses any revision but its own — bump one without the other and
# `postinstall` silently downloads a second copy at build time, or the app fails
# at first render with "Executable doesn't exist".
ARG PLAYWRIGHT_VERSION=1.63.0

# ---------------------------------------------------------------------------
# build — dev dependencies, TypeScript, `tsc-alias` path rewriting
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the whole tree.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runtime — production dependencies and the compiled output
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3400

COPY package*.json ./

# `postinstall` runs `playwright install chromium` here too. It is a no-op
# rather than a second 94MB download: the base image already has that exact
# revision at `PLAYWRIGHT_BROWSERS_PATH` (/ms-playwright), and the installer
# skips what is already present.
RUN npm ci --omit=dev && npm cache clean --force

# Only the build output. `tsc-alias` has already rewritten every `@/...` import
# to a relative path, so `dist` needs no runtime path resolver.
COPY --from=build /app/dist ./dist

# The base image ships this user and it owns the browser cache. Chromium refuses
# to launch as root without `--no-sandbox`, and disabling the sandbox to run a
# renderer as root — on caller-supplied HTML — is the wrong trade.
USER pwuser

EXPOSE 3400

# Uses the app's own endpoint, which probes RabbitMQ and MinIO and answers 503
# when either is unreachable. That is deliberate (`RabbitmqService` has no
# reconnect loop, so a restart is the recovery), but it does mean a container
# started without its dependencies reports unhealthy rather than merely idle.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3400/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main"]
