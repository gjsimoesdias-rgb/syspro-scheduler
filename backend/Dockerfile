# ── Stage 1: build ────────────────────────────────────────────────────────────
# Installs all dependencies (including devDependencies) and compiles TypeScript.
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./

# Install all deps — devDependencies are needed for the tsc build step.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Compile TypeScript to dist/; copy migrations alongside the compiled output.
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# Lean image with only production dependencies.
FROM node:18-alpine AS runtime

WORKDIR /app

# Copy manifests first so Docker can cache the npm install layer.
COPY package*.json ./

# Production deps only — devDependencies are left behind.
RUN npm ci --only=production

# Copy compiled artefacts from the builder stage.
COPY --from=builder /app/dist ./dist

# Health check — hits the liveness endpoint.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE 3000

CMD ["node", "dist/server.js"]
