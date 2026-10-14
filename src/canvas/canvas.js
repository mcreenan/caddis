// `import canvas from "canvas"` — the same API object modules get as `ctx`'s
// shared parts (data, emit, chrome, asset). Set up by runtime.js before any agent module runs.
const canvas = globalThis.canvas;
export default canvas;
export const { data, emit, chrome, asset } = canvas;
