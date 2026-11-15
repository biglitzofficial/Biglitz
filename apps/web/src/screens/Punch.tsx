import { useEffect, useRef, useState } from "react";
import { get, post, uploadToSignedUrl } from "../lib/api";
import { captureFrame, getPosition, startCamera, stopCamera, type Gps } from "../lib/device";
import { inr } from "../lib/format";
import { back, go } from "../router";
import { Btn, Card, ErrorBox, Notice, PageTitle, Spinner, errMsg, useLoad } from "../ui";
import { SalesForm } from "./Sales";

interface Earned {
  salaryPaise: number;
  incentiveEstimatePaise: number;
  totalPaise: number;
}

type SalesState = Parameters<typeof SalesForm>[0]["data"];

export function Punch({ kind }: { kind: "in" | "out" }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [gps, setGps] = useState<Gps | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ earned: Earned | null; distance: number | null } | null>(null);

  const sales = useLoad<SalesState | null>(() => (kind === "out" ? get<SalesState>("/api/sales/today") : Promise.resolve(null)), [kind]);
  const salesPending = kind === "out" && !!sales.data && sales.data.required && !sales.data.entry;

  const prepare = async () => {
    setProblem(null);
    setCameraReady(false);
    setGps(null);
    try {
      const video = videoRef.current;
      if (!video) return;
      const [stream, pos] = await Promise.all([startCamera(video), getPosition()]);
      streamRef.current = stream;
      setCameraReady(true);
      setGps(pos);
    } catch (e) {
      setProblem(errMsg(e));
    }
  };

  useEffect(() => {
    if (salesPending || sales.loading) return;
    void prepare();
    return () => stopCamera(streamRef.current);
  }, [salesPending, sales.loading]);

  const submit = async () => {
    const video = videoRef.current;
    if (!video || !gps) return;
    setBusy(true);
    setProblem(null);
    try {
      const blob = await captureFrame(video);
      const slot = await post<{ path: string; uploadUrl: string }>("/api/uploads/selfie-url", { kind });
      await uploadToSignedUrl(slot.uploadUrl, blob, "image/jpeg");
      const res = await post<{ earned?: Earned; distanceMeters?: number }>(`/api/attendance/punch-${kind}`, { gps, selfiePath: slot.path });
      stopCamera(streamRef.current);
      setResult({ earned: res.earned ?? null, distance: res.distanceMeters ?? null });
    } catch (e) {
      setProblem(errMsg(e));
      // A stale GPS fix is never reused: fetch a fresh one for the retry.
      try {
        setGps(await getPosition());
      } catch {
        setGps(null);
      }
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="space-y-3">
        <PageTitle>{kind === "in" ? "Punched in" : "Punched out"}</PageTitle>
        <Notice tone="ok">{kind === "in" ? "You are punched in. Have a great day!" : "You are punched out. Thank you!"}</Notice>
        {result.earned && (
          <Card>
            <div className="text-xs text-slate-500">Today you earned</div>
            <div className="text-3xl font-bold text-emerald-600">{inr(result.earned.totalPaise)}</div>
            <div className="mt-1 text-sm text-slate-600">
              Salary {inr(result.earned.salaryPaise)} + incentive {inr(result.earned.incentiveEstimatePaise)}
            </div>
            <div className="mt-1 text-xs text-slate-500">Incentive is an estimate until month-end.</div>
          </Card>
        )}
        <Btn onClick={() => go("/")} className="w-full">
          Back to Home
        </Btn>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <PageTitle>{kind === "in" ? "Punch in" : "Punch out"}</PageTitle>
      {sales.loading && <Spinner />}
      {salesPending && sales.data && (
        <Card>
          <h2 className="mb-2 font-semibold">Submit today's sales first</h2>
          <p className="mb-3 text-sm text-slate-600">Enter your sales (or tap "No sales today") to punch out.</p>
          <SalesForm data={sales.data} onSaved={sales.reload} />
        </Card>
      )}
      {!salesPending && !sales.loading && (
        <>
          <div className="overflow-hidden rounded-2xl bg-black">
            <video ref={videoRef} playsInline muted className="aspect-[3/4] w-full -scale-x-100 object-cover" />
          </div>
          <p className="text-sm text-slate-600">
            {gps ? `Location found (±${Math.round(gps.accuracy)} m).` : problem ? "" : "Getting your location…"}
          </p>
          <ErrorBox message={problem} />
          <div className="flex gap-2">
            <Btn onClick={() => void submit()} disabled={busy || !gps || !cameraReady} className="flex-1">
              {busy ? "Submitting…" : kind === "in" ? "Take selfie & punch in" : "Take selfie & punch out"}
            </Btn>
            {problem && !busy && (
              <Btn kind="ghost" onClick={() => void prepare()}>
                Retry
              </Btn>
            )}
          </div>
          <button type="button" onClick={back} className="w-full text-center text-sm text-slate-500 underline">
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
