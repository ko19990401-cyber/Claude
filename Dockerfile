# 長時間音声 文字起こし・要約ツール
# ffmpeg を同梱した単一コンテナ。フロントもAPIもこのプロセスが配信する。
FROM node:22-bookworm-slim

# 音声の前処理に必須。ffprobe も同じパッケージに含まれる。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY tools ./tools

# 音声と結果の保存先。永続ボリュームをここへマウントする。
ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
