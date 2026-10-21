# Aurora BFF · Hugging Face Spaces 部署镜像
FROM node:20-alpine

WORKDIR /app

# 先拷依赖清单，利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# HF Spaces 强制：应用监听 0.0.0.0:7860（dev-server.js 读 process.env.PORT 并绑 0.0.0.0）
ENV PORT=7860
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:7860/api/health || exit 1

CMD ["npm", "start"]
