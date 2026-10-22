import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CANVAS_MODES,
  resourceKind,
  type ArtifactInfo,
  type CanvasMode,
  type HubUser,
  type ProjectInfo,
  type Resource,
  type Revision,
} from "../shared/protocol";
import { sessionTitle } from "../core/artifact";
import type { Persisted } from "../core/session";
import { Repo, type GitAuthor } from "./git";

/**
 * Projects on disk. Each project is a git repository:
 *
 *   projects/<project>/project.json                 name, creator
 *   projects/<project>/artifacts/<artifact>/
 *     artifact.json                                 title, mode, timestamps
 *     canvas.json                                   every canvas file with its mime type
 *     canvas/<name>                                 the canvas files themselves
 *     data.json                                     the data store
 *     history.json                                  the conversation
 *
 * The live session state (undo stacks, activity log) is kept outside the
 * repositories, in state/<artifact>.json, and written to the tree on commit.
 */

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
}

interface ArtifactMeta {
  id: string;
  title: string;
  mode: CanvasMode;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

type ArtifactSnapshot = Pick<Persisted, "id" | "createdAt" | "title" | "canvas" | "data" | "history">;

interface CanvasEntry {
  name: string;
  mime: string;
  binary: boolean;
}

export const ID_RE = /^[\w-]{1,64}$/;
const NAME_MAX = 80;

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

export const gitAuthor = (name: string): GitAuthor => ({
  name,
  email: `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.|\.$/g, "") || "someone"
  }@caddis.local`,
});

export class ProjectStore {
  readonly projectsDir: string;
  readonly stateDir: string;
  private readonly projects = new Map<string, ProjectMeta>();
  private readonly repos = new Map<string, Repo>();
  /** artifact id -> project id */
  private readonly owners = new Map<string, string>();

