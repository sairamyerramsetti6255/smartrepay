FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public

ENV VITE_API_URL=/api
ENV VITE_USE_API=true
ENV VITE_SIMPLIFIED_API_URL=/simplified-api

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
