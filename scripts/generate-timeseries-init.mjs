#!/usr/bin/env node
/**
 * Generates wwwroot/init/iwmi-timeseries.json from the IWMI Data Cube STAC API.
 *
 * These products have one STAC item per time step (monthly or annual), and the values live
 * in a COG per step. Run with:
 *
 *   node scripts/generate-timeseries-init.mjs
 *
 * IMPORTANT LIMITATION -- these are discrete layers, not an animated series.
 * TerriaJS 8.12.5's `cog` type is
 *   CogCatalogItem extends MappableMixin(CatalogMemberMixin(CreateModel(CogCatalogItemTraits)))
 * with no DiscretelyTimeVaryingMixin, so a COG cannot drive the timeline. Only
 * GeojsonMixin / TableMixin / TimeFilterMixin / ArcGisImageServer / ArcGisMapServer items
 * animate. The explorer publishes no WMS/WMTS (its /ows returns 404), so there is no
 * time-enabled raster service to point at either. Animating the products' vector footprints
 * is not an option worth taking: every time step of every product shares one identical
 * footprint polygon and carries no values, so it would blink a static rectangle.
 *
 * So each time step becomes its own layer, grouped per product and named by date. To get a
 * real animated timeline you would need either a time-enabled raster service (WMS with a
 * TIME dimension, or an ArcGIS ImageServer) or a tabular/GeoJSON series with values, e.g.
 * zonal statistics per time step, which would be a derived product rather than a republish.
 *
 * CORS is probed per host rather than assumed: assets sit on several buckets and only some
 * allow cross-origin reads. Hosts that do not are marked `forceProxy: true` and must also be
 * present in `allowProxyFor` in serverconfig.json.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXPLORER = "https://explorer-production-0070.up.railway.app";
const ORIGIN = "https://terriamap-production-2a14.up.railway.app";
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "wwwroot",
  "init",
  "iwmi-timeseries.json"
);

/**
 * Products to publish, in catalog order. `granularity` only controls how the per-step layer
 * is labelled. Add more from the explorer here — e.g. evaporation_africa /
 * transpiration_africa / interception_africa / evaporative_stress_index_africa /
 * benificial_fraction_africa each have 264 monthly steps back to 2003, which is a lot of
 * layers to add at once.
 */
const PRODUCTS = [
  ["et_monthly_limpopo", "Limpopo monthly ET", "month"],
  ["vegetation_condition_index_limpopo", "Limpopo vegetation condition index", "month"],
  ["limpopo_rainfall_anomaly", "Limpopo rainfall anomaly (ENSO forecast)", "month"],
  ["limpopo_temperature_anomaly", "Limpopo temperature anomaly (ENSO forecast)", "month"],
  ["africa_flood_occurrence", "Africa flood occurrence", "year"]
];

const json = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
};

/** Probe once per host: does a cross-origin ranged GET come back with CORS allowed? */
const corsCache = new Map();
async function needsProxy(href) {
  const host = new URL(href).host;
  if (corsCache.has(host)) return corsCache.get(host);
  let proxy = true;
  try {
    const r = await fetch(href, {
      headers: { Origin: ORIGIN, Range: "bytes=0-15" }
    });
    const allow = r.headers.get("access-control-allow-origin");
    proxy = !(allow === "*" || allow === ORIGIN);
    console.log(
      `  host ${host}: status=${r.status} cors=${JSON.stringify(allow)} -> ${proxy ? "PROXY" : "direct"}`
    );
  } catch (e) {
    console.log(`  host ${host}: probe failed (${e.message}) -> PROXY`);
  }
  corsCache.set(host, proxy);
  return proxy;
}

/** Label a time step: monthly products get YYYY-MM, annual products get YYYY. */
function label(datetime, granularity) {
  const iso = String(datetime ?? "");
  return granularity === "year" ? iso.slice(0, 4) : iso.slice(0, 7);
}

const prettyAsset = (key) =>
  key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bEt\b/, "ET")
    .replace(/\bVci\b/, "VCI");

