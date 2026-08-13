# Deploying this TerriaMap to Railway

Railway builds the multi-stage [`Dockerfile`](Dockerfile) at the repo root and runs the
`deploy` stage. Everything needed is committed; there are no manual build steps.

## What was changed from upstream TerriaMap

| File | Change | Why |
| --- | --- | --- |
| `Dockerfile` | `RUN npm install -g gulp-cli@3` in the build stage | Works around an upstream packaging bug in `terriajs@8.12.5`: its `postinstall` runs `gulp post-npm-install` (to copy the Cesium assets) but `gulp` is declared only as a **devDependency**, so it is not installed when terriajs is consumed as a dependency. `yarn install` then fails with `gulp: not found` (exit 127). This bites on every platform, not just Windows. |
| `Dockerfile` | `CMD` switched to shell form, passing `--port ${PORT:-3001}` | `terriajs-server` only reads the port from the `--port` flag — it ignores `$PORT`. Railway assigns a random `$PORT` per deploy, so the exec-form `CMD` would leave the container listening on 3001 and the healthcheck would never pass. |
| `Dockerfile` | `ENV NODE_OPTIONS=--max-old-space-size=6144` in the build stage | The Cesium/webpack release build exceeds Node's default heap on a build runner and dies with an OOM. |
| `serverconfig.json` | `"trustProxy": true` | Railway terminates TLS and reverse-proxies to the container. Without trusting `X-Forwarded-*`, terriajs-server generates share URLs with the wrong scheme/host. |
| `.dockerignore` | added | Keeps the host's `node_modules` and `wwwroot/build` out of the build context. The build stage runs its own `yarn install`; host-built native modules are not portable into the Linux image. |
| `railway.json` | added | Pins the Dockerfile builder and sets a `/` healthcheck with a 300s timeout (the image is large and cold-starts slowly). |
| `.railwayignore` | added | `railway up` uploads the working directory and does not exclude `node_modules`; the ~576 MB upload failed with `500 Internal Server Error`. With this file the snapshot is ~8.5 MB. |

## Remotes

- `origin` → this project's repo
- `upstream` → `TerriaJS/TerriaMap`, so upstream releases can still be merged:

```bash
git fetch upstream
git merge upstream/main
```

## Local development

Two upstream issues affect a local install/build. The container build works around the
first; the second is Windows-only and does not affect the Railway deploy.

### 1. `yarn install` fails with `gulp: not found` (all platforms)

See the `gulp-cli` row above. On a dev machine, either install gulp-cli globally
(`npm install -g gulp-cli@3`) before `yarn install`, or put the project's own binaries on
PATH so the nested lifecycle script can find gulp:

```powershell
$env:PATH = "$PWD\node_modules\.bin;$env:PATH"
yarn install --network-timeout 1000000
```

If `yarn install` already failed at that step, the only thing left undone is copying the
Cesium assets. Run it directly, then re-run `yarn install`:

```powershell
cd node_modules\terriajs
node ..\gulp\bin\gulp.js post-npm-install
```

### 2. `resolve-url-loader` fails on a Windows host

`yarn gulp release` (and `gulp dev`) then **fail on a Windows host** in
`resolve-url-loader`:

```
expected "base" to be absolute path to a valid directory, got "/C:/Users/..."
```

This is an upstream Windows-only path bug between `sass-loader`'s modern API and
`resolve-url-loader` (it hands over `file:///C:/...` source-map sources, which get
stripped to `/C:/...`). It affects only `.scss` files containing `url()`. It does **not**
affect the Railway deploy, which builds on Linux inside the container.

To build/run locally on Windows, use the container or WSL2:

```bash
docker build -t terriamap .
docker run -p 3001:3001 terriamap
```

## The live deployment

| | |
| --- | --- |
| URL | https://terriamap-production-2a14.up.railway.app |
| Railway project | `terria-project` (`ed626eb2-bb7a-4dda-a40e-8ad1f41d9800`) |
| Service | `terriamap`, environment `production`, region US West |

## Deploying

The service was created against this GitHub repo, but **pushing does not currently
trigger a build** — Railway's GitHub App still has to be authorized on the repo, which can
only be done from the Railway dashboard (Service → Settings → Source). Until that is
done, deploy from the CLI:

```bash
railway up            # builds the Dockerfile on Railway and deploys
```

Once the GitHub App is authorized, `git push origin main` will deploy on its own.

## Verifying a deploy

Railway assigns `$PORT` at runtime (8080 on the current deploy), so the runtime log should
report that port rather than 3001:

```bash
railway logs        # expect: Serving directory "/app/wwwroot" on port 8080 to the world.
```

Assets worth spot-checking, since they come from three different build steps:

| Path | Produced by |
| --- | --- |
| `/build/TerriaMap.js`, `/build/TerriaMap.css` | webpack, `gulp release-app` |
| `/build/TerriaJS/build/Cesium/build/Workers/…` | terriajs `postinstall`, then `copy-terriajs-assets` |
| `/config.json`, `/init/simple.json` | committed in `wwwroot` |
