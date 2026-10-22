# Caddis hub (prototype)

The hub is an optional server for working together. It keeps **projects**, each holding several **artifacts** (canvases). It lets several people work in the same artifact at once and records every change in a **git** repository per project. Caddis still works entirely on one machine without it.

The hub **runs no agents**. Each person's coding agents stay on their own machine, signed in with their own accounts. A turn run there is shown to everyone as "Matt's agent". People can message each other in an artifact, and agents can hand work to each other.

The types live in [`src/shared/protocol.ts`](../src/shared/protocol.ts) (UI ⇄ hub) and [`src/core/agentLink.ts`](../src/core/agentLink.ts) (agent host ⇄ hub). This file is the prose version.

```
 browser tab ─────────┐  WS /ws (Caddis protocol + hub messages)
 desktop app window ──┤  (main relays the window's IPC to /ws)        ┌──────────────────────────────┐
                      ├─────────────────────────────────────────────▶ │ hub (npm run hub)            │
                      │                                               │  projects/<id>/  git repo    │
 desktop app main ────┤  WS /agent (agent link)                       │  state/<artifact>.json       │
 npm run agent ───────┘◀────────────────────────────────────────────▶ │  Session + Room per artifact │
   └ Claude / Codex / ACP agents, run here, in a folder here          └──────────────────────────────┘
```

## Run it

```sh
npm run hub                    # http://0.0.0.0:5318; prints the access token
```

| Variable           | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `CADDIS_HUB_DIR`   | Where projects and state live (default `hub-data/`)              |
| `CADDIS_HUB_TOKEN` | Access token (default: generated once and kept in `<dir>/token`) |
| `CADDIS_HUB_NAME`  | Name shown to people joining (default: the host name)            |
| `HOST`, `PORT`     | Listen address (`0.0.0.0`, `5318`)                               |

**Joining.**

- **From a browser:** open the hub's address and enter your name and the token. Projects and artifacts work fully this way. To also bring your own agents, run the agent link on your machine:

  ```sh
  npm run agent -- --hub http://<hub>:5318 --name Matt --token <token> [--cwd <dir>] [--no-handoffs]
  ```

- **From the desktop app:** choose **Connect to a hub…** on the start screen. The window then shows the hub, and the app lends its agents to the hub under your name by itself. Leave with **File → Disconnect from hub**.

## Model

- **Project:** a name and a git repository. **Artifact:** one canvas in a project. It is an ordinary Caddis session (canvas, data store, history, undo), held by the hub.
- **People.** Joining takes a name and the shared token. The name becomes your id (`Matt` → `matt`).
- **Agents.** An agent host connects with the same token and a name, and offers the providers signed in on that machine. Its label is "<name>'s agent".
- **Viewing.** Everyone viewing an artifact gets every change live: canvas edits, data writes, chrome, undo and history. This uses the session broadcast that already keeps several windows in sync. The titlebar shows who is viewing.
- **Prompting.** The prompt has a recipient chip; click it to cycle through the choices:
  - **One of your own agents, per provider** ("Matt's agent · Claude"): an agent turn.
  - **Everyone:** a message in the history, and no agent acts on it.

  Only an agent's owner can prompt it directly.

- **Turns.**
  - **One agent works on an artifact at a time.** Prompts for other agents queue behind the running turn, so two agents never edit the same canvas at once.
  - **Stopping a turn:** the agent's owner or the person who asked can stop it.
  - **What the agent receives:**
    - The messages people and other agents posted since its last turn, as a `<room>` block.
    - Canvas activity since then (who ticked what).
    - Then the message addressed to it, saying who it is from.
- **Agent to agent.** Hub agents get two more tools:
  - `room_who` lists the people viewing the artifact and the agents connected to the hub.
  - `agent_message(to, text)` posts a message addressed to another agent. That agent takes its turn after the current one.

  Agents can hand off at most 4 times in a row; after that, a person has to send a message. A host started with `--no-handoffs` refuses hand-offs.

- **Attribution.** History items carry `by` (person or agent) and, for messages, `to`. Canvas events carry the name of the person whose page caused them.

## Storage and revision history

```
<CADDIS_HUB_DIR>/
  token
  state/<artifact>.json                live session state (undo, activity log); not in git
  projects/<project>/                  a git repository
    project.json
    artifacts/<artifact>/
      artifact.json                    title, mode, timestamps
      canvas.json                      every canvas file and its mime type
      canvas/<name>                    the canvas files
      data.json                        the data store
      history.json                     the conversation
```

**When the hub commits:**

