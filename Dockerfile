FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_OPTIONS=--experimental-sqlite

EXPOSE 3001

CMD ["node", "index.js"]
