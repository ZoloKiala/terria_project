#!/usr/bin/env node
/**
 * Generates wwwroot/init/iwmi-water-accounting.json from the IWMI Data Cube STAC API.
 *
 * The water accounting products are Water Accounting Plus (WA+) rasters: each product is
 * one basin/country, and each STAC asset is one variable for one period. There are ~156
 * assets across the 9 products, so the init file is generated rather than hand-written.
 * Re-run this when the explorer gains products or assets:
 *
 *   node scripts/generate-water-accounting-init.mjs
 *
 * Every item sets `forceProxy: true`. The assets live on a Cloudflare R2 bucket that sends
 * no CORS headers at all (and answers OPTIONS preflight with 403), so a browser cannot read
 * them cross-origin -- they have to go through terriajs-server's /proxy endpoint, and the R2
 * host must stay in `allowProxyFor` in serverconfig.json. This is unlike the S3 bucket used
 * by dem_limpopo, which does send `Access-Control-Allow-Origin: *` and is read directly.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXPLORER = "https://explorer-production-0070.up.railway.app";
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "wwwroot",
  "init",
  "iwmi-water-accounting.json"
);

/** Display names for the products, in the order they should appear in the catalog. */
const BASINS = [
  ["zambezi_water_accounting", "Zambezi basin"],
  ["incomati_water_accounting", "Incomati basin"],
  ["maputo_water_accounting", "Maputo basin"],
  ["mara_water_accounting", "Mara basin"],
  ["lake_tana_water_accounting", "Lake Tana"],
  ["kenya_water_accounting", "Kenya"],
  ["zambia_water_accounting", "Zambia"],
  ["burkina_faso_water_accounting", "Burkina Faso"],
  ["madagascar_seasonal_water_accounting", "Madagascar (seasonal)"]
];

/** Asset-name prefix -> human label, and the order periods should appear in. */
const PERIODS = [
  ["yearly", "Annual"],
  ["wet", "Wet season"],
  ["dry", "Dry season"],
  ["s1", "Season 1"],
  ["s2", "Season 2"]
];

/** Remaining asset-name suffix -> human label, and the order variables appear in. */
const VARIABLES = [
  ["rainfall", "Rainfall"],
  ["et", "Evapotranspiration (ET)"],
  ["rainfall_et", "Rainfall ET (green water)"],
  ["incremental_et", "Incremental ET (blue water)"],
  ["runoff", "Runoff"],
  ["water_yield", "Water yield"]
];

/**
 * Splits an asset key such as `yearly_incremental_et` into its period and variable parts.
 * Longest-prefix and exact-suffix matching, so `yearly_et` and `yearly_rainfall_et` do not
 * collide.
 */
function splitAssetKey(key) {
  for (const [prefix, periodLabel] of PERIODS) {
    if (!key.startsWith(`${prefix}_`)) continue;
    const rest = key.slice(prefix.length + 1);
    const variable = VARIABLES.find(([suffix]) => suffix === rest);
    if (variable) {
      return { periodLabel, variableLabel: variable[1], rest };
    }
  }
  return null;
}

function sortKey(key) {
  const periodIndex = PERIODS.findIndex(([p]) => key.startsWith(`${p}_`));
  const parts = splitAssetKey(key);
  const variableIndex = parts
    ? VARIABLES.findIndex(([suffix]) => suffix === parts.rest)
    : 99;
  return periodIndex * 100 + variableIndex;
}

const json = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
};

const members = [];
let itemCount = 0;
const skipped = [];

for (const [product, displayName] of BASINS) {
  const collection = await json(`${EXPLORER}/stac/collections/${product}`);
  const items = await json(
    `${EXPLORER}/stac/collections/${product}/items?limit=1`
  );
  const feature = items.features?.[0];
  if (!feature) {
    skipped.push(`${product}: no STAC items`);
    continue;
  }

  const year = collection.extent?.temporal?.interval?.[0]?.[0]?.slice(0, 4);
  const assetKeys = Object.keys(feature.assets ?? {}).sort(
    (a, b) => sortKey(a) - sortKey(b)
  );

  const basinMembers = [];
  for (const key of assetKeys) {
    const asset = feature.assets[key];
    const parts = splitAssetKey(key);
    if (!parts) {
      skipped.push(`${product}/${key}: unrecognised asset name`);
      continue;
    }
    const band = asset["raster:bands"]?.[0] ?? {};
    basinMembers.push({
      id: `iwmi-wa-${product}-${key}`.replace(/_/g, "-"),
      type: "cog",
      name: `${parts.periodLabel} — ${parts.variableLabel}`,
      description: `${parts.variableLabel} for the ${parts.periodLabel.toLowerCase()} period, ${displayName}${
        year ? ` (${year})` : ""
      }. Water Accounting Plus output, ${band.unit ?? "mm"}. Fetched via this server's proxy because the asset host sends no CORS headers.`,
      url: asset.href,
      forceProxy: true,
      renderOptions: {
        nodata: band.nodata ?? -9999,
        resampleMethod: "bilinear"
      },
      credit: "IWMI — Water Accounting Plus"
    });
    itemCount++;
  }

  members.push({
    id: `iwmi-wa-${product}`.replace(/_/g, "-"),
    type: "group",
    name: `${displayName}${year ? ` (${year})` : ""}`,
    description: collection.description ?? "",
    members: basinMembers
  });
}

const init = {
  catalog: [
    {
      id: "iwmi-water-accounting",
      type: "group",
      name: "IWMI Water Accounting (WA+)",
      description:
        "Water Accounting Plus outputs from the IWMI Data Cube: rainfall, evapotranspiration, runoff and water yield per basin/country, split by season and annual totals. Generated by scripts/generate-water-accounting-init.mjs from the explorer's STAC API. Values are millimetres (float32, nodata -9999). These are not on the workbench by default — open a basin and pick a layer.",
      isOpen: true,
      members
    }
  ]
};

await writeFile(OUT, `${JSON.stringify(init, null, 2)}\n`);
console.log(
  `Wrote ${OUT}\n  ${members.length} basins, ${itemCount} layers` +
    (skipped.length ? `\n  SKIPPED:\n    ${skipped.join("\n    ")}` : "")
);
