FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Do NOT use wget/curl HEALTHCHECK on alpine — those binaries are missing and
# mark the container unhealthy, which makes Coolify stick on "Restarting" / 503.
# Coolify's HTTP health check should hit /api/health on port 3001 instead.

CMD ["node", "--experimental-sqlite", "index.js"]
