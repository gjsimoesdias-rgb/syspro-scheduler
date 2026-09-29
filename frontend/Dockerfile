# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# ── Stage 2: runtime (nginx static server) ────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Replace the default nginx config with one that supports SPA routing.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the CRA production build from the builder stage.
COPY --from=builder /app/build /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
