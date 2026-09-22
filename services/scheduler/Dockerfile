FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine
WORKDIR /app

# Parchea paquetes de SO (libssl3/libcrypto3, etc.) del snapshot de Alpine
# de la imagen base, y elimina el npm/npx/corepack empaquetados: la imagen
# final solo corre "node src/index.js", nunca invoca npm en runtime, asi
# que sus dependencias internas (tar, pacote, glob, etc.) son superficie de
# ataque sin uso real - Trivy las marca igual como CVEs del contenedor.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN addgroup -S livemetric && adduser -S livemetric -G livemetric

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER livemetric
ENV NODE_ENV=production
EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3005/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
