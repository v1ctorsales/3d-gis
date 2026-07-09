import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clipPolygonToBbox } from "../../utils/geo";

const GROUND_LIFT_UNITS = 0.3;
const MAX_TREES_PER_POLYGON = 300;

// Trees per km², before slope modulation.
const BASE_TREE_DENSITY = { forest: 600, park: 200 };

function pointInPolygon(x, z, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, zi = points[i].z;
    const xj = points[j].x, zj = points[j].z;
    if (zi !== zj && z >= Math.min(zi, zj) && z < Math.max(zi, zj)) {
      const xCross = xi + ((z - zi) / (zj - zi)) * (xj - xi);
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Random rejection sampler: returns up to MAX_TREES_PER_POLYGON {x, z}
 * points (scene units) inside the polygon. `density` is trees per km².
 */
function samplePointsInPolygon(points, density, metersToUnits) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const widthUnits = maxX - minX;
  const depthUnits = maxZ - minZ;
  if (widthUnits <= 0 || depthUnits <= 0) return [];

  const widthM = widthUnits / metersToUnits;
  const depthM = depthUnits / metersToUnits;
  const bboxAreaKm2 = (widthM * depthM) / 1_000_000;

  const attempts = Math.min(
    Math.round(density * bboxAreaKm2),
    MAX_TREES_PER_POLYGON,
  );

  const result = [];
  for (let i = 0; i < attempts; i++) {
    const x = minX + Math.random() * widthUnits;
    const z = minZ + Math.random() * depthUnits;
    if (pointInPolygon(x, z, points)) result.push({ x, z });
  }
  return result;
}

function sampleSlopeDeg(slope, heightmap, bounds, x, z) {
  const { sceneWidth, sceneDepth } = bounds;
  const { width, height } = heightmap;
  const u = Math.max(0, Math.min(1, (x + sceneWidth / 2) / sceneWidth));
  const v = Math.max(0, Math.min(1, (z + sceneDepth / 2) / sceneDepth));
  const px = Math.round(u * (width - 1));
  const py = Math.round(v * (height - 1));
  return (slope[py * width + px] * 180) / Math.PI;
}

// Average slope (degrees) over the polygon's centroid and bbox corners —
// cheap proxy for "is this patch on a steep slope".
function averagePolygonSlopeDeg(points, slope, heightmap, bounds) {
  if (!slope || !heightmap || !bounds) return 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let sumX = 0, sumZ = 0;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    sumX += p.x;
    sumZ += p.z;
  }
  const samples = [
    [sumX / points.length, sumZ / points.length],
    [minX, minZ],
    [maxX, minZ],
    [minX, maxZ],
    [maxX, maxZ],
  ];
  let total = 0;
  for (const [x, z] of samples) {
    total += sampleSlopeDeg(slope, heightmap, bounds, x, z);
  }
  return total / samples.length;
}

function densityForSlope(baseDensity, avgSlopeDeg) {
  let slopeFactor = 1.0;
  if (avgSlopeDeg > 30) slopeFactor = 0.3;
  else if (avgSlopeDeg > 15) slopeFactor = 0.6;
  return baseDensity * slopeFactor;
}

/**
 * Builds vegetation ground patches and tree placements from parsed OSM
 * vegetation polygons.
 *
 * Returns `{ groundParts, treeInstances }` or null when there's nothing to
 * render. `groundParts` is at most one merged BufferGeometry per kind
 * (forest/park/scrub/meadow). `treeInstances` maps "forest"/"park" to an
 * array of `{x, y, z}` scene-space positions (capped at
 * MAX_TREES_PER_POLYGON per polygon).
 */
export function buildVegetationGeometry(
  polygons,
  {
    project,
    sampleElevation,
    sceneElevation,
    verticalScale,
    metersToUnits,
    bbox,
    slope,
    heightmap,
    bounds,
  },
) {
  if (!polygons || polygons.length === 0) return null;

  const groundGeomsByKind = { forest: [], park: [], scrub: [], meadow: [] };
  const treePositionsByKind = { forest: [], park: [] };

  for (const poly of polygons) {
    if (!poly.coords || poly.coords.length < 3) continue;

    const clipped = clipPolygonToBbox(poly.coords, bbox);
    if (clipped.length < 3) continue;

    const points = clipped.map(({ lat, lon }) => project(lon, lat));

    const shape = new THREE.Shape();
    shape.moveTo(points[0].x, -points[0].z);
    for (let i = 1; i < points.length; i++) {
      shape.lineTo(points[i].x, -points[i].z);
    }

    let geom;
    try {
      geom = new THREE.ShapeGeometry(shape);
    } catch {
      continue;
    }
    geom.rotateX(-Math.PI / 2);

    let sumElev = 0;
    let n = 0;
    for (const { lat, lon } of clipped) {
      const e = sampleElevation(lon, lat);
      if (Number.isFinite(e)) {
        sumElev += e;
        n++;
      }
    }
    const elev = n > 0 ? sumElev / n : 0;
    geom.translate(0, elev * verticalScale + GROUND_LIFT_UNITS, 0);

    groundGeomsByKind[poly.kind]?.push(geom);

    if (poly.kind === "forest" || poly.kind === "park") {
      const avgSlopeDeg = averagePolygonSlopeDeg(points, slope, heightmap, bounds);
      const density = densityForSlope(BASE_TREE_DENSITY[poly.kind], avgSlopeDeg);
      const trees = samplePointsInPolygon(points, density, metersToUnits);
      for (const { x, z } of trees) {
        const elevM = sceneElevation ? sceneElevation(x, z) : elev;
        treePositionsByKind[poly.kind].push({
          x,
          y: elevM * verticalScale,
          z,
        });
      }
    }
  }

  const groundParts = [];
  for (const kind of Object.keys(groundGeomsByKind)) {
    const geoms = groundGeomsByKind[kind];
    if (geoms.length === 0) continue;
    const merged = mergeGeometries(geoms);
    geoms.forEach((g) => g.dispose());
    groundParts.push({ kind, geometry: merged });
  }

  const treeInstances = {};
  for (const kind of Object.keys(treePositionsByKind)) {
    if (treePositionsByKind[kind].length > 0) {
      treeInstances[kind] = treePositionsByKind[kind];
    }
  }

  if (groundParts.length === 0 && Object.keys(treeInstances).length === 0) {
    return null;
  }
  return { groundParts, treeInstances };
}
