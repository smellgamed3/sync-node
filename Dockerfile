FROM node:22-alpine AS deps
WORKDIR /app
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV FILESYNC_HOME=/app/.filesync
ENV FILESYNC_HOST=0.0.0.0
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY --from=build /app/docs ./docs
COPY --from=build /app/README.md ./README.md
RUN addgroup -S app && adduser -S -G app app && mkdir -p /app/.filesync && chown -R app:app /app
USER app
EXPOSE 8384
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O - http://127.0.0.1:8384/api/status || exit 1
CMD ["node", "dist/core/main.js"]
