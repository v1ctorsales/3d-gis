const ENV_OVERRIDE = import.meta.env.VITE_OVERPASS_URL;

// Every request goes through /api/overpass (api/overpass.js), which races the
// mirrors server-side. In dev, vite.config.js mounts the same handler. Calling
// mirrors straight from the browser doesn't work: the browser always sends an
// `Origin` header, and overpass.openstreetmap.fr answers 403 to any request
// that has one.
const PROXY_URL = "/api/overpass";

const TIMEOUT_MS = 40000;

function shortHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Hit one Overpass endpoint. Resolves to parsed JSON; rejects with a tagged
 * Overpass{Http,Timeout}Error otherwise. The shared `winnerSignal` lets a
 * racing caller cancel losers as soon as one mirror has won.
 */
async function fetchOne(
  url,
  query,
  label,
  winnerSignal,
  timeoutMs = TIMEOUT_MS,
) {
  const host = shortHost(url);
  const ctrl = new AbortController();
  const onWin = winnerSignal ? () => ctrl.abort() : null;
  if (winnerSignal && onWin) {
    if (winnerSignal.aborted) ctrl.abort();
    else winnerSignal.addEventListener("abort", onWin, { once: true });
  }
  const timeoutHandle = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    let resp;
    if (url.startsWith("/")) {
      // Proxy: GET so Vercel can edge-cache on the URL.
      const u = `${url}?q=${encodeURIComponent(query)}`;
      console.log(`${label} ${host} GET ${url} (${query.length} chars)`);
      resp = await fetch(u, { signal: ctrl.signal });
    } else {
      // Standard Overpass POST format: form-urlencoded `data=<query>`.
      // The raw `text/plain` variant is unofficial; some mirrors (e.g.
      // overpass.osm.ch) accept it but silently return an empty result set,
      // which then wins the parallel race below and starves every layer of
      // real data. Match the proxy in api/overpass.js exactly.
      console.log(`${label} ${host} POST (${query.length} chars)`);
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      const elapsed = Math.round(performance.now() - startedAt);
      console.warn(
        `${label} ${host} ✗ HTTP ${resp.status} after ${elapsed}ms`,
        errText.slice(0, 200),
      );
      throw new OverpassHttpError(resp.status, resp.statusText, elapsed, host);
    }
    const text = await resp.text();
    const elapsed = Math.round(performance.now() - startedAt);
    const sizeKb = Math.round(text.length / 1024);
    console.log(
      `${label} ${host} ✓ ${resp.status} · ${sizeKb} kB · ${elapsed}ms`,
    );
    return JSON.parse(text);
  } catch (err) {
    const elapsed = Math.round(performance.now() - startedAt);
    if (err.name === "AbortError") {
      if (winnerSignal?.aborted) {
        // Another mirror won — quiet cancel, not a real failure.
        throw new OverpassCancelledError(host, elapsed);
      }
      console.warn(
        `${label} ${host} ✗ client timeout after ${elapsed}ms (${timeoutMs}ms cap)`,
      );
      throw new OverpassTimeoutError(elapsed, host);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (winnerSignal && onWin) {
      winnerSignal.removeEventListener("abort", onWin);
    }
  }
}

/**
 * Raw Overpass request. Returns parsed JSON; throws on failure.
 * `meta.label` is prepended to every log line so each caller's traffic
 * is easy to follow in the console.
 */
export async function overpassFetch(query, meta = {}) {
  const timeoutMs = meta.timeoutMs ?? TIMEOUT_MS;
  const label = meta.label ? `[osm/${meta.label}]` : "[osm]";
  return fetchOne(ENV_OVERRIDE || PROXY_URL, query, label, null, timeoutMs);
}

class OverpassHttpError extends Error {
  constructor(status, statusText, elapsedMs, host) {
    super(`Overpass ${status} from ${host || "?"}: ${statusText}`);
    this.status = status;
    this.statusText = statusText;
    this.elapsedMs = elapsedMs;
    this.host = host;
    this.name = "OverpassHttpError";
  }
}

class OverpassTimeoutError extends Error {
  constructor(elapsedMs, host) {
    super(`Overpass client timeout after ${elapsedMs}ms (${host || "?"})`);
    this.elapsedMs = elapsedMs;
    this.host = host;
    this.name = "OverpassTimeoutError";
  }
}

class OverpassCancelledError extends Error {
  constructor(host, elapsedMs) {
    super(`${host} cancelled (another mirror won)`);
    this.host = host;
    this.elapsedMs = elapsedMs;
    this.cancelled = true;
    this.name = "OverpassCancelledError";
  }
}

