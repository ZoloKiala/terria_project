# Deploying this TerriaMap to Railway

Railway builds the multi-stage [`Dockerfile`](Dockerfile) at the repo root and runs the
`deploy` stage. Everything needed is committed; there are no manual build steps.

## What was changed from upstream TerriaMap

| File | Change | Why |
| --- | --- | --- |
| `Dockerfile` | `CMD` switched to shell form, passing `--port ${PORT:-3001}` | `terriajs-server` only reads the port from the `--port` flag — it ignores `$PORT`. Railway assigns a random `$PORT` per deploy, so the exec-form `CMD` would leave the container listening on 3001 and the healthcheck would never pass. |
| `Dockerfile` | `ENV NODE_OPTIONS=--max-old-space-size=6144` in the build stage | The Cesium/webpack release build exceeds Node's default heap on a build runner and dies with an OOM. |
| `serverconfig.json` | `"trustProxy": true` | Railway terminates TLS and reverse-proxies to the container. Without trusting `X-Forwarded-*`, terriajs-server generates share URLs with the wrong scheme/host. |
| `.dockerignore` | added | Keeps the host's `node_modules` and `wwwroot/build` out of the build context. The build stage runs its own `yarn install`; host-built native modules are not portable into the Linux image. |
| `railway.json` | added | Pins the Dockerfile builder and sets a `/` healthcheck with a 300s timeout (the image is large and cold-starts slowly). |

## Remotes

- `origin` → this project's repo
- `upstream` → `TerriaJS/TerriaMap`, so upstream releases can still be merged:

```bash
git fetch upstream
git merge upstream/main
```

## Local development on Windows

`yarn gulp release` (and `gulp dev`) currently **fail on a Windows host** in
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

## Deploying

```bash
railway up            # from this directory, once linked to a service
```

Or push to `origin` if the Railway service is connected to the GitHub repo.
