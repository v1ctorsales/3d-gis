export const config = { runtime: "nodejs", regions: ["iad1"] };

// `overpass.osm.ch` is deliberately excluded: it responds in ~200ms with a
// valid-shape JSON body whose `elements` array is always empty and whose
// `timestamp_osm_base` is "114469" instead of an ISO date — i.e. the database
// behind it is broken. Because it's the fastest responder, including it makes
// it win every Promise.any race below and starves real layers of data.
const MIRRORS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

// Vercel edge functions get ~25 s. Race all mirrors in parallel and let
// the fastest healthy one win; if every mirror exceeds this timeout we
// abort cleanly with a 504 instead of having Vercel kill the function.
const TIMEOUT_PER_MIRROR = 22000;

// Overpass mirrors rate-limit / reject requests without a meaningful
// User-Agent string. Vercel edge functions don't send one by default,
// which manifested as every query hanging until our own client timeout.
const USER_AGENT =
  "gis-3d-webapp/1.0 (Vercel edge proxy; +https://github.com/)";

function shortName(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Fetch a single mirror. Resolves with the response text on 2xx, rejects
 * with a tagged error otherwise. The shared `winnerSignal` lets us abort
 * losers as soon as another mirror has won.
 */
async function tryMirror(url, body, winnerSignal, reqId) {
  const host = shortName(url);
  const started = Date.now();
  const ctrl = new AbortController();
  const onWin = () => ctrl.abort();
  winnerSignal.addEventListener("abort", onWin, { once: true });

  const timeoutHandle = setTimeout(() => {
    ctrl.abort(new Error(`timeout after ${TIMEOUT_PER_MIRROR}ms`));
  }, TIMEOUT_PER_MIRROR);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - started;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.log(
        `[overpass ${reqId}] ${host} → HTTP ${resp.status} in ${elapsed}ms (${text.length} bytes)`,
      );
      const err = new Error(`${host} → ${resp.status}`);
      err.host = host;
      err.status = resp.status;
      err.elapsed = elapsed;
      throw err;
    }
    const data = await resp.text();
    console.log(
      `[overpass ${reqId}] ${host} → 200 in ${elapsed}ms (${data.length} bytes) ✓`,
    );
    return { data, host, elapsed };
  } catch (err) {
    const elapsed = Date.now() - started;
    if (winnerSignal.aborted) {
      // Another mirror won — quiet cancel, not a real failure.
      const cancel = new Error(`${host} cancelled (another mirror won)`);
      cancel.host = host;
      cancel.cancelled = true;
      cancel.elapsed = elapsed;
      throw cancel;
    }
    console.log(
      `[overpass ${reqId}] ${host} ✗ ${err.message || err} after ${elapsed}ms`,
    );
    if (!err.host) err.host = host;
    err.elapsed = elapsed;
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    winnerSignal.removeEventListener("abort", onWin);
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  let query;

  if (req.method === "GET") {
    query = url.searchParams.get("q");
  } else if (req.method === "POST") {
    query = await req.text();
  } else {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!query) {
    return new Response("Missing query", { status: 400 });
  }

  const reqId = Math.random().toString(36).slice(2, 8);
  const body = `data=${encodeURIComponent(query)}`;
  const overallStart = Date.now();

  console.log(
    `[overpass ${reqId}] dispatching ${MIRRORS.length} mirrors in parallel (query ${query.length} chars)`,
  );

  // Shared "someone won" signal — when any mirror succeeds, the rest abort.
  const winnerCtrl = new AbortController();

  const attempts = MIRRORS.map((m) =>
    tryMirror(m, body, winnerCtrl.signal, reqId),
  );

  try {
    const winner = await Promise.any(attempts);
    // Tell the losers to stop. We don't await them — let them fall off.
    winnerCtrl.abort();
    const totalElapsed = Date.now() - overallStart;
    console.log(
      `[overpass ${reqId}] winner: ${winner.host} in ${winner.elapsed}ms (total ${totalElapsed}ms)`,
    );
    return new Response(winner.data, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Overpass-Mirror": winner.host,
        "Cache-Control":
          "public, s-maxage=604800, stale-while-revalidate=2592000",
      },
    });
  } catch (aggregate) {
    // Promise.any throws AggregateError when every attempt rejects.
    const totalElapsed = Date.now() - overallStart;
    const details = (aggregate.errors || [aggregate]).map((e) => ({
      host: e.host || "unknown",
      message: e.message || String(e),
      status: e.status,
      elapsed: e.elapsed,
    }));
    console.log(
      `[overpass ${reqId}] all mirrors failed in ${totalElapsed}ms:`,
      JSON.stringify(details),
    );
    return new Response(
      JSON.stringify({
        error: "All Overpass mirrors failed",
        elapsedMs: totalElapsed,
        details,
      }),
      {
        status: 504,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}
