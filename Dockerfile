# OpenDJ as a web app (NAS / home server). Audio plays in the browser; this container serves the library,
# streams/transcodes files (FFmpeg) and stores the library data.
#
#   docker build -t opendj .
#   docker run -d -p 7380:7380 -v opendj-data:/data -v /path/to/music:/music:ro opendj
#   docker logs <container>   # one-time setup code: choose the password on first visit
# Or pass OPENDJ_PASSWORD (8+ characters; example values like "change-me" are refused at startup).
# Pinned by digest (multi-arch index of node:22-slim, looked up 2026-11-20). To update:
#   docker buildx imagetools inspect node:22-slim   (and replace the sha256 below)
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# No Electron (devDependency) and no bundled ffmpeg-static (optional): the system FFmpeg above is used.
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7380 \
    OPENDJ_DATA=/data \
    OPENDJ_MUSIC_ROOTS=/music \
    OPENDJ_UPLOAD_DIR=/data/Uploads

RUN mkdir -p /data /music && chown -R node:node /data
USER node
VOLUME ["/data", "/music"]
EXPOSE 7380

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7380)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/cli.js"]
