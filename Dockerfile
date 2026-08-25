# OpenCode Proxy：OpenCode Free 上游直通 + 自定义 OpenAI 兼容中转
FROM node:22-alpine

WORKDIR /app

# 先装依赖，利用层缓存
COPY package*.json ./
RUN npm install --registry=https://registry.npmmirror.com && npm cache clean --force

# 拷贝源码
COPY . .

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data
EXPOSE 20128

CMD ["node", "server.js"]
