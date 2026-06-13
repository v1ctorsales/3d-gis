/**
 * Cells whose slope angle is below this threshold are treated as flat for
 * aspect purposes — their gradient direction is dominated by floating-point
 * noise, so we emit NaN and let the renderer paint them grey.
 */
const FLAT_SLOPE_THRESHOLD_RAD = Math.PI / 180; // 1°

/**
 * 3×3 box-blur smoothed copy of the heightmap. Returns a new heightmap
 * (does not mutate the input). Edge cells use clamped neighbors.
 *
 * Used internally before computing slope/aspect/hillshade so single-pixel
 * elevation noise in SRTM/Terrarium tiles doesn't blow up Horn's 3×3 into
 * bogus high-slope / rainbow-aspect spikes in flat areas.
 *
 * @param {{elevations: Float32Array, width: number, height: number}} hm
 * @returns {{elevations: Float32Array, width: number, height: number,
 *           minElevation?: number, maxElevation?: number, zoom?: number}}
 */
export function smoothHeightmap(hm) {
  const { elevations, width, height } = hm;
  const out = new Float32Array(width * height);
  const at = (c, r) => {
    const cc = c < 0 ? 0 : c >= width ? width - 1 : c;
    const rr = r < 0 ? 0 : r >= height ? height - 1 : r;
    return elevations[rr * width + cc];
  };
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const sum =
        at(c - 1, r - 1) +
        at(c, r - 1) +
        at(c + 1, r - 1) +
        at(c - 1, r) +
        at(c, r) +
        at(c + 1, r) +
        at(c - 1, r + 1) +
        at(c, r + 1) +
        at(c + 1, r + 1);
      out[r * width + c] = sum / 9;
    }
  }
  return { ...hm, elevations: out, width, height };
}

/**
 * Horn's 3×3 gradient at (c, r). Returns [dzdx, dzdy] in meters per meter.
 * Edge cells use clamped (replicate-edge) neighbors.
 */
function hornGradient(elevations, width, height, c, r, denom) {
  const at = (cc, rr) => {
    const ccc = cc < 0 ? 0 : cc >= width ? width - 1 : cc;
    const rrr = rr < 0 ? 0 : rr >= height ? height - 1 : rr;
    return elevations[rrr * width + ccc];
  };
  const a = at(c - 1, r - 1);
  const b = at(c, r - 1);
  const cc = at(c + 1, r - 1);
  const d = at(c - 1, r);
  const f = at(c + 1, r);
  const g = at(c - 1, r + 1);
  const h = at(c, r + 1);
  const i = at(c + 1, r + 1);
  const dzdx = (cc + 2 * f + i - (a + 2 * d + g)) / denom;
  const dzdy = (g + 2 * h + i - (a + 2 * b + cc)) / denom;
  return [dzdx, dzdy];
}

/**
 * Slope from an already-smoothed heightmap (private helper — avoids
 * re-smoothing when the caller is `computeHillshade`).
 */
function computeSlopeFromSmoothed(smoothed, pixelSizeM) {
  const { elevations, width, height } = smoothed;
  const out = new Float32Array(width * height);
  const denom = 8 * pixelSizeM;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const [dzdx, dzdy] = hornGradient(elevations, width, height, c, r, denom);
      out[r * width + c] = Math.atan(Math.hypot(dzdx, dzdy));
    }
  }
  return out;
}

/**
 * Aspect from an already-smoothed heightmap (private helper). Cells whose
 * slope is below `FLAT_SLOPE_THRESHOLD_RAD` are emitted as NaN.
 */
function computeAspectFromSmoothed(smoothed, pixelSizeM) {
  const { elevations, width, height } = smoothed;
  const out = new Float32Array(width * height);
  const denom = 8 * pixelSizeM;
  const TWO_PI = Math.PI * 2;
  // tan(FLAT_SLOPE_THRESHOLD_RAD) is the gradient magnitude at the threshold —
  // cheaper to compare against ‖∇z‖ directly than to take atan each cell.
  const flatGradient = Math.tan(FLAT_SLOPE_THRESHOLD_RAD);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const [dzdx, dzdy] = hornGradient(elevations, width, height, c, r, denom);
      const mag = Math.hypot(dzdx, dzdy);
      if (mag < flatGradient) {
        out[r * width + c] = NaN;
        continue;
      }
      let aRad = Math.atan2(-dzdx, dzdy);
      if (aRad < 0) aRad += TWO_PI;
      out[r * width + c] = aRad;
    }
  }
  return out;
}

/**
 * Slope at every cell, in radians, via Horn's 3×3 algorithm.
 * Edge cells use clamped (replicate-edge) neighbors.
 *
 * The heightmap is internally pre-smoothed with a 3×3 box blur before the
 * gradient is taken — this kills single-pixel noise that would otherwise
 * produce bogus high-slope spikes in flat areas. Linear ramps (and flat
 * plates) survive the smoothing unchanged at interior cells.
 *
 * @param {{elevations: Float32Array, width: number, height: number}} hm
 * @param {number} pixelSizeM  meters per heightmap pixel (horizontal)
 * @returns {Float32Array} length = width * height
 */
