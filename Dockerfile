FROM node:20-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY index.html instrukciya_polzovatelya.pdf instrukciya_polzovatelya1.pdf sw.js manifest.webmanifest icon-192.png icon-512.png apple-touch-icon.png /app/
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app
EXPOSE 8080
USER node
CMD ["node", "index.js"]
