# The hosted receiver: `polycap serve` with ffmpeg, one container, data in a volume at /data.
# Build from the repository root: docker build -f deploy/receiver/Dockerfile -t polycap-receiver .
# Node 22.22.0, the version the hosted receiver's host uses. Pin by digest as well once it is recorded in
# docs/HOSTED.md, as Polydance's publication image does, so a rebuild cannot change underneath us.
FROM node:22.22.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY skill ./skill

# Session ids are local time; this is the zone Robin records in.
ENV NODE_ENV=production TZ=Europe/London POLYCAP_ROOT=/data POLYCAP_TRANSCRIBER=gladia
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
# GLADIA_API_KEY and POLYCAP_SERVER_TOKENS come from an --env-file kept on the host, mode 600.
CMD ["node", "bin/polycap.js", "serve", "--host", "0.0.0.0", "--port", "8790"]
