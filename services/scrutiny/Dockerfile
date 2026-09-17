FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:20-alpine
WORKDIR /app

RUN addgroup -S livemetric && adduser -S livemetric -G livemetric

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER livemetric
ENV NODE_ENV=production
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3004/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
