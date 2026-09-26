FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
# Run as an unprivileged user, not root.
USER node
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
