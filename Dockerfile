FROM node:20-slim

# Install FFmpeg + ffprobe
RUN apt-get update && \
    apt-get install -y ffmpeg ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY VERSION ./

EXPOSE 3000

CMD ["npm", "start"]
