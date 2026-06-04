import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { TerraDraw, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { computeAreaKm2, MAX_AREA_KM2, polygonToBbox } from "../../utils/geo";
import styles from "./MapView.module.css";

const RECT_FILL_OK = "#3388ff";
const RECT_FILL_OVER = "#ff3b3b";

function isFeatureOverLimit(feature) {
  if (!feature?.geometry?.coordinates?.[0]) return false;
  return computeAreaKm2(polygonToBbox(feature)) > MAX_AREA_KM2;
}

const SATELLITE_STYLE = {
  version: 8,
  sources: {
    "esri-satellite": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 512,
      attribution: "Imagery © Esri",
    },
    "carto-labels": {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 512,
      attribution: "Labels © CARTO, © OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "satellite", type: "raster", source: "esri-satellite" },
    { id: "labels", type: "raster", source: "carto-labels" },
  ],
};

const MapView = forwardRef(function MapView({ onSelectionChange }, ref) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const lastFeatureIdRef = useRef(null);
  const tooltipRef = useRef(null);

  // Stable ref to the callback so the effect can stay mount-only.
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useImperativeHandle(ref, () => ({
    clearSelection() {
      const draw = drawRef.current;
      const id = lastFeatureIdRef.current;
      if (draw && id) {
        draw.removeFeatures([id]);
      }
      lastFeatureIdRef.current = null;
    },
  }));

  useEffect(() => {
    if (mapRef.current) return;

    // Track cursor position for the area tooltip (direct DOM, no re-renders).
    const handleMouseMove = (e) => {
      const el = tooltipRef.current;
      if (el) {
        el.style.left = `${e.clientX + 14}px`;
        el.style.top = `${e.clientY + 14}px`;
      }
    };
    window.addEventListener("mousemove", handleMouseMove);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: [0, 20],
      zoom: 2,
      maxZoom: 18,
    });
    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");

    map.on("load", () => {
      const rectStyle = (f) =>
        isFeatureOverLimit(f) ? RECT_FILL_OVER : RECT_FILL_OK;
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawRectangleMode({
            styles: {
              fillColor: rectStyle,
              outlineColor: rectStyle,
            },
          }),
        ],
      });
      drawRef.current = draw;

      draw.start();
      draw.setMode("rectangle");

      // Update area tooltip in real-time while the user drags.
      draw.on("change", (ids, changeType) => {
        const el = tooltipRef.current;
        if (!el) return;

        if (changeType === "delete") {
          el.style.display = "none";
          return;
        }

        const snapshot = draw.getSnapshot();
        const feature = snapshot.find((f) => ids.includes(f.id));
        if (!feature?.geometry?.coordinates?.[0]) {
          el.style.display = "none";
          return;
        }

        try {
          const bbox = polygonToBbox(feature);
          const area = computeAreaKm2(bbox);
          if (area < 0.001) {
            el.style.display = "none";
            return;
          }
          el.textContent = `${area.toFixed(2)} km²`;
          el.style.background =
            area > MAX_AREA_KM2
              ? "rgba(200, 50, 50, 0.9)"
              : "rgba(15, 15, 15, 0.78)";
          el.style.display = "block";
        } catch {
          el.style.display = "none";
        }
      });

      draw.on("finish", (id) => {
        // Hide tooltip when drawing is done.
        const el = tooltipRef.current;
        if (el) el.style.display = "none";

        // Enforce a single rectangle: drop the previous one, if any.
        const previous = lastFeatureIdRef.current;
        if (previous && previous !== id) {
          draw.removeFeatures([previous]);
        }
        lastFeatureIdRef.current = id;

        const feature = draw.getSnapshot().find((f) => f.id === id);
        if (!feature) return;

        onSelectionChangeRef.current(polygonToBbox(feature));
      });
    });

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      drawRef.current?.stop();
      drawRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className={styles.map} />
      <div ref={tooltipRef} className={styles.areaTooltip} style={{ display: "none" }} />
    </>
  );
});

export default MapView;
