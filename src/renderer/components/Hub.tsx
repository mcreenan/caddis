import { useState } from "react";
import type { AgentInfo, ArtifactInfo, ProjectInfo } from "../../shared/protocol";
import {
  connectHub,
  createArtifact,
  createProject,
  hubJoin,
  openArtifact,
  openProject,
  openProjects,
} from "../controller";
import { useMyAgents, useUi } from "../store";
import { savedHub, transport } from "../transport";
import { ProviderIcon } from "./ProviderIcon";

/**
 * Hub screens (docs/HUB.md): joining, the project list and a project's
 * artifacts. Inside an artifact the usual canvas, prompt and history take
 * over, with the project and the people in it in the titlebar.
 */

export function ago(ts: number) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** A stable hue per person, for their avatar. */
export function hue(id: string) {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** The desktop app, which can switch a window between this machine and a hub. */
const DESKTOP = transport.platform === "electron";

export function Avatar({ id, name, title }: { id: string; name: string; title?: string }) {
  return (
    <span className="avatar" style={{ ["--h" as string]: hue(id) }} title={title ?? name}>
      {initials(name)}
    </span>
  );
}

/** Desktop app on its own core: offer to connect to a hub. */
export function ConnectHubLink() {
  if (!DESKTOP) return null;
  return (
    <button
      type="button"
      className="link"
      data-testid="connect-hub"
      onClick={() => useUi.setState({ phase: "join", hubError: undefined })}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
      </svg>
      Connect to a hub…
    </button>
  );
}

export function JoinCard() {
  const hub = useUi((s) => s.hub);
  const error = useUi((s) => s.hubError);
  const saved = savedHub();
  // The desktop app needs the hub's address; a browser is already on it.
  const needsUrl = DESKTOP && !hub;
  const [url, setUrl] = useState(saved?.url ?? "");
  const [name, setName] = useState(saved?.name ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const ready = name.trim() && token.trim() && (!needsUrl || url.trim());
  const submit = () => {
    if (!ready) return;
    const login = { name: name.trim(), token: token.trim() };
    if (needsUrl) connectHub({ ...login, url: normaliseUrl(url) });
    else hubJoin({ ...login, url: saved?.url });
  };
  return (
    <form
      className="hub-card join"
      data-testid="hub-join"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 className="start-title">{hub ? `Join ${hub.name}` : "Connect to a hub"}</h1>
      <p className="hub-lede">
        A hub keeps projects, lets people work on the same canvas, and records every change in git. Agents still run on
        your own machine.
      </p>
      {needsUrl && (
        <label className="field">
          <span>Hub address</span>
          <input
            autoFocus
            value={url}
            placeholder="http://mothership:5318"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            data-testid="hub-url"
          />
        </label>
      )}
      <label className="field">
        <span>Your name</span>
        <input
          autoFocus={!needsUrl}
          value={name}
          maxLength={40}
          placeholder="Shown to everyone, and on your agent"
          onChange={(e) => setName(e.target.value)}
          data-testid="hub-name"
        />
      </label>
      <label className="field">
        <span>Access token</span>
        <input
          type="password"
          value={token}
          placeholder="Printed when the hub starts"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
          data-testid="hub-token"
        />
      </label>
      {error && <div className="err">{error}</div>}
      <div className="hub-actions">
        {DESKTOP && (
          <button type="button" className="link" onClick={() => connectHub(undefined)}>
            Use Caddis on this machine
          </button>
        )}
        <span className="composer-gap" />
        <button type="submit" className="btn primary" disabled={!ready} data-testid="hub-connect">
          {hub ? "Join" : "Connect"}
        </button>
      </div>
    </form>
  );
}

function normaliseUrl(u: string) {
  const t = u.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(t) ? t : `http://${t}`;
}

/** The people connected to the hub, by their agents. */
function AgentsLine() {
  const agents = useUi((s) => s.agents);
  const mine = useMyAgents();
  return (
    <div className="hub-agents" data-testid="hub-agents">
      {agents.length === 0 ? (
        <span className="muted">No agents connected yet.</span>
      ) : (
        agents.map((a) => <AgentChip key={a.id} agent={a} />)
      )}
      {mine.length === 0 && (
        <span className="muted hub-hint">
          {DESKTOP
            ? "Your agents connect once this app has joined."
            : "To bring your agents, run npm run agent -- --hub <this address> --name <you> --token <token> on your machine."}
        </span>
      )}
    </div>
  );
}

export function AgentChip({ agent }: { agent: AgentInfo }) {
  const ps = agent.providers.filter((p) => p.enabled);
  return (
    <span className={`agent-chip${agent.busyIn ? " busy" : ""}`} title={ps.map((p) => p.label).join(", ")}>
      <Avatar id={agent.owner.id} name={agent.owner.name} />
      {agent.label}
      {ps.map((p) => (
        <ProviderIcon key={p.id} id={p.id} label={p.label} size={12} />
      ))}
    </span>
  );
}

export function ProjectList() {
  const { projects, hub, me } = useUi();
  const [name, setName] = useState("");
  return (
    <div className="hub-card" data-testid="hub-projects">
      <div className="hub-head">
        <h1 className="start-title">Projects</h1>
        <span className="muted">
          {hub?.name}
          {me && ` · you're ${me.name}`}
        </span>
      </div>
      <form
        className="hub-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) createProject(name.trim());
        }}
      >
        <input
          value={name}
          placeholder="New project name"
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          data-testid="project-name"
        />
        <button type="submit" className="btn primary" disabled={!name.trim()} data-testid="project-create">
          Create project
        </button>
      </form>
      <div className="hub-list">
        {projects.length === 0 && <div className="muted hub-empty">No projects yet. Create the first one.</div>}
        {projects.map((p: ProjectInfo) => (
          <button key={p.id} type="button" className="hub-row" onClick={() => openProject(p.id)} data-testid="project">
            <span className="hub-row-name">{p.name}</span>
            <span className="muted">
              {p.artifacts} artifact{p.artifacts === 1 ? "" : "s"} · {ago(p.updatedAt)} · by {p.createdBy}
            </span>
          </button>
        ))}
      </div>
      <AgentsLine />
    </div>
  );
}

export function ProjectView() {
  const { project, artifacts } = useUi();
  return (
    <div className="hub-card" data-testid="hub-project">
      <button type="button" className="link hub-back" onClick={openProjects}>
        ‹ All projects
      </button>
      <div className="hub-head">
        <h1 className="start-title">{project?.name ?? "…"}</h1>
        <button
          type="button"
          className="btn primary"
          disabled={!project}
          onClick={createArtifact}
          data-testid="artifact-create"
        >
          New artifact
        </button>
      </div>
      <div className="hub-grid">
        {project && artifacts.length === 0 && (
          <div className="muted hub-empty">No artifacts yet. A new one opens an empty canvas to build in.</div>
        )}
        {artifacts.map((a: ArtifactInfo) => (
          <button
            key={a.id}
            type="button"
            className="hub-tile"
            onClick={() => openArtifact(a.id)}
            data-testid="artifact"
          >
            <span className="hub-tile-mode">{a.mode}</span>
            <span className="hub-row-name">{a.title}</span>
            <span className="muted">{ago(a.updatedAt)}</span>
          </button>
        ))}
      </div>
      <AgentsLine />
    </div>
  );
}
