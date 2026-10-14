import { useState } from "react";
import { SAFE_Z } from "../../shared/chrome";
import { send, toggleSafe } from "../controller";
import { useUi } from "../store";
import { transport } from "../transport";
import { HistoryList, StatsChip, statusText } from "./History";

/** Fixed, unstyleable fallback UI (Ctrl/Cmd+Shift+Esc or the corner button). Ignores every chrome override. */
export function SafeMode() {
  const { history, status, statusDetail, undo, canvasHidden, stats } = useUi();
  const [text, setText] = useState("");
  const busy = status === "thinking" || status === "tool";
  const submit = () => {
    if (!text.trim()) return;
    send({ t: "prompt", text: text.trim() });
    setText("");
  };
  return (
    <div className="safe" style={{ zIndex: SAFE_Z }} data-testid="safe">
      <div className="safe-bar">
        <strong>Safe mode</strong>
        <span className={`safe-status st-${status}`}>
          <span className="dot" /> {statusText(status, statusDetail)}
        </span>
        <StatsChip stats={stats} />
        <span className="spacer" />
        <button className="btn" disabled={!undo.undo} title={undo.next ? `Undo: ${undo.next}` : "Nothing to undo"} onClick={() => send({ t: "undo" })}>
          Undo{undo.next ? ` (${undo.next})` : ""}
        </button>
        <button className="btn" disabled={!undo.redo} onClick={() => send({ t: "redo" })}>
          Redo
        </button>
        <button className="btn" onClick={() => send({ t: "chrome.reset" })}>
          Reset chrome
        </button>
        <button className="btn" onClick={() => useUi.setState({ canvasHidden: !canvasHidden })}>
          {canvasHidden ? "Show canvas" : "Hide canvas"}
        </button>
        <button className="btn" title="Rebuild the page from its resources (loses runtime state)" onClick={() => send({ t: "canvas.reload" })}>
          Reload canvas
        </button>
        <button className="btn" title="Remove all resources (undoable)" onClick={() => send({ t: "canvas.clear" })}>
          Clear canvas
        </button>
        {transport.newWindow && (
          <button className="btn" onClick={() => transport.newWindow!()}>
            New window
          </button>
        )}
        <button className="btn primary" onClick={toggleSafe}>
          Close
        </button>
      </div>
      <div className="safe-body">
        <HistoryList items={history} className="safe-history" />
        <form
          className="safe-prompt"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Prompt (base styling)" />
          {busy && (
            <button type="button" className="btn" onClick={() => send({ t: "interrupt" })}>
              Stop
            </button>
          )}
          <button className="btn primary" type="submit">
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
