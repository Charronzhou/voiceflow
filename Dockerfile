FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY skills ./skills
ENV NODE_ENV=production
ENV PORT=8000
USER node
EXPOSE 8000
CMD ["node", "server.mjs"]