// Retryable from a server-overload perspective: gateway timeouts, server
// errors, the JS-side timeout, and Overpass's own 429 rate-limiting.
function isRetryableOverpassError(err) {
  if (err instanceof OverpassTimeoutError) return true;
  if (err instanceof OverpassHttpError) {
    return (
      err.status === 504 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 429
    );
  }
  return false;
}

function indexNodes(elements) {
  const map = new Map();
  for (const el of elements) {
    if (el.type === "node") map.set(el.id, { lat: el.lat, lon: el.lon });
  }
  return map;
}

function wayCoords(way, nodes) {
  return way.nodes.map((id) => nodes.get(id)).filter(Boolean);
}

function parseHeight(tags) {
  const candidates = ["height", "building:height"];
  for (const k of candidates) {
    if (tags[k]) {
      const v = parseFloat(tags[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  if (tags["building:levels"]) {
    const lvl = parseFloat(tags["building:levels"]);
    if (Number.isFinite(lvl)) return lvl * 3;
  }
  return 6;
}

export async function fetchBuildings(bbox) {
  console.group(
    `[osm/buildings] fetchBuildings bbox=${bbox.west.toFixed(4)},${bbox.south.toFixed(4)} → ${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`,
  );
  const overallStart = performance.now();
  try {
    const q = `
      [out:json][timeout:30];
      way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      out body;
      >;
      out skel qt;
    `;
    const data = await overpassFetch(q, { label: "buildings" });
    const elements = data.elements || [];
    const counts = { node: 0, way: 0, relation: 0 };
    for (const el of elements) counts[el.type] = (counts[el.type] || 0) + 1;
    console.log(`[osm/buildings] response summary:`, {
      total: elements.length,
      ...counts,
    });

    const nodes = indexNodes(elements);
    const buildings = [];
    const heightSources = { explicit: 0, levels: 0, default: 0 };
    for (const el of elements) {
      if (el.type !== "way" || !el.tags?.building) continue;
      const coords = wayCoords(el, nodes);
      if (coords.length < 3) continue;
      if (el.tags.height || el.tags["building:height"])
        heightSources.explicit++;
      else if (el.tags["building:levels"]) heightSources.levels++;
      else heightSources.default++;
      buildings.push({
        id: el.id,
        coords,
        height: parseHeight(el.tags),
      });
    }
    const totalMs = Math.round(performance.now() - overallStart);
    console.log(
      `[osm/buildings] parsed ${buildings.length} building(s) — heights:`,
      heightSources,
    );
    console.log(`[osm/buildings] ✓ done in ${totalMs}ms`);
    return buildings;
  } catch (err) {
    console.error(`[osm/buildings] ✗ failed:`, err);
    throw err;
  } finally {
    console.groupEnd();
  }
}

// Linestring waterways we render as buffered ribbons. `ditch` is intentionally
// omitted — at AOI scales (tens of km) it's almost always rendering noise and
// also fattens the Overpass response significantly in rural areas.
const LINESTRING_WATERWAYS = new Set(["river", "stream", "canal"]);
const WATERWAY_DEFAULT_WIDTH_M = {
  river: 30,
  canal: 10,
  stream: 5,
};

// Tiers ordered most-detailed → least. On 504/timeout/etc. we fall to the
// next. Pruning order goes "smallest first" so the heaviest items
// (waterway=stream — thousands of gullies in mountainous terrain) drop
// before users lose meaningful features like the Colorado River.
const WATER_TIERS = [
  {
    name: "full",
    waterways: ["river", "stream", "canal"],
    queryFn: buildWaterQueryFull,
    timeoutOverride: 15000,
    description: "rivers, streams, canals, lakes, wetlands",
  },
  {
    name: "no-stream",
    waterways: ["river", "canal"],
    queryFn: buildWaterQueryFull,
    timeoutOverride: 20000,
    description: "rivers, canals, lakes, wetlands (streams dropped)",
  },
  {
    name: "rivers-only",
    waterways: ["river"],
    queryFn: buildWaterQueryWays,
    timeoutOverride: 15000,
    description: "rivers, lakes (ways only), wetlands",
  },
  {
    name: "polygons-only",
    waterways: [],
    queryFn: buildWaterQueryWays,
    timeoutOverride: 15000,
    description: "lakes and wetlands only (ways only)",
  },
];

function buildWaterQueryWays(bbox, waterways, timeoutS = 15) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts = [
    `way["natural"="water"](${b});`,
    `way["waterway"="riverbank"](${b});`,
    `way["natural"="wetland"](${b});`,
  ];
  for (const ww of waterways) {
    parts.push(`way["waterway"="${ww}"](${b});`);
  }
  return `
    [out:json][timeout:${timeoutS}];
    (
${parts.map((p) => `      ${p}`).join("\n")}
    );
    out body; >; out skel qt;
  `;
}

function buildWaterQueryFull(bbox, waterways, timeoutS = 20) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts = [
    `way["natural"="water"](${b});`,
    `relation["natural"="water"](${b});`, // ← lakes como relations
    `way["waterway"="riverbank"](${b});`,
    `relation["waterway"="riverbank"](${b});`,
    `way["natural"="wetland"](${b});`,
    `relation["natural"="wetland"](${b});`,
  ];
  for (const ww of waterways) {
    parts.push(`way["waterway"="${ww}"](${b});`);
  }
  return `
    [out:json][timeout:${timeoutS}];
    (
${parts.map((p) => `      ${p}`).join("\n")}
    );
    out body; >; out skel qt;
  `;
}

function summarizeElements(elements) {
  const counts = { node: 0, way: 0, relation: 0 };
  const waterwayCounts = {};
  const naturalCounts = {};
  for (const el of elements) {
    counts[el.type] = (counts[el.type] || 0) + 1;
    if (el.tags?.waterway) {
      waterwayCounts[el.tags.waterway] =
        (waterwayCounts[el.tags.waterway] || 0) + 1;
    }
    if (el.tags?.natural) {
      naturalCounts[el.tags.natural] =
        (naturalCounts[el.tags.natural] || 0) + 1;
    }
  }
  return {
    total: elements.length,
    ...counts,
    waterway: waterwayCounts,
    natural: naturalCounts,
  };
}

export async function fetchWater(bbox) {
  console.group(
    `[osm/water] fetchWater bbox=${bbox.west.toFixed(4)},${bbox.south.toFixed(4)} → ${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`,
  );
  const overallStart = performance.now();
  try {
    for (let i = 0; i < WATER_TIERS.length; i++) {
      const tier = WATER_TIERS[i];
      console.log(
        `[osm/water] tier ${i + 1}/${WATER_TIERS.length}: "${tier.name}" — ${tier.description}`,
      );
      try {
        const timeoutS = Math.floor(
          (tier.timeoutOverride ?? TIMEOUT_MS) / 1000,
        );
        const query = tier.queryFn(bbox, tier.waterways, timeoutS);
        const data = await overpassFetch(query, {
          label: `water:${tier.name}`,
          timeoutMs: tier.timeoutOverride ?? TIMEOUT_MS,
        });
        const summary = summarizeElements(data.elements || []);
        console.log(`[osm/water] response summary:`, summary);

        const parsed = parseWater(data);
        console.log(
          `[osm/water] parsed: ${parsed.polygons.length} polygon(s)` +
            ` (${parsed.polygons.filter((p) => p.kind === "water").length} water,` +
            ` ${parsed.polygons.filter((p) => p.kind === "wetland").length} wetland)` +
            ` · ${parsed.lines.length} linestring(s)`,
        );

        const lineByType = {};
        for (const l of parsed.lines) {
          lineByType[l.waterway] = (lineByType[l.waterway] || 0) + 1;
        }
        if (parsed.lines.length > 0) {
          console.log(`[osm/water] linestring breakdown:`, lineByType);
        }

        const totalMs = Math.round(performance.now() - overallStart);
        console.log(
          `[osm/water] ✓ tier "${tier.name}" succeeded in ${totalMs}ms`,
        );
        return {
          ...parsed,
          tier: tier.name,
          tierDescription: tier.description,
        };
      } catch (err) {
        const isLast = i === WATER_TIERS.length - 1;
        if (isRetryableOverpassError(err) && !isLast) {
          console.warn(
            `[osm/water] ✗ tier "${tier.name}" failed (${err.name}: ${err.message}) — falling back`,
          );
          continue;
        }
        console.error(`[osm/water] ✗ tier "${tier.name}" gave up:`, err);
        throw err;
      }
    }
    // unreachable — the loop either returns or throws above
    throw new Error("All water tiers exhausted");
  } finally {
    console.groupEnd();
  }
}

function isPolygonWaterTags(tags) {
  return (
    tags?.natural === "water" ||
    tags?.natural === "wetland" ||
    tags?.waterway === "riverbank"
  );
}

function waterKindForTags(tags) {
  if (tags?.natural === "wetland") return "wetland";
  return "water";
}

function parseWaterwayWidth(tags) {
  if (tags?.width) {
    const v = parseFloat(tags.width);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const ww = tags?.waterway;
  return WATERWAY_DEFAULT_WIDTH_M[ww] ?? 5;
}

function indexWays(elements) {
  const map = new Map();
  for (const el of elements) {
    if (el.type === "way") map.set(el.id, el);
  }
  return map;
}

/**
 * Stitch an arbitrary set of OSM ways into closed rings by matching shared
 * endpoint node IDs. Returns rings as arrays of {lat, lon}.
 */
function stitchWayRings(ways, nodes) {
  const segments = ways.map((w) => [...w.nodes]);
  const rings = [];

  while (segments.length > 0) {
    const current = segments.shift();

    let progress = true;
    while (
      progress &&
      current.length >= 2 &&
      current[0] !== current[current.length - 1]
    ) {
      progress = false;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const first = current[0];
        const last = current[current.length - 1];
        const sFirst = seg[0];
        const sLast = seg[seg.length - 1];

        if (last === sFirst) {
          for (let j = 1; j < seg.length; j++) current.push(seg[j]);
        } else if (last === sLast) {
          for (let j = seg.length - 2; j >= 0; j--) current.push(seg[j]);
        } else if (first === sLast) {
          for (let j = seg.length - 2; j >= 0; j--) current.unshift(seg[j]);
        } else if (first === sFirst) {
          for (let j = 1; j < seg.length; j++) current.unshift(seg[j]);
        } else {
          continue;
        }

        segments.splice(i, 1);
        progress = true;
        break;
      }
    }

    if (current[0] === current[current.length - 1] && current.length >= 4) {
      const ring = current.map((id) => nodes.get(id)).filter(Boolean);
      if (ring.length >= 3) rings.push(ring);
    }
  }

  return rings;
}

function parseWater(osmData) {
  const nodes = indexNodes(osmData.elements);
  const ways = indexWays(osmData.elements);

  // Track ways already consumed by water multipolygons so they don't get
  // rendered twice (once via the relation, once as a standalone way).
  const consumed = new Set();
  for (const el of osmData.elements) {
    if (el.type !== "relation") continue;
    if (el.tags?.type !== "multipolygon") continue;
    if (!isPolygonWaterTags(el.tags)) continue;
    for (const m of el.members || []) {
      if (m.type === "way") consumed.add(m.ref);
    }
  }

  const polygons = [];
  const lines = [];

  // Standalone water ways (lakes, pools, ponds, wetlands — anything mapped
  // as a single closed way with the water tag on the way itself)
  for (const el of osmData.elements) {
    if (el.type !== "way") continue;
    if (!isPolygonWaterTags(el.tags)) continue;
    if (consumed.has(el.id)) continue;
    const coords = wayCoords(el, nodes);
    if (coords.length < 3) continue;
    polygons.push({
      id: el.id,
      coords,
      holes: [],
      kind: waterKindForTags(el.tags),
    });
  }

  // Multipolygon relations (rivers, large lakes with islands, complex shapes)
  for (const el of osmData.elements) {
    if (el.type !== "relation") continue;
    if (el.tags?.type !== "multipolygon") continue;
    if (!isPolygonWaterTags(el.tags)) continue;

    const outerWays = [];
    const innerWays = [];
    for (const m of el.members || []) {
      if (m.type !== "way") continue;
      const w = ways.get(m.ref);
      if (!w) continue;
      if (m.role === "outer" || m.role === "") outerWays.push(w);
      else if (m.role === "inner") innerWays.push(w);
    }

    const outerRings = stitchWayRings(outerWays, nodes);
    const innerRings = stitchWayRings(innerWays, nodes);

    // Approximation: attach all holes to the first outer ring. Geometrically
    // correct for the vast majority of water bodies (one outer ring + islands).
    const kind = waterKindForTags(el.tags);
    for (let i = 0; i < outerRings.length; i++) {
      polygons.push({
        id: `${el.id}-${i}`,
        coords: outerRings[i],
        holes: i === 0 ? innerRings : [],
        kind,
      });
    }
  }

  // Linestring waterways (rivers, streams, canals, ditches) — buffered into
  // ribbon polygons later by the geometry builder.
  for (const el of osmData.elements) {
    if (el.type !== "way") continue;
    const ww = el.tags?.waterway;
    if (!ww || !LINESTRING_WATERWAYS.has(ww)) continue;
    // Skip ways that are also part of a riverbank polygon (rare but possible).
    if (el.tags?.area === "yes") continue;
    const coords = wayCoords(el, nodes);
    if (coords.length < 2) continue;
    lines.push({
      id: el.id,
      coords,
      waterway: ww,
      width: parseWaterwayWidth(el.tags),
    });
  }

  return { polygons, lines };
}

export async function fetchRoads(bbox) {
  console.group(
    `[osm/roads] fetchRoads bbox=${bbox.west.toFixed(4)},${bbox.south.toFixed(4)} → ${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`,
  );
  const overallStart = performance.now();
  try {
    const { south, west, north, east } = bbox;
    const query = `
      [out:json][timeout:25];
      (
        way["highway"]
          ["highway"!~"^(steps|elevator|construction|proposed|raceway)$"]
          (${south},${west},${north},${east});
      );
      out body;
      >;
      out skel qt;
    `.trim();

    const data = await overpassFetch(query, { label: "roads" });
    const elements = data.elements || [];
    const counts = { node: 0, way: 0, relation: 0 };
    for (const el of elements) counts[el.type] = (counts[el.type] || 0) + 1;
    console.log(`[osm/roads] response summary:`, {
      total: elements.length,
      ...counts,
    });

    const roads = parseRoads(data);
    const byType = {};
    let tunnels = 0;
    let bridges = 0;
    for (const r of roads) {
      byType[r.type] = (byType[r.type] || 0) + 1;
      if (r.tunnel) tunnels++;
      if (r.bridge) bridges++;
    }
    console.log(
      `[osm/roads] parsed ${roads.length} road(s) (${tunnels} tunnel · ${bridges} bridge) — types:`,
      byType,
    );
    const totalMs = Math.round(performance.now() - overallStart);
    console.log(`[osm/roads] ✓ done in ${totalMs}ms`);
    return roads;
  } catch (err) {
    console.error(`[osm/roads] ✗ failed:`, err);
    throw err;
  } finally {
    console.groupEnd();
  }
}

// Vegetation ground cover. Ways only — relations are deliberately excluded
// to keep the query light (forests/parks are rarely mapped as multipolygons
// at the scales this app targets).
const VEGETATION_QUERY_TAGS = [
  'way["natural"="wood"]',
  'way["landuse"="forest"]',
  'way["leisure"="park"]',
  'way["leisure"="nature_reserve"]',
  'way["natural"="scrub"]',
  'way["landuse"="meadow"]',
];

function vegetationKindForTags(tags) {
  if (tags?.natural === "wood" || tags?.landuse === "forest") return "forest";
  if (tags?.leisure === "park" || tags?.leisure === "nature_reserve")
    return "park";
  if (tags?.natural === "scrub") return "scrub";
  if (tags?.landuse === "meadow") return "meadow";
  return null;
}

export async function fetchVegetation(bbox) {
  console.group(
    `[osm/vegetation] fetchVegetation bbox=${bbox.west.toFixed(4)},${bbox.south.toFixed(4)} → ${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`,
  );
  const overallStart = performance.now();
  try {
    const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    const query = `
      [out:json][timeout:20];
      (
${VEGETATION_QUERY_TAGS.map((tag) => `        ${tag}(${b});`).join("\n")}
      );
      out body;
      >;
      out skel qt;
    `;
    const data = await overpassFetch(query, {
      label: "vegetation",
      timeoutMs: 20000,
    });
    const elements = data.elements || [];
    const counts = { node: 0, way: 0, relation: 0 };
    for (const el of elements) counts[el.type] = (counts[el.type] || 0) + 1;
    console.log(`[osm/vegetation] response summary:`, {
      total: elements.length,
      ...counts,
    });

    const nodes = indexNodes(elements);
    const polygons = [];
    const byKind = {};
    for (const el of elements) {
      if (el.type !== "way") continue;
      const kind = vegetationKindForTags(el.tags);
      if (!kind) continue;
      const coords = wayCoords(el, nodes);
      if (coords.length < 3) continue;
      polygons.push({ id: el.id, coords, kind });
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
    const totalMs = Math.round(performance.now() - overallStart);
    console.log(
      `[osm/vegetation] parsed ${polygons.length} polygon(s):`,
      byKind,
    );
    console.log(`[osm/vegetation] ✓ done in ${totalMs}ms`);
    return polygons;
  } catch (err) {
    console.error(`[osm/vegetation] ✗ failed:`, err);
    throw err;
  } finally {
    console.groupEnd();
  }
}

function parseRoads(data) {
  const nodes = new Map();
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  const roads = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.tags?.highway) continue;
    const coords = el.nodes.map((id) => nodes.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    roads.push({
      type: el.tags.highway,
      name: el.tags.name,
      tunnel: el.tags.tunnel === "yes",
      bridge: el.tags.bridge === "yes",
      coords,
    });
  }
  return roads;
}
