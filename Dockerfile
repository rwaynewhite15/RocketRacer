# Rocket Racer — container for Google Cloud Run.
# Build + deploy in one step with:  ./deploy.sh
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first so this layer caches between deploys.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Drop root. Cloud Run tells us the port through $PORT (8080 by default).
USER node
EXPOSE 8080
CMD ["node", "server.js"]
