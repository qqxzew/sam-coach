# Runtime image for the Nest container (2 GB RAM): everything heavy (ds-sam build, UI build, missed-stake
# precompute) is done on the dev machine by scripts/deploy.mjs; here we only install the server's own deps.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w server --no-audit --no-fund

COPY . .

ENV HOST=0.0.0.0 PORT=3001 NODE_OPTIONS=--max-old-space-size=768
EXPOSE 3001
CMD ["npm", "start"]
