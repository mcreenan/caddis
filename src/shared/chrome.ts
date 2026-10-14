import type { ChromeComponent, ChromeProps } from "./protocol";

export const CHROME_LIMITS = {
  opacity: [0.6, 1],
  blur: [0, 40],
  radius: [0, 32],
  minWidth: { prompt: 280, history: 240 } as Record<ChromeComponent, number>,
  minHeight: { prompt: 44, history: 160 } as Record<ChromeComponent, number>,
  maxWidth: 1600,
  maxHeight: 2000,
  /** Fraction of each axis that must stay on-screen (0.9 * 0.9 = 81% of area). */
  onscreen: 0.9,
} as const;

/** z-index of chrome. The canvas is an iframe at z-index 0 and can never paint above it. */
export const CHROME_Z = 2147483000;
export const SAFE_Z = 2147483600;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const COLOUR_RE =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(\s*[-\d.%\s,/a-z]*\)|[a-z]{3,24})$/i;

export function isSafeColour(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && COLOUR_RE.test(v.trim()) && !/url|var|expression/i.test(v);
}

/**
 * Static normalisation (no viewport knowledge): drop unknown keys, clamp ranges,
 * reject unsafe colours. Returns the normalised props plus notes on anything changed.
 */
export function normaliseChromeProps(component: ChromeComponent, input: Record<string, unknown>): { props: ChromeProps; notes: string[] } {
  const props: ChromeProps = {};
  const notes: string[] = [];
  const range = (key: "opacity" | "blur" | "radius") => {
    const v = input[key];
    if (v === undefined) return;
    if (!num(v)) return void notes.push(`${key}: not a number, ignored`);
    const [lo, hi] = CHROME_LIMITS[key];
    const c = clamp(v, lo, hi);
    if (c !== v) notes.push(`${key} clamped to ${c}`);
    props[key] = c;
  };
  range("opacity");
  range("blur");
  range("radius");
  for (const key of ["x", "y"] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (!num(v)) notes.push(`${key}: not a number, ignored`);
    else props[key] = Math.round(clamp(v, -5000, 10000));
  }
  const size = (key: "width" | "height", min: number, max: number) => {
    const v = input[key];
    if (v === undefined) return;
    if (!num(v)) return void notes.push(`${key}: not a number, ignored`);
    const c = Math.round(clamp(v, min, max));
    if (c !== Math.round(v)) notes.push(`${key} clamped to ${c}`);
    props[key] = c;
  };
  size("width", CHROME_LIMITS.minWidth[component], CHROME_LIMITS.maxWidth);
  if (component === "history") size("height", CHROME_LIMITS.minHeight.history, CHROME_LIMITS.maxHeight);
  else if (input.height !== undefined) notes.push("height: prompt height follows its content, ignored");
  for (const key of ["accent", "background", "foreground"] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (isSafeColour(v)) props[key] = v.trim();
    else notes.push(`${key}: not an allowed CSS colour, ignored`);
  }
  if (input.mini !== undefined) {
    if (component !== "history") notes.push("mini: history only, ignored");
    else props.mini = Boolean(input.mini);
  }
  for (const k of Object.keys(input)) {
    if (!["x", "y", "width", "height", "opacity", "accent", "background", "foreground", "blur", "radius", "mini"].includes(k))
      notes.push(`${k}: not an allowed property, ignored`);
  }
  return { props, notes };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Viewport clamp, applied at layout time on the client. */
export function clampRect(component: ChromeComponent, r: Rect, vw: number, vh: number): Rect {
  const minW = Math.min(CHROME_LIMITS.minWidth[component], vw);
  const minH = Math.min(CHROME_LIMITS.minHeight[component], vh);
  const width = clamp(r.width, minW, Math.max(minW, vw));
  const height = clamp(r.height, minH, Math.max(minH, vh));
  const slackX = width * (1 - CHROME_LIMITS.onscreen);
  const slackY = height * (1 - CHROME_LIMITS.onscreen);
  const x = clamp(r.x, -slackX, vw - width + slackX);
  const y = clamp(r.y, -slackY, vh - height + slackY);
  return { x, y, width, height };
}
