FROM node:22-alpine

WORKDIR /app

# Coolify/Traefik healthchecks often shell out to curl/wget.
# Alpine node image does not include them by default — missing binaries
# mark the container unhealthy → proxy returns "no available server".
RUN apk add --no-cache curl wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS=--experimental-sqlite

EXPOSE 3001

# Use Node's built-in fetch so health does not depend on curl/wget PATH quirks.
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Explicit flag (do not rely only on NODE_OPTIONS / shell scripts).
CMD ["node", "--experimental-sqlite", "index.js"]
