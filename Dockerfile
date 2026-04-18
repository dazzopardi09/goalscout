FROM node:20-alpine

LABEL maintainer="goalscout"
LABEL description="GoalScout — Football match investigation tool"

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY src/ ./src/
COPY public/ ./public/

# Data directory — mount this as a volume for persistence
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3030

EXPOSE 3030

# Health check
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- http://localhost:3030/api/status || exit 1

CMD ["node", "src/index.js"]