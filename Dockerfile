# ============================================
# Stage 1: Dependencies (production-only, for the final image)
# ============================================
FROM node:20-alpine AS dependencies

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

# ============================================
# Stage 2: Build
# ============================================
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY nest-cli.json ./

# Install all dependencies (including dev deps, needed to build)
RUN npm ci

COPY prisma ./prisma
COPY src ./src

# Generate the Prisma client (DATABASE_URL isn't needed for `generate`, only `migrate`)
RUN DATABASE_URL="postgresql://dummy:dummy@dummy:5432/dummy" npx prisma generate --schema=./prisma/schema.prisma

RUN npm run build

RUN test -f /app/dist/main.js || (echo "ERROR: dist/main.js not found after build" && exit 1)

# ============================================
# Stage 3: Production
# ============================================
FROM node:20-alpine AS production

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

COPY package*.json ./
COPY prisma.config.ts ./prisma.config.ts
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

RUN chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/main.js"]
