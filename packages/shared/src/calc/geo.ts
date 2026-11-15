const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GpsCheck =
  | { ok: true; distanceMeters: number }
  | { ok: false; code: "GPS_ACCURACY" | "OUT_OF_RANGE" | "NO_LOCATION"; message: string; distanceMeters?: number };

/** Spec 8.1: accuracy <= limit AND distance <= radius. */
export function checkGps(
  position: { lat: number; lng: number; accuracy: number },
  unit: { lat: number; lng: number; radiusMeters: number } | null,
  accuracyLimitMeters = 100,
): GpsCheck {
  if (!unit) {
    return { ok: false, code: "NO_LOCATION", message: "This business unit has no location set yet. Ask your Admin." };
  }
  if (position.accuracy > accuracyLimitMeters) {
    return {
      ok: false,
      code: "GPS_ACCURACY",
      message: `GPS is not accurate enough (${Math.round(position.accuracy)} m, need ${accuracyLimitMeters} m or better). Move to an open area and retry.`,
    };
  }
  const distanceMeters = haversineMeters(position, unit);
  if (distanceMeters > unit.radiusMeters) {
    return {
      ok: false,
      code: "OUT_OF_RANGE",
      distanceMeters,
      message: `You are ${Math.round(distanceMeters)} m from the location; you must be within ${unit.radiusMeters} m.`,
    };
  }
  return { ok: true, distanceMeters };
}
