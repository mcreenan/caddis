import { useEffect, useRef } from "react";
import { ChromeLayer } from "./components/Chrome";
import { StartCard } from "./components/StartCard";
import { TitleBar, Toast } from "./components/TitleBar";
import { attachStage } from "./controller";
import { useUi } from "./store";

function Stage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => attachStage(ref.current!), []);
  return <div ref={ref} className="stage" />;
}

export function App() {
  const { phase, connected, overlayHidden } = useUi();
  return (
    <>
      <TitleBar />
      {phase === "session" && <Stage />}
      {phase === "start" && <StartCard />}
      {phase === "connecting" && <div className="connecting muted">Connecting…</div>}
      {phase === "session" && <ChromeLayer hidden={overlayHidden} />}
      <Toast />
      {!connected && phase !== "connecting" && <div className="offline">reconnecting…</div>}
    </>
  );
}
