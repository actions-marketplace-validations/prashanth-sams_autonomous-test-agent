# Autonomous Test Agent in a container: the CLI, Node.js and Playwright's
# browsers (Chromium, Firefox, WebKit), so a machine needs only Docker.
#
#   docker build -t autonomous-test-agent:local .
#   docker run --rm --init --ipc=host -v "$PWD:/work" autonomous-test-agent:local \
#     explore --url https://staging.example.com --config qa/agent.yaml
#
# Usage, networking and CI examples: README.md, "Run it with Docker".

# The browsers come from this image and the Playwright library from
# package-lock.json, so their versions must match. When you upgrade Playwright,
# change this tag too; the build fails if the two disagree.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble

# Compile on the build machine's own architecture. The output is plain
# JavaScript, so a multi-platform build never emulates the TypeScript compiler.
FROM --platform=$BUILDPLATFORM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /src
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && chmod +x apps/web-agent/dist/cli.js \
 && rm -rf node_modules */*/node_modules

FROM ${PLAYWRIGHT_IMAGE}
WORKDIR /opt/autonomous-test-agent
COPY --from=build /src ./

# - Production dependencies are installed for the target platform, so a
#   native module added later still works in the arm64 image.
# - The check confirms that the base image has the browsers this Playwright
#   version launches.
# - `pr` mode runs `git diff` in a repository mounted from the host, which git
#   would otherwise refuse as owned by another user.
# - /work is writable by any user, for runs started with --user.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && node -e ' \
      const { chromium } = require("playwright"); \
      const { version } = require("playwright/package.json"); \
      if (!require("fs").existsSync(chromium.executablePath())) { \
        console.error(`Playwright ${version} has no browsers in this base image. Set PLAYWRIGHT_IMAGE to mcr.microsoft.com/playwright:v${version}-noble.`); \
        process.exit(1); \
      }' \
 && ln -s /opt/autonomous-test-agent/apps/web-agent/dist/cli.js /usr/local/bin/qa-web-agent \
 && git config --system --add safe.directory '*' \
 && mkdir -p /work \
 && chmod 1777 /work

# Mount your project here: --config paths and the runs/ output folder resolve
# against it, as they do when you run the CLI from your project folder.
WORKDIR /work

# CI publishes with its own labels. VERSION only labels a build made by hand.
ARG VERSION=dev
LABEL org.opencontainers.image.title="Autonomous Test Agent" \
      org.opencontainers.image.description="Explore a web app with Playwright, analyze PR impact, and publish evidence-backed reports." \
      org.opencontainers.image.source="https://github.com/prashanth-sams/autonomous-test-agent" \
      org.opencontainers.image.version="${VERSION}"

ENTRYPOINT ["qa-web-agent"]
CMD ["--help"]
