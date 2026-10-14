import { useEffect, useRef } from "react";
import { SAFE_Z } from "../shared/chrome";
import { ChromeLayer } from "./components/Chrome";
import { SafeMode } from "./components/SafeMode";
import { StartCard } from "./components/StartCard";
import { attachStage, toggleSafe } from "./controller";
import { useUi } from "./store";

function Stage() {
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useUi((s) => s.canvasHidden);
  useEffect(() => attachStage(ref.current!), []);
  return <div ref={ref} className={`stage${hidden ? " hidden" : ""}`} />;
}

export function App() {
  const { phase, safe, status, connected } = useUi();
  return (
    <>
      {phase === "session" && <Stage />}
      {phase === "start" && <StartCard />}
      {phase === "connecting" && <div className="connecting muted">Connecting…</div>}
      {phase === "session" && !safe && <ChromeLayer />}
      {phase === "session" && safe && <SafeMode />}
      {phase === "session" && (
        <button
          className={`safe-toggle st-${status}`}
          style={{ zIndex: SAFE_Z + 1 }}
          title="Safe mode (Ctrl+Shift+Esc)"
          data-testid="safe-toggle"
          onClick={toggleSafe}
        >
          ⎋
        </button>
      )}
      {!connected && phase !== "connecting" && <div className="offline">reconnecting…</div>}
    </>
  );
}
