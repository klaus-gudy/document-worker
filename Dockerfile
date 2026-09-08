# Playwright's own image, not a bare `node:` one.
#
# This worker renders through Chromium, and a browser needs some three dozen
# shared libraries that a slim Node image does not carry. Installing them by
# hand is a list that goes stale with every Chromium bump; Playwright publishes
# an image whose libraries match the browser it ships, and the tag is pinned to
# the `playwright` version in package.json so the two cannot drift apart.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build

WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------

FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Playwright's image already runs as this user, and it owns the browser cache
# in its home directory — running as root would launch Chromium as root, which
# it refuses to do without `--no-sandbox`.
USER pwuser

EXPOSE 3400
CMD ["node", "dist/main"]
