FROM node:20-bullseye AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip \
    && pip3 install --no-cache-dir -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 5000

CMD ["node","index.js"]
