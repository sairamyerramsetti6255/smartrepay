FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x /app/start.sh

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Coolify HTTP healthcheck should use: GET /api/health on port 3001
# Do not add a Docker HEALTHCHECK that depends on wget/curl (missing on alpine).

CMD ["/app/start.sh"]
