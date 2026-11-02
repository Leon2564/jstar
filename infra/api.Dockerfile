FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
# Her recorded greeting lines (#57 wake-up falls back to the morning one); bundled into server.mjs at build time.
COPY tools/voice/greetings.json ./tools/voice/greetings.json
# Only these two workspaces are in the image; npm refuses a workspace list that points at missing folders.
RUN node -e "const f='package.json',p=require('./'+f);p.workspaces=['packages/shared','apps/api'];require('fs').writeFileSync(f,JSON.stringify(p))"
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund
# One self-contained file: @jstar/shared ships TypeScript source, so plain tsc output cannot run under node.
RUN npm run build -w @jstar/api

FROM node:20-alpine
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /repo/apps/api/dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
