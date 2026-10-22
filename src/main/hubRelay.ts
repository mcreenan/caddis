import { WebSocket } from "ws";
import { hubSocketUrl } from "../core/agentLink";
import type { Client } from "../core/session";
import type { ClientMsg, ServerMsg } from "../shared/protocol";

/**
 * A window connected to a hub: main relays its messages to the hub's `/ws`
 * and back, so the renderer and its `canvas://` frame work as they do locally.
 * Reconnects on its own; the hub's fresh `welcome` makes the renderer rejoin.
 */
export function relayToHub(url: string, client: Client, onJoin: (name: string, token: string) => void) {
  let ws: WebSocket | undefined;
  let closed = false;
  let delay = 500;
  let everOpened = false;
  const queue: ClientMsg[] = [];
  let exporting: ((f: { name: string; data: string } | undefined) => void) | undefined;

  const connect = () => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(hubSocketUrl(url, "/ws"), { maxPayload: 64 * 1024 * 1024 });
    } catch (e: any) {
      client.send({ t: "hub.denied", message: `Not a hub address: ${e?.message ?? e}` });
      return;
    }
    ws = socket;
    socket.on("open", () => {
      everOpened = true;
      delay = 500;
      for (const m of queue.splice(0)) socket.send(JSON.stringify(m));
    });
    socket.on("message", (raw) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse((raw as Buffer).toString());
      } catch {
        return;
      }
      if (msg.t === "artifact.file" && exporting) {
        exporting({ name: msg.name, data: msg.data });
        exporting = undefined;
        return;
      }
      client.send(msg);
    });
    socket.on("error", (e) => {
      if (!everOpened) client.send({ t: "hub.denied", message: `Couldn't reach ${url}: ${e.message}` });
    });
    socket.on("close", () => {
      exporting?.(undefined);
      exporting = undefined;
      if (closed || !everOpened) return;
      client.send({ t: "error", message: "Lost the connection to the hub; reconnecting…" });
      setTimeout(connect, (delay = Math.min(delay * 2, 10_000)));
    });
  };
  connect();

  const send = (msg: ClientMsg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else queue.push(msg);
  };

  return {
    hub: url,
    receive(msg: ClientMsg) {
      if (msg.t === "hub.join") onJoin(String(msg.name ?? ""), String(msg.token ?? ""));
      send(msg);
    },
    close() {
      closed = true;
      ws?.close();
    },
    session: undefined,
    /** The open artifact as a `.caddis` file, for File → Save. */
    exportArtifact(): Promise<{ name: string; data: string } | undefined> {
      exporting?.(undefined);
      return new Promise((resolve) => {
        exporting = resolve;
        send({ t: "artifact.export" });
      });
    },
  };
}
