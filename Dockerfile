# Multi-stage Dockerfile for auth-service
# Railway deployment — mirrors whatsapp-handler pattern
#
# ESM/CommonJS note:
# - package.json has "type": "module" (ESM)
# - Migrations are compiled to CommonJS (.cjs) for node-pg-migrate compatibility

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript (main source + migrations)
RUN npm run build:all

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies
RUN npm ci --only=production

# Copy compiled JavaScript from builder (includes dist/migrations)
COPY --from=builder /app/dist ./dist

# Set environment to production
ENV NODE_ENV=production

# Expose port (Railway overrides with $PORT at runtime)
EXPOSE 3000

# Health check per ADR-008
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run migrations then start server
# Railway injects DATABASE_URL directly for auth-service
CMD ["sh", "-c", "npm run migrate:up && node dist/index.js"]