  constructor(dir: string) {
    this.projectsDir = path.join(dir, "projects");
    this.stateDir = path.join(dir, "state");
    mkdirSync(this.projectsDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
    for (const id of readdirSync(this.projectsDir)) {
      const meta = readJson<ProjectMeta>(path.join(this.projectsDir, id, "project.json"));
      if (!meta || meta.id !== id) continue;
      this.projects.set(id, meta);
      const arts = path.join(this.projectsDir, id, "artifacts");
      if (existsSync(arts)) for (const a of readdirSync(arts)) if (ID_RE.test(a)) this.owners.set(a, id);
    }
  }

  private dir(projectId: string) {
    return path.join(this.projectsDir, projectId);
  }

  private artifactDir(projectId: string, artifactId: string) {
    return path.join(this.dir(projectId), "artifacts", artifactId);
  }

  repo(projectId: string) {
    let r = this.repos.get(projectId);
    if (!r) this.repos.set(projectId, (r = new Repo(this.dir(projectId))));
    return r;
  }

  has(projectId: string) {
    return this.projects.has(projectId);
  }

  projectOf(artifactId: string) {
    return this.owners.get(artifactId);
  }

  artifactIds(projectId: string) {
    return [...this.owners].filter(([, p]) => p === projectId).map(([a]) => a);
  }

  stateFile(artifactId: string) {
    return path.join(this.stateDir, `${artifactId}.json`);
  }

  info(projectId: string): ProjectInfo | undefined {
    const m = this.projects.get(projectId);
    if (!m) return undefined;
    const arts = this.artifacts(projectId);
    return {
      ...m,
      artifacts: arts.length,
      updatedAt: Math.max(m.createdAt, ...arts.map((a) => a.updatedAt)),
    };
  }

  list(): ProjectInfo[] {
    return [...this.projects.keys()].map((id) => this.info(id)!).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Artifacts as of their last commit (the hub overlays live titles for open ones). */
  artifacts(projectId: string): ArtifactInfo[] {
    return this.artifactIds(projectId)
      .map((id) => {
        const m = readJson<ArtifactMeta>(path.join(this.artifactDir(projectId, id), "artifact.json"));
        return {
          id,
          projectId,
          title: m?.title ?? "Untitled",
          mode: m?.mode ?? "html",
          createdAt: m?.createdAt ?? 0,
          updatedAt: m?.updatedAt ?? 0,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(name: string, by: HubUser): Promise<ProjectMeta> {
    const clean = String(name ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MAX);
    if (!clean) throw new Error("a project needs a name");
    const meta: ProjectMeta = { id: randomUUID(), name: clean, createdAt: Date.now(), createdBy: by.name };
    const dir = this.dir(meta.id);
    mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    writeFileSync(path.join(dir, "project.json"), JSON.stringify(meta, null, 2) + "\n");
    const repo = this.repo(meta.id);
    await repo.init();
    await repo.commit(["project.json"], `Create project ${clean}`, gitAuthor(by.name));
    this.projects.set(meta.id, meta);
    return meta;
  }

  adopt(projectId: string, artifactId: string) {
    this.owners.set(artifactId, projectId);
  }

  /** Write a session's state as files in its project's tree. */
  private writeArtifact(projectId: string, d: ArtifactSnapshot) {
    const dir = this.artifactDir(projectId, d.id);
    const prev = readJson<ArtifactMeta>(path.join(dir, "artifact.json"));
    rmSync(path.join(dir, "canvas"), { recursive: true, force: true });
    mkdirSync(path.join(dir, "canvas"), { recursive: true });
    const entries: CanvasEntry[] = [];
    for (const r of Object.values(d.canvas.resources).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, "canvas", r.name);
      mkdirSync(path.dirname(file), { recursive: true });
      const binary = r.base64 !== undefined;
      writeFileSync(file, binary ? Buffer.from(r.base64!, "base64") : (r.text ?? ""));
      entries.push({ name: r.name, mime: r.mime, binary });
    }
    const meta: ArtifactMeta = {
      id: d.id,
      title: sessionTitle(d),
      mode: d.canvas.mode,
      rev: d.canvas.rev,
      createdAt: d.createdAt,
      updatedAt: Date.now(),
    };
    // Keep the tree stable when only the timestamp would change.
    if (prev && JSON.stringify({ ...prev, updatedAt: 0 }) === JSON.stringify({ ...meta, updatedAt: 0 }))
      meta.updatedAt = prev.updatedAt;
    const json = (v: unknown) => JSON.stringify(v, null, 1) + "\n";
    writeFileSync(path.join(dir, "artifact.json"), json(meta));
    writeFileSync(path.join(dir, "canvas.json"), json(entries));
    writeFileSync(path.join(dir, "data.json"), json(d.data));
    writeFileSync(path.join(dir, "history.json"), json(d.history));
  }

  /** Commit the artifact as it is now: the state is copied at once and written to the tree in turn with other commits. */
  commitArtifact(projectId: string, d: Readonly<Persisted>, message: string, author: GitAuthor) {
    const snap: ArtifactSnapshot = structuredClone({
      id: d.id,
      createdAt: d.createdAt,
      title: d.title,
      canvas: d.canvas,
      data: d.data,
      history: d.history,
    });
    return this.repo(projectId).commit([`artifacts/${d.id}`], message, author, () =>
      this.writeArtifact(projectId, snap),
    );
  }

  async revisions(projectId: string, artifactId: string): Promise<Revision[]> {
    return this.repo(projectId).log(`artifacts/${artifactId}`);
  }

  /** The canvas and data store of an artifact as of `commit`. */
  async readRevision(projectId: string, artifactId: string, commit: string) {
    const repo = this.repo(projectId);
    const base = `artifacts/${artifactId}`;
    const json = async <T>(file: string) => {
      const b = await repo.show(commit, `${base}/${file}`);
      return b ? (JSON.parse(b.toString("utf8")) as T) : undefined;
    };
    const meta = await json<ArtifactMeta>("artifact.json");
    const entries = await json<CanvasEntry[]>("canvas.json");
    if (!meta || !entries) throw new Error(`${commit.slice(0, 8)} has no saved state for this artifact`);
    const resources: Record<string, Resource> = {};
    for (const e of entries) {
      const b = (await repo.show(commit, `${base}/canvas/${e.name}`)) ?? Buffer.alloc(0);
      resources[e.name] = {
        name: e.name,
        kind: resourceKind(e.name),
        mime: e.mime,
        size: b.length,
        rev: 0,
        updatedAt: Date.now(),
        ...(e.binary ? { base64: b.toString("base64") } : { text: b.toString("utf8") }),
      };
    }
    return {
      mode: CANVAS_MODES.includes(meta.mode) ? meta.mode : "html",
      resources,
      data: (await json<Record<string, unknown>>("data.json")) ?? {},
    };
  }
}
