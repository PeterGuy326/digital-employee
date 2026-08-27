FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node packages/core/package.json ./packages/core/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node . .

USER node
EXPOSE 3000

CMD ["node", "./apps/cli/bin.js", "serve", "--config", "./configs/demo.json", "--host", "0.0.0.0", "--port", "3000"]
