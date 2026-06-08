FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Install ALL deps (vite is devDependency) — do not set NODE_ENV=production here
RUN NPM_CONFIG_PRODUCTION=false npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public

RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --omit=dev

COPY server ./server
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

WORKDIR /app/server

CMD ["node", "index.js"]
