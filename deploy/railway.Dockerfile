# Single-container image for platforms that route one port per service (Railway, and similar PaaS).
# Builds the web app and runs it behind nginx, with the API in the same container on :4000, so there is
# no cross-service private networking to configure. The VPS/Coolify path (docker-compose.prod.yml, the
# separate api.Dockerfile/web.Dockerfile) is unaffected and stays the primary documented deployment
# (docs/DEPLOY_AR.md); this file exists only for single-container hosts.

FROM node:22-alpine AS web-build
WORKDIR /w
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache nginx bash
WORKDIR /srv/app/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/api/src ./src
COPY db /srv/app/db
COPY --from=web-build /w/dist /usr/share/nginx/html
COPY deploy/nginx.railway.conf.template /etc/nginx/http.d/default.conf.template
COPY deploy/railway-start.sh /srv/start.sh
RUN chmod +x /srv/start.sh

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/srv/start.sh"]
