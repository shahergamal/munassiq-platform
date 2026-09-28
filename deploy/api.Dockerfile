# The API (Node runs the TypeScript directly). On start: apply pending migrations, then serve.
FROM node:22-alpine
WORKDIR /srv/app/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/api/src ./src
COPY db /srv/app/db
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
USER node
EXPOSE 4000
CMD ["sh", "-c", "node src/db/migrate.ts && exec node src/server.ts"]
