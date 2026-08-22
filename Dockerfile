# HomeCam Docker Container Build
FROM node:20-alpine

# Build essentials for native compilation if needed
RUN apk add --no-cache python3 make g++ gcc

WORKDIR /app

# Install production dependencies
COPY package.json ./
RUN npm install --only=production

# Copy application source
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Create persistent mount directories
RUN mkdir -p /app/data /app/media /app/certs

# Environment defaults
ENV PORT=8443
ENV HTTP_PORT=8080
ENV STORAGE_PATH=/app/media
ENV DB_PATH=/app/data/homecam.db
ENV CERTS_PATH=/app/certs

EXPOSE 8443 8080

CMD ["node", "server/server.js"]