const members = [];
let layerCount = 0;
const skipped = [];

for (const [product, displayName, granularity] of PRODUCTS) {
  console.log(`\n${product}`);
  const collection = await json(`${EXPLORER}/stac/collections/${product}`);
  const items = await json(
    `${EXPLORER}/stac/collections/${product}/items?limit=400`
  );
  const features = (items.features ?? []).slice().sort((a, b) =>
    String(a.properties?.datetime).localeCompare(String(b.properties?.datetime))
  );

  // One asset key per item normally; flood occurrence has two, so keep them apart.
  const assetKeys = [
    ...new Set(features.flatMap((f) => Object.keys(f.assets ?? {})))
  ];

  const stepMembers = [];
  // Some products have more than one STAC item indexing the identical asset URL for a step
  // (e.g. et_monthly_limpopo and vegetation_condition_index_limpopo both duplicate 2026-06).
  // Those are redundant, not extra time steps, and would collide on model id.
  const seenUrls = new Set();
  let duplicates = 0;
  for (const f of features) {
    for (const key of assetKeys) {
      const asset = f.assets?.[key];
      if (!asset?.href) continue;
      if (seenUrls.has(asset.href)) {
        duplicates++;
        continue;
      }
      seenUrls.add(asset.href);
      const band = asset["raster:bands"]?.[0] ?? {};
      // renderOptions.nodata is a number trait; some products report the string "nan".
      const nodata = typeof band.nodata === "number" ? band.nodata : undefined;
      const step = label(f.properties?.datetime, granularity);

      const renderOptions = { resampleMethod: "bilinear" };
      if (nodata !== undefined) renderOptions.nodata = nodata;

      stepMembers.push({
        id: `iwmi-ts-${product}-${key}-${step}`.replace(/[_.]/g, "-"),
        type: "cog",
        name: assetKeys.length > 1 ? `${step} — ${prettyAsset(key)}` : step,
        description: `${displayName} — ${step}${
          band.unit && band.unit !== "1" ? ` (${band.unit})` : ""
        }. One time step of the \`${product}\` product; TerriaJS cannot animate COGs, so switch layers to move through time.`,
        url: asset.href,
        ...((await needsProxy(asset.href)) ? { forceProxy: true } : {}),
        renderOptions,
        credit: "IWMI"
      });
      layerCount++;
    }
  }

  if (!stepMembers.length) {
    skipped.push(`${product}: no usable assets`);
    continue;
  }

  const dates = features.map((f) => f.properties?.datetime).filter(Boolean);
  members.push({
    id: `iwmi-ts-${product}`.replace(/_/g, "-"),
    type: "group",
    name: `${displayName} (${label(dates[0], granularity)} – ${label(dates[dates.length - 1], granularity)}, ${stepMembers.length} steps)`,
    description: `${collection.description ?? ""}\n\nOne layer per time step. TerriaJS 8.12.5 cannot put COGs on the timeline, so these are discrete layers rather than an animated series.`,
    members: stepMembers
  });
  console.log(
    `  ${stepMembers.length} layers` +
      (duplicates ? ` (dropped ${duplicates} duplicate asset URL(s))` : "")
  );
}

const init = {
  catalog: [
    {
      id: "iwmi-timeseries",
      type: "group",
      name: "IWMI Time Series",
      description:
        "Products with one raster per time step, grouped per product and named by date. Generated by scripts/generate-timeseries-init.mjs. NOTE: these are discrete layers, not an animated timeline — TerriaJS 8.12.5's COG type has no time support and the explorer publishes no WMS with a TIME dimension, so stepping through time means switching layers.",
      isOpen: true,
      members
    }
  ]
};

await writeFile(OUT, `${JSON.stringify(init, null, 2)}\n`);
console.log(
  `\nWrote ${OUT}\n  ${members.length} products, ${layerCount} layers` +
    (skipped.length ? `\n  SKIPPED:\n    ${skipped.join("\n    ")}` : "")
);
