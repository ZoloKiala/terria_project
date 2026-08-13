# develop container
FROM node:24 AS develop

# build container
FROM node:24 AS build

# terriajs@8.12.5 runs `gulp post-npm-install` (which copies the Cesium assets) from its
# postinstall hook, but declares gulp only as a devDependency -- so gulp is absent when
# terriajs is installed as a dependency, and `yarn install` dies with
# `gulp: not found` (exit 127). Provide the binary globally; gulp-cli then resolves the
# hoisted local gulp and terriajs' own gulpfile. Installed as root before dropping to
# USER node, since the node user cannot write to the global prefix.
RUN npm install -g gulp-cli@3

USER node

COPY --chown=node:node . /app

WORKDIR /app

# The webpack/Cesium release build exceeds Node's default heap on a build runner.
ENV NODE_OPTIONS=--max-old-space-size=6144

RUN yarn install --network-timeout 1000000
RUN yarn gulp release

# deploy container
FROM node:24-slim AS deploy

USER node

WORKDIR /app

# Without the chown when copying directories, wwwroot is owned by root:root.
COPY --from=build --chown=node:node /app/wwwroot wwwroot
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build /app/serverconfig.json serverconfig.json
COPY --from=build /app/index.js index.js
COPY --from=build /app/package.json package.json
COPY --from=build /app/version.js version.js

EXPOSE 3001
ENV NODE_ENV=production

# terriajs-server takes the port from `--port` only (it does not read $PORT), so use
# the shell form of CMD to expand the port Railway injects, falling back to 3001 locally.
CMD node ./node_modules/terriajs-server/lib/app.js --config-file serverconfig.json --port ${PORT:-3001}
