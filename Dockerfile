FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "src/worker.mjs"]
