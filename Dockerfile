FROM node:22-alpine AS builder

WORKDIR /app

# Coolify injects NODE_ENV=production at build — override so Vite (devDependency) installs
ENV NODE_ENV=development
ENV NPM_CONFIG_PRODUCTION=false

COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

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
