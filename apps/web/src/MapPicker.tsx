import { useEffect, useRef, useState } from "react";

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;

// Minimal typings for the parts of the Maps JavaScript API used here.
interface LatLngLiteral {
  lat: number;
  lng: number;
}
interface MapsEvent {
  latLng: { lat(): number; lng(): number } | null;
}
interface MapObj {
  setCenter(p: LatLngLiteral): void;
  addListener(name: string, cb: (e: MapsEvent) => void): void;
}
interface MarkerObj {
  setPosition(p: LatLngLiteral): void;
  addListener(name: string, cb: (e: MapsEvent) => void): void;
}
interface CircleObj {
  setCenter(p: LatLngLiteral): void;
  setRadius(r: number): void;
}
interface MapsApi {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => MapObj;
  Marker: new (opts: Record<string, unknown>) => MarkerObj;
  Circle: new (opts: Record<string, unknown>) => CircleObj;
}
declare global {
  interface Window {
    google?: { maps: MapsApi };
  }
}

let loader: Promise<MapsApi> | null = null;
function loadMaps(): Promise<MapsApi> {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  loader ??= new Promise<MapsApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY ?? "")}`;
    s.async = true;
    s.onload = () => (window.google?.maps ? resolve(window.google.maps) : reject(new Error("Maps failed to load")));
    s.onerror = () => reject(new Error("Maps failed to load"));
    document.head.appendChild(s);
  });
  return loader;
}

export const mapsEnabled = !!KEY;

/** Click the map or drag the pin to set the unit location; the circle shows the punch-in radius. */
export function MapPicker({ lat, lng, radius, onPick }: { lat: number | null; lng: number | null; radius: number; onPick: (lat: number, lng: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const marker = useRef<MarkerObj | null>(null);
  const circle = useRef<CircleObj | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    loadMaps()
      .then((maps) => {
        if (dead || !el.current) return;
        const start: LatLngLiteral = lat !== null && lng !== null ? { lat, lng } : { lat: 11.1085, lng: 77.3411 };
        const map = new maps.Map(el.current, { center: start, zoom: lat !== null ? 18 : 12, mapTypeControl: false, streetViewControl: false });
        marker.current = new maps.Marker({ map, position: start, draggable: true, visible: lat !== null });
        circle.current = new maps.Circle({ map, center: start, radius, strokeColor: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.2 });
        const pick = (e: MapsEvent) => {
          if (!e.latLng) return;
          const p = { lat: Number(e.latLng.lat().toFixed(6)), lng: Number(e.latLng.lng().toFixed(6)) };
          pickRef.current(p.lat, p.lng);
        };
        map.addListener("click", pick);
        marker.current.addListener("dragend", pick);
      })
      .catch(() => setError("Could not load Google Maps. Check the API key and that the Maps JavaScript API is enabled."));
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    if (lat === null || lng === null) return;
    const p = { lat, lng };
    marker.current?.setPosition(p);
    circle.current?.setCenter(p);
  }, [lat, lng]);
  useEffect(() => {
    circle.current?.setRadius(radius);
  }, [radius]);

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  return <div ref={el} className="h-72 w-full rounded-lg border border-slate-200" />;
}
