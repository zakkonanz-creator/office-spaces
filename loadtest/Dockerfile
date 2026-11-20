# The load-test crowd: headless Chromium bots running the real app (crowd.ts).
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /crowd
RUN npm init -y >/dev/null && npm i playwright@1.64.0 tsx@4 >/dev/null
COPY crowd.ts ./
COPY media ./media
CMD ["npx", "tsx", "crowd.ts"]
