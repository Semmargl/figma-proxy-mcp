# Node.js + Playwright + Chrome base image (verify_render renders HTML in Chromium).
# Images: https://docs.apify.com/sdk/js/docs/guides/docker-images
FROM apify/actor-node-playwright-chrome:22

# Install dependencies first for better layer caching.
COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && if [ -f package-lock.json ]; then npm ci --omit=dev --omit=optional; else npm install --omit=dev --omit=optional; fi \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -rf ~/.npm

# Make sure the Chromium build matching the installed playwright version exists.
# If this download is not possible, src/main.js falls back to the image's Chrome.
RUN npx playwright install chromium || echo "playwright install skipped; using the image's browser"

COPY --chown=myuser:myuser . ./

# Hosted mode: per-request Figma token, temp dirs only, inline outputs.
ENV FIGMA_PROXY_HOSTED=1

CMD ["node", "src/main.js"]