- Once per agent turn: anything pending is committed when the turn starts, and the turn's own changes when it ends. The agent is the author and the prompt is the subject.
- Other changes (people's edits, page data writes, messages): after 3 seconds of quiet, authored by the first person who changed something.

The commit author is a person or "<name>'s agent"; the committer is "Caddis hub". The tree is written inside the same serialized git queue as the commit, from a snapshot taken when the commit was asked for, so a fast follow-up turn can't leak into an earlier commit.

The titlebar's history button lists an artifact's commits. **Restore** puts the canvas and data store back as they were at that commit. The restore is one undoable step, and it is committed as a new revision, so history is never rewritten.

## Protocol

### UI ⇄ hub (`/ws`)

The hub speaks the ordinary Caddis protocol (v2) for everything inside an artifact. The only difference is that `welcome` carries `hub: { name }`, and the client must join before anything else:

| Client → hub                            | Reply / effect                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `hub.join {token, name}`                | `hub.joined {user, agents}` or `hub.denied {message}`                                |
| `project.list`                          | `projects {projects}`                                                                |
| `project.create {name}`                 | `project {project, artifacts}`; every client gets the new `projects` list            |
| `project.open {projectId}`              | `project {project, artifacts}`                                                       |
| `artifact.create {projectId}`           | `artifact.created {projectId, artifactId}`; the client then sends `hello`            |
| `hello {v, sessionId: artifactId}`      | `project`, then `session.snapshot`; everyone in the artifact gets `presence {users}` |
| `artifact.leave`                        | detaches; `presence` updates                                                         |
| `artifact.import {data, name}`          | a `.caddis` file becomes a new artifact in the open project; `artifact.opened`       |
| `prompt {text, to?: {agent, provider}}` | without `to`: a message for everyone; with `to`: a turn for that agent (yours only)  |
| `revisions.list`                        | `revisions {revisions}`                                                              |
| `revisions.restore {commit}`            | `canvas.state` and `data.changed` for everyone, then `revisions`                     |

**Pushed by the hub:**

- `agents {agents}`: whenever agents connect, disconnect or start working.
- `project {…}`: to everyone in a project after each commit, so artifact titles stay fresh.
- `presence {users}`: to an artifact's viewers.

### Agent host ⇄ hub (`/agent`, agent link v1)

| Host → hub                                    | Hub → host                                           |
| --------------------------------------------- | ---------------------------------------------------- |
| `hello {v, token, name, providers, handoffs}` | `welcome {hostId, user}` or `denied {message}`       |
| `providers {providers}` (discovery updates)   | `turn {turnId, artifactId, provider, text, context}` |
| `event {turnId, event}` (a `ProviderEvent`)   | `interrupt {turnId}`                                 |
| `tool {turnId, callId, name, args}`           | `tool.result {callId, output}`                       |

**How a host handles turns:**

- It keeps one provider conversation and one working directory per artifact and provider. They live in `<data>/hub-work/<artifact>`, or `--cwd`.
- It resumes that conversation across restarts (`<data>/hub-agent.json`).
- The agent sees the canvas tools plus `room_who` and `agent_message`. Every call goes back to the hub, which checks the arguments and runs it only while that turn is active.

**How the hub handles events:**

- It prefixes event ids with the turn id and attributes the events to the agent.
- It turns a host's `fatal` into a failed turn, so the next queued turn can start.
- If a host disconnects, its running turn ends and its queued turns are dropped.

## Trust and limits

This is a prototype for a trusted group on a LAN or tailnet.

**Trust:**

- **Identity.** The token is shared. Anyone who has it can join under any name, including someone else's, and then prompt that person's agent. Agents run in the same sandbox as in local Caddis: commands can write only inside their working directory, and network access is allowed. Don't share the token beyond people you'd let use your agent.
- **Access.** There are no per-project permissions. Every member can see and change every project.

**Concurrency:**

- **Edits.** Changes are last-writer-wins per resource and per data key, and the hub applies them in order. Agent turns are serialized per artifact, but people can still change data and chrome during a turn.
- **Undo.** Undo is shared by everyone in an artifact.

**Agents:**

- **Turn settings.** Hub turns use each provider's default model and effort; the prompt has no model picker yet.
- **Working files.** A turn's working directory is on the agent's machine and isn't shared. Only the canvas and data store are.

**Not built yet:**

- **The desktop app.** File → Save exports the open artifact to a `.caddis` file, and File → Open imports one into the open project. New windows join the same hub.
- **Collaboration features:** live cursors, comments, branching, and per-person undo.
