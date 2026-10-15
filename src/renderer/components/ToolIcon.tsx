/** Line icons (24px grid, stroked) for known tools; anything else gets the plug. */
const P: Record<string, string> = {
  term: "M4 17l6-6-6-6M12 19h8",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  edit: "M16.5 3.5l4 4L8 20H4v-4zM14 6l4 4",
  write: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 12v6M9 15h6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 13h6",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  bot: "M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM12 4v4M9 14h.01M15 14h.01",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  zap: "M13 2L4 14h7l-1 8 9-12h-7z",
  sliders:
    "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  db: "M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  todo: "M10 6h10M10 12h10M10 18h10M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  spark: "M12 2v6M12 16v6M2 12h6M16 12h6M5 5l3.5 3.5M15.5 15.5L19 19M5 19l3.5-3.5M15.5 8.5L19 5",
  scroll: "M8 3h11a2 2 0 0 1 2 2v1h-4M17 6v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1h10M8 3a2 2 0 0 0-2 2v13M10 9h4M10 13h4",
  up: "M12 19V5M5 12l7-7 7 7",
  queue: "M4 7h10M4 12h10M4 17h6M17 14v6M14 17h6",
};

const BY_TOOL: Record<string, keyof typeof P> = {
  Bash: "term",
  BashOutput: "term",
  KillShell: "term",
  Read: "file",
  NotebookRead: "file",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Grep: "search",
  Glob: "folder",
  LS: "folder",
  WebFetch: "globe",
  WebSearch: "globe",
  Agent: "bot",
  Task: "bot",
  TodoWrite: "todo",
  ToolSearch: "search",
  canvas_view: "eye",
  canvas_stats: "eye",
  canvas_eval: "zap",
  canvas_dom: "layers",
  canvas_reload: "layers",
  canvas_set_mode: "layers",
  canvas_set_title: "edit",
  chrome_get: "sliders",
  chrome_set: "sliders",
  chrome_reset: "sliders",
  events_read: "db",
};

export function iconFor(tool: string): keyof typeof P {
  if (BY_TOOL[tool]) return BY_TOOL[tool];
  if (tool.startsWith("resource_")) return "layers";
  if (tool.startsWith("data_")) return "db";
  return "plug";
}

export function Icon({ name, className = "ic" }: { name: keyof typeof P; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

export const ToolIcon = ({ tool }: { tool: string }) => <Icon name={iconFor(tool)} />;