export function computeSlope(hm, pixelSizeM) {
  return computeSlopeFromSmoothed(smoothHeightmap(hm), pixelSizeM);
}

/**
 * Aspect (downhill compass direction) at every cell, radians.
 *   0 = N, π/2 = E, π = S, 3π/2 = W.
 * NaN for flat cells (slope < 1°).
 *
 * The heightmap is internally pre-smoothed with a 3×3 box blur before the
 * gradient is taken (see `computeSlope` for rationale).
 *
 * @param {{elevations: Float32Array, width: number, height: number}} hm
 * @param {number} pixelSizeM
 * @returns {Float32Array}
 */
export function computeAspect(hm, pixelSizeM) {
  return computeAspectFromSmoothed(smoothHeightmap(hm), pixelSizeM);
}

/**
 * Hillshade in [0, 1]. ESRI formula.
 * @param {{elevations, width, height}} hm
 * @param {number} pixelSizeM
 * @param {{azimuthDeg?: number, altitudeDeg?: number}} sun
 * @param {number} [zFactor=1]  Vertical exaggeration applied ONLY to the
 *   slope/aspect calculation (not to rendered geometry). Useful to bring out
 *   shading on terrain whose relief is small relative to the pixel size.
 */
export function computeHillshade(hm, pixelSizeM, sun = {}, zFactor = 1) {
  const azimuthDeg = sun.azimuthDeg ?? 315;
  const altitudeDeg = sun.altitudeDeg ?? 45;
  // Order matters: apply z-factor first (creates intermediate heightmap), then
  // smooth, then take derivatives. Smoothing a scaled field is equivalent to
  // scaling a smoothed field for a linear blur, but we keep this order for
  // clarity and so future non-linear pre-processing stays correct.
  const scaledHm =
    zFactor === 1
      ? hm
      : {
          ...hm,
          elevations: scaleElevations(hm.elevations, zFactor),
        };
  const smoothed = smoothHeightmap(scaledHm);
  const slope = computeSlopeFromSmoothed(smoothed, pixelSizeM);
  const aspect = computeAspectFromSmoothed(smoothed, pixelSizeM);
  const zenith = ((90 - altitudeDeg) * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  const cosZen = Math.cos(zenith);
  const sinZen = Math.sin(zenith);
  const out = new Float32Array(slope.length);
  for (let i = 0; i < slope.length; i++) {
    const s = slope[i];
    const a = aspect[i];
    const cosSlope = Math.cos(s);
    const sinSlope = Math.sin(s);
    let v;
    if (Number.isNaN(a)) {
      v = cosZen * cosSlope;
    } else {
      v = cosZen * cosSlope + sinZen * sinSlope * Math.cos(az - a);
    }
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    out[i] = v;
  }
  return out;
}

function scaleElevations(elevations, zFactor) {
  const scaled = new Float32Array(elevations.length);
  for (let i = 0; i < elevations.length; i++) {
    scaled[i] = elevations[i] * zFactor;
  }
  return scaled;
}

/**
 * Estimate the expected visual richness of the 3D terrain from the loaded
 * DEM's elevation range and relief density (range / sqrt(pixel count)).
 *
 * @param {{minElevation: number, maxElevation: number, width: number, height: number}} heightmap
 * @returns {{key: "excellent"|"good"|"moderate"|"low", color: string}}
 */
export function assessTerrainQuality(heightmap) {
  const range = heightmap.maxElevation - heightmap.minElevation;
  const totalPixels = heightmap.width * heightmap.height;
  const reliefDensity = range / Math.sqrt(totalPixels);

  if (range > 1500 || reliefDensity > 3)
    return { key: "excellent", color: "#4ADE80" };
  if (range > 500 || reliefDensity > 1)
    return { key: "good", color: "#86EFAC" };
  if (range > 100) return { key: "moderate", color: "#FCD34D" };
  return { key: "low", color: "#F87171" };
}

/**
 * Pick a hillshade z-factor that yields visible shading even on flat terrain.
 * Targets having ~10% of pixels reach slope ≥ 30° after the z-factor is applied,
 * which gives the directional term a meaningful contribution.
 * Returned value is in [1, 20] and is rounded to the nearest 0.5.
 *
 * @param {{elevations: Float32Array, width: number, height: number}} heightmap
 * @param {number} pixelSizeM
 * @returns {number}
 */
export function suggestHillshadeZFactor(heightmap, pixelSizeM) {
  const slope = computeSlope(heightmap, pixelSizeM);
  if (slope.length === 0) return 1;
  // 90th percentile slope via Float32 sort.
  const sorted = Float32Array.from(slope).sort();
  const idx = Math.floor(sorted.length * 0.9);
  const p90 = sorted[Math.min(idx, sorted.length - 1)];
  const tanP90 = Math.tan(p90);
  const targetTan = Math.tan((30 * Math.PI) / 180);
  let z;
  if (!Number.isFinite(tanP90) || tanP90 <= 0) {
    z = 20;
  } else {
    z = targetTan / tanP90;
  }
  if (!Number.isFinite(z) || z < 1) z = 1;
  if (z > 20) z = 20;
  // Round to nearest 0.5.
  z = Math.round(z * 2) / 2;
  if (z < 1) z = 1;
  if (z > 20) z = 20;
  return z;
}
