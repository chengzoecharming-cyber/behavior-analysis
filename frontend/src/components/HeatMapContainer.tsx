import { useEffect, useRef } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";

interface HeatMapPoint {
  lat: number;
  lng: number;
  count: number;
}

interface HeatMapContainerProps {
  points: HeatMapPoint[];
}

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || "YOUR_AMAP_KEY";

export default function HeatMapContainer({ points }: HeatMapContainerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const heatmapInstance = useRef<any>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    AMapLoader.load({
      key: AMAP_KEY,
      version: "2.0",
      plugins: ["AMap.ToolBar", "AMap.Scale", "AMap.HeatMap"],
    })
      .then((AMap: any) => {
        const map = new AMap.Map(mapRef.current, {
          zoom: 5,
          center: [116.397428, 39.90923],
        });
        map.addControl(new AMap.ToolBar());
        map.addControl(new AMap.Scale());

        map.plugin(["AMap.HeatMap"], () => {
          const heatmap = new AMap.HeatMap(map, {
            radius: 25,
            opacity: [0, 0.8],
            gradient: {
              0.5: "blue",
              0.65: "rgb(117,211,248)",
              0.7: "rgb(0, 255, 0)",
              0.9: "#ffea00",
              1.0: "red",
            },
          });
          heatmapInstance.current = heatmap;
          mapInstance.current = map;

          if (points.length > 0) {
            const data = points.map((p) => ({
              lng: p.lng,
              lat: p.lat,
              count: p.count,
            }));
            const max = Math.max(...points.map((p) => p.count), 1);
            heatmap.setDataSet({ data, max });
            map.setFitView();
          }
        });
      })
      .catch((err: any) => {
        console.error("AMap load failed:", err);
      });

    return () => {
      mapInstance.current?.destroy();
      mapInstance.current = null;
      heatmapInstance.current = null;
    };
  }, []);

  useEffect(() => {
    if (!heatmapInstance.current || !mapInstance.current) return;

    if (points.length === 0) {
      heatmapInstance.current.setDataSet({ data: [], max: 1 });
      return;
    }

    const data = points.map((p) => ({
      lng: p.lng,
      lat: p.lat,
      count: p.count,
    }));
    const max = Math.max(...points.map((p) => p.count), 1);
    heatmapInstance.current.setDataSet({ data, max });
    mapInstance.current.setFitView();
  }, [points]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 16,
        background: "#e5e5e5",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        ref={mapRef}
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 16,
        }}
      />
    </div>
  );
}
