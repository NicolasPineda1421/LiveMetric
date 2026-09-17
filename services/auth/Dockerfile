# --- Etapa de dependencias ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# --- Etapa final (imagen mínima, usuario no-root) ---
FROM node:20-alpine
WORKDIR /app

# Crea un usuario sin privilegios para no correr el proceso como root
RUN addgroup -S livemetric && adduser -S livemetric -G livemetric

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER livemetric
ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
