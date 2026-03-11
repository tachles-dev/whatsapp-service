# Build Stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production Stage
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg curl
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# Ensure the /data directory exists for Render Persistent Disk
RUN mkdir -p /data/auth

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
