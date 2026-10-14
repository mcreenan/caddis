import { useEffect, useMemo, useState } from "react";
import type { Effort } from "../../shared/protocol";
import { send } from "../controller";
import { useUi } from "../store";
import { transport } from "../transport";

export function StartCard() {
  const { providers, welcomed, defaultCwd, error, connected } = useUi();
  const claude = providers.find((p) => p.id === "claude");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort | "">("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCwd((c) => c || defaultCwd), [defaultCwd]);
  useEffect(() => setBusy(false), [error]);
  const efforts = useMemo(() => claude?.models.find((m) => m.id === model)?.efforts ?? [], [claude, model]);
  useEffect(() => {
    if (effort && !efforts.includes(effort)) setEffort("");
  }, [efforts, effort]);

  const ready = Boolean(claude?.enabled) && connected;
  const start = () => {
    if (!prompt.trim() || !ready) return;
    setBusy(true);
    useUi.setState({ error: undefined });
    send({ t: "session.start", config: { provider: "claude", model, effort, cwd }, prompt: prompt.trim() });
  };

  return (
    <form
      className={`start${busy ? " busy" : ""}`}
      data-testid="start"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <div className="start-title">What should this window become?</div>
      <textarea
        autoFocus
        rows={3}
        value={prompt}
        placeholder="A 3D solar system… a kanban board for this repo… a synth…"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            start();
          }
        }}
      />
      <div className="start-opts">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!claude?.models.length}>
            {(claude?.models.length ? claude.models : [{ id: "", label: "Default", efforts: [] }]).map((m) => (
              <option key={m.id} value={m.id} title={m.description}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Effort
          <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | "")} disabled={!efforts.length}>
            <option value="">Default</option>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Working directory
          <span className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            {transport.pickDirectory && (
              <button type="button" className="btn" onClick={async () => setCwd((await transport.pickDirectory!()) ?? cwd)}>
                Browse…
              </button>
            )}
          </span>
        </label>
      </div>
      <div className="start-foot">
        <span className={claude?.enabled ? "muted" : "err"} data-testid="auth">
          {!connected ? "Connecting…" : !welcomed ? "Asking Claude Code for models…" : claude?.enabled ? `Claude · ${claude.auth}` : (claude?.note ?? "Claude unavailable")}
        </span>
        <button className="btn primary" type="submit" disabled={!ready || !prompt.trim()}>
          Start
        </button>
      </div>
      {error && <div className="err">{error}</div>}
    </form>
  );
}
