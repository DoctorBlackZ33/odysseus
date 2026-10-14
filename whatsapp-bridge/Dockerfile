FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.js api.js history.js store.js media.js ./


RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 9100

CMD ["node", "index.js"]
