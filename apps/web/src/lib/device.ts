/**
 * The ONLY module that touches camera and GPS hardware (spec 11.1.2).
 * If we later wrap the PWA in a native shell, swap the implementations here; screens do not change.
 */

export interface Gps {
  lat: number;
  lng: number;
  accuracy: number;
}

export function getPosition(): Promise<Gps> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This phone does not support location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) =>
        reject(
          new Error(
            e.code === e.PERMISSION_DENIED
              ? "Location permission is off. Turn it on for this app in your phone settings, then try again."
              : e.code === e.TIMEOUT
                ? "Could not get your location in time. Move near a window and try again."
                : "Could not get your location. Turn on GPS and try again.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This phone does not support the camera.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    return stream;
  } catch {
    throw new Error("Camera permission is off. Turn it on for this app in your phone settings, then try again.");
  }
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Captures the current video frame as a JPEG (live capture only: no gallery pick). */
export function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return Promise.reject(new Error("Camera is not ready yet."));
  const scale = Math.min(1, 720 / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not take the photo."))), "image/jpeg", 0.8));
}
