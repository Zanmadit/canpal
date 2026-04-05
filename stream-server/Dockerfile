FROM node:22-alpine

WORKDIR /app

COPY stream-server/package.json stream-server/package-lock.json ./
RUN npm ci

COPY frontend/shared ./shared
COPY frontend/worker ./worker
COPY stream-server/server.ts ./server.ts
COPY stream-server/tsconfig.docker.json ./tsconfig.json

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
