import { useState } from "react";
import { post } from "../lib/api";
import { useAuth } from "../auth";
import { Btn, ErrorBox, Field, Input, Notice, useAction } from "../ui";

export function Login() {
  const { login } = useAuth();
  const [mobile, setMobile] = useState("");
  const [pin, setPin] = useState("");
  const { busy, error, run } = useAction();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 bg-slate-900 p-6 text-white">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-amber-400">Biglitz Team</h1>
        <p className="text-sm text-slate-400">Sign in with your mobile number and PIN</p>
      </div>
      <form
        className="space-y-3 rounded-2xl bg-white p-4 text-slate-900"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => login(mobile.trim(), pin));
        }}
      >
        <Field label="Mobile number">
          <Input inputMode="numeric" autoComplete="username" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))} placeholder="10-digit mobile" />
        </Field>
        <Field label="4-digit PIN">
          <Input type="password" inputMode="numeric" autoComplete="current-password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••" />
        </Field>
        <ErrorBox message={error} />
        <Btn type="submit" disabled={busy || mobile.length !== 10 || pin.length !== 4} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Btn>
      </form>
      <p className="text-center text-xs text-slate-500">Forgot your PIN? Ask your Admin to reset it.</p>
    </main>
  );
}

export function ChangePin({ forced }: { forced: boolean }) {
  const { refresh, logout } = useAuth();
  const [currentPin, setCurrent] = useState("");
  const [newPin, setNew] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();

  const submit = async () => {
    if (newPin !== again) return setError("The two new PINs do not match.");
    await run(async () => {
      await post("/api/auth/change-pin", { currentPin, newPin });
      await refresh();
      setDone(true);
      setCurrent("");
      setNew("");
      setAgain("");
    });
  };

  const pinInput = (v: string, set: (s: string) => void) => (
    <Input type="password" inputMode="numeric" maxLength={4} value={v} onChange={(e) => set(e.target.value.replace(/\D/g, ""))} />
  );

  const form = (
    <form
      className="space-y-3 rounded-2xl bg-white p-4 text-slate-900"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {forced && <Notice tone="warn">Your PIN was set by your Admin. Please choose your own PIN to continue.</Notice>}
      <Field label="Current PIN">{pinInput(currentPin, setCurrent)}</Field>
      <Field label="New PIN" hint="4 digits. Not 1234, 0000, repeated digits or your mobile's last 4.">
        {pinInput(newPin, setNew)}
      </Field>
      <Field label="New PIN again">{pinInput(again, setAgain)}</Field>
      <ErrorBox message={error} />
      {done && !forced && <Notice tone="ok">PIN changed.</Notice>}
      <Btn type="submit" disabled={busy || currentPin.length !== 4 || newPin.length !== 4} className="w-full">
        {busy ? "Saving…" : "Change PIN"}
      </Btn>
    </form>
  );

  if (!forced) return form;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 bg-slate-900 p-6">
      <h1 className="text-center text-2xl font-bold text-amber-400">Set your PIN</h1>
      {form}
      <button type="button" onClick={() => void logout()} className="text-sm text-slate-400 underline">
        Sign out
      </button>
    </main>
  );
}
