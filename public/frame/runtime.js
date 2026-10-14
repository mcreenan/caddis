// Agent Canvas iframe runtime (module). Sets up the mode (html / canvas / 3d),
// then runs the agent's script as an async function body.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const ac = window.__ac;
const state = JSON.parse(document.getElementById("__ac_state").textContent);
window.THREE = THREE;

const frameFns = [];
const resizeFns = [];
const api = { width: innerWidth, height: innerHeight, dpr: Math.min(devicePixelRatio || 1, 2), mode: state.mode, version: state.version };
const onFrame = (fn) => frameFns.push(fn);
const onResize = (fn) => resizeFns.push(fn);
const scope = { THREE, d3: window.d3, api, onFrame, onResize };

/** Fullscreen surface outside <body>, so agent markup in body overlays it and patches never touch it. */
function surface(el) {
  el.setAttribute("data-ac-internal", "");
  el.id = "__ac_surface";
  document.documentElement.insertBefore(el, document.body);
  return el;
}

let afterFrame = () => {};
let resizeSurface = () => {};

if (state.mode === "canvas") {
  const canvas = surface(document.createElement("canvas"));
  const kind = state.context || "2d";
  const ctx = canvas.getContext(kind, kind === "2d" ? undefined : { preserveDrawingBuffer: true, antialias: true });
  resizeSurface = () => {
    canvas.width = Math.round(api.width * api.dpr);
    canvas.height = Math.round(api.height * api.dpr);
    if (kind === "2d") ctx.setTransform(api.dpr, 0, 0, api.dpr, 0, 0);
    else ctx.viewport(0, 0, canvas.width, canvas.height);
  };
  resizeSurface();
  Object.assign(scope, { canvas, ctx, gl: kind === "2d" ? undefined : ctx });
  ac.snapshotHook = () => canvas;
} else if (state.mode === "3d") {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(api.dpr);
  renderer.setSize(api.width, api.height, false);
  surface(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, api.width / api.height, 0.1, 2000);
  camera.position.set(0, 1.5, 5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  resizeSurface = () => {
    renderer.setSize(api.width, api.height, false);
    camera.aspect = api.width / api.height;
    camera.updateProjectionMatrix();
  };
  afterFrame = () => {
    controls.update();
    renderer.render(scene, camera);
  };
  Object.assign(scope, { renderer, scene, camera, controls, canvas: renderer.domElement });
  ac.snapshotHook = () => {
    renderer.render(scene, camera); // render + read in the same task: no preserveDrawingBuffer needed
    return renderer.domElement;
  };
}

ac.scope = scope;

addEventListener("resize", () => {
  api.width = innerWidth;
  api.height = innerHeight;
  resizeSurface();
  for (const fn of resizeFns) {
    try {
      fn(api.width, api.height);
    } catch (e) {
      console.error(e);
    }
  }
});

let last = performance.now();
const failed = new Set();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const fn of frameFns) {
    if (failed.has(fn)) continue;
    try {
      fn(now / 1000, dt);
    } catch (e) {
      failed.add(fn); // report once, then stop calling it
      console.error(e);
    }
  }
  try {
    afterFrame();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(loop);
}

const AsyncFunction = (async () => {}).constructor;
let ready = false;
const markReady = () => {
  if (ready) return;
  ready = true;
  ac.markReady();
};
const run = (async () => {
  if (!state.script.trim()) return;
  const names = Object.keys(scope);
  const fn = new AsyncFunction(...names, `${state.script}\n//# sourceURL=canvas-script.js`);
  await fn(...names.map((n) => scope[n]));
})().catch((e) => console.error(e));
requestAnimationFrame(loop);
// Ready = script settled and a frame or two painted. Timers cover throttled
// (hidden/background) frames and scripts that never resolve.
run.then(() => {
  requestAnimationFrame(() => requestAnimationFrame(markReady));
  setTimeout(markReady, 300);
});
setTimeout(markReady, 3000);
