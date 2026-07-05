FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

EXPOSE 3000
USER node

# Compose overrides this to run the migration first; this is the default.
CMD ["node", "src/server.js"]
