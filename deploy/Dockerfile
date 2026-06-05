FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY private-chain/package.json private-chain/
COPY gateway/package.json gateway/
COPY listener/package.json listener/
COPY anchor/package.json anchor/

RUN npm ci --omit=dev

COPY shared shared
COPY private-chain private-chain
COPY gateway gateway
COPY listener listener
COPY anchor anchor

ENV NODE_ENV=production
