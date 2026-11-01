# Chromium + Playwright, run as the image's unprivileged pwuser.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
RUN npm init -y >/dev/null && npm install playwright@1.64.1 --omit=dev --no-audit --no-fund
COPY runner.mjs .
USER pwuser
CMD ["node", "runner.mjs"]
