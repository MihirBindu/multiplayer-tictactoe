# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Layer-cache: only reinstall when package.json / package-lock.json changes.
COPY package*.json ./
RUN npm ci

# VITE_NK_KEY is baked into the JS bundle at build time.
# It must match the --socket.server_key value passed to Nakama.
ARG VITE_NK_KEY=defaultkey
ENV VITE_NK_KEY=$VITE_NK_KEY

COPY . .
RUN npm run build

# ─── Stage 2: serve ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /app/dist       /usr/share/nginx/html
COPY nginx.conf                   /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
