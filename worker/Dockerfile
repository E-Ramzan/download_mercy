FROM node:20-alpine

RUN apk add --no-cache python3 ffmpeg curl

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

CMD ["node", "src/worker.js"]