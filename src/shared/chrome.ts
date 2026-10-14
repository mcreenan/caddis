import {
  ANCHORS,
  FONTS,
  SHADOWS,
  type Anchor,
  type ChromeApplyResult,
  type ChromeComponent,
  type ChromeProps,
} from "./protocol";

/** Immutable base values; "Reset overlay style" returns to these. */
export const CHROME_BASE: Record<
  ChromeComponent,
  Required<Omit<ChromeProps, "height" | "mode">> & { height?: number; mode?: "full" | "mini" }
> = {
  prompt: {
    anchor: "bottom",
    x: 0,
    y: 0,
    width: 680,
    opacity: 1,
    accent: "#7c9cff",
    background: "rgba(22, 23, 30, 0.92)",
    foreground: "#e6e6ea",
    blur: 16,
    radius: 14,
    font: "system",
    fontSize: 15,
    shadow: "soft",
  },
  history: {
    anchor: "top-right",
    x: 0,
    y: 0,
    width: 380,
    height: 560,
    opacity: 1,
    accent: "#7c9cff",
    background: "rgba(22, 23, 30, 0.88)",
    foreground: "#e6e6ea",
    blur: 16,
    radius: 14,
    font: "system",
    fontSize: 13,
    shadow: "soft",
    mode: "full",
  },
};

export const CHROME_LIMITS = {
  opacity: [0.6, 1],
  blur: [0, 40],
  radius: [0, 32],
  fontSize: [12, 20],
  width: { prompt: [320, 1400], history: [260, 1000] } as Record<ChromeComponent, [number, number]>,
  height: { history: [180, 1600] },
  offset: [-4000, 4000],
  /** Fraction of each axis that must stay on-screen (0.9 x 0.9 = 81% of the area). */
  onscreen: 0.9,
  anchors: ANCHORS,
  fonts: FONTS,
  shadows: SHADOWS,
} as const;

/** Margin between an anchored component and the viewport edge. */
export const CHROME_MARGIN = 16;
/** Height used for the prompt when it cannot be measured (server-side echo). */
export const PROMPT_EST_HEIGHT = 54;

/** z-index of chrome. The canvas iframe sits at z-index 0 and can never paint above it. */
export const CHROME_Z = 2147483000;
/** z-index of host-owned UI (titlebar, menus, toasts), above anything the agent can style. */
export const HOST_Z = 2147483600;

export const FONT_STACKS: Record<(typeof FONTS)[number], string> = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const COLOUR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(\s*[-\d.%\s,/a-z]*\)|[a-z]{3,24})$/i;

export function isSafeColour(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && COLOUR_RE.test(v.trim()) && !/url|var|expression|attr/i.test(v);
}

const KEYS = [
  "anchor",
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "accent",
  "background",
  "foreground",
  "blur",
  "radius",
  "font",
  "fontSize",
  "shadow",
  "mode",
];

/**
 * Viewport-independent normalisation: drop unknown keys, clamp ranges, reject
 * unsafe values. `null` for a key resets it to base. Notes describe every change.
 */
export function normaliseChromeProps(
  component: ChromeComponent,
  input: Record<string, unknown>,
): { props: ChromeProps; reset: (keyof ChromeProps)[]; notes: string[] } {
  const props: ChromeProps = {};
  const reset: (keyof ChromeProps)[] = [];
  const notes: string[] = [];
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!KEYS.includes(k)) {
      notes.push(`${k}: not a chrome property (allowed: ${KEYS.join(", ")}), ignored`);
      continue;
    }
    if (v === null) {
      reset.push(k as keyof ChromeProps);
      continue;
    }
    if (v === undefined) continue;
    const range = (lo: number, hi: number, round = false) => {
      if (!num(v)) return void notes.push(`${k}: expected a number, ignored`);
      let c = clamp(v, lo, hi);
      if (round) c = Math.round(c);
      if (c !== v) notes.push(`${k}: ${v} clamped to ${c} (allowed ${lo}..${hi})`);
      (props as Record<string, unknown>)[k] = c;
    };
    const oneOf = (list: readonly string[]) => {
      if (typeof v === "string" && list.includes(v)) (props as Record<string, unknown>)[k] = v;
      else notes.push(`${k}: expected one of ${list.join("|")}, ignored`);
    };
    switch (k) {
      case "anchor":
        oneOf(ANCHORS);
        break;
      case "x":
      case "y":
        range(CHROME_LIMITS.offset[0], CHROME_LIMITS.offset[1], true);
        break;
      case "width":
        range(...CHROME_LIMITS.width[component], true);
        break;
      case "height":
        if (component === "history") range(...CHROME_LIMITS.height.history, true);
        else notes.push("height: the prompt's height follows its content, ignored");
        break;
      case "opacity":
        range(CHROME_LIMITS.opacity[0], CHROME_LIMITS.opacity[1]);
        break;
      case "blur":
        range(CHROME_LIMITS.blur[0], CHROME_LIMITS.blur[1]);
        break;
      case "radius":
        range(CHROME_LIMITS.radius[0], CHROME_LIMITS.radius[1]);
        break;
      case "fontSize":
        range(CHROME_LIMITS.fontSize[0], CHROME_LIMITS.fontSize[1]);
        break;
      case "accent":
      case "background":
      case "foreground":
        if (isSafeColour(v)) (props as Record<string, unknown>)[k] = v.trim();
        else notes.push(`${k}: not an allowed CSS colour (hex, rgb(), hsl(), oklch() or a name), ignored`);
        break;
      case "font":
        oneOf(FONTS);
        break;
      case "shadow":
        oneOf(SHADOWS);
        break;
      case "mode":
        if (component !== "history") notes.push("mode: history only, ignored");
        else oneOf(["full", "mini"]);
        break;
    }
  }
  return { props, reset, notes };
}

export function effectiveProps(component: ChromeComponent, overrides: ChromeProps) {
  return { ...CHROME_BASE[component], ...overrides } as ChromeApplyResult["applied"];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Place a component for a viewport: anchor + offset, then clamp so at least
 * 90% of each axis stays on-screen and the size fits the viewport.
 */
export function layoutChrome(
  component: ChromeComponent,
  p: ChromeApplyResult["applied"],
  vw: number,
  vh: number,
  measuredHeight?: number,
): Rect {
  const [minW] = CHROME_LIMITS.width[component];
  const width = clamp(p.width, Math.min(minW, vw), Math.max(Math.min(minW, vw), vw - 2 * 8));
  const rawH =
    component === "history" ? (p.height ?? CHROME_BASE.history.height!) : (measuredHeight ?? PROMPT_EST_HEIGHT);
  const height =
    component === "history"
      ? clamp(
          rawH,
          Math.min(CHROME_LIMITS.height.history[0], vh),
          Math.max(Math.min(CHROME_LIMITS.height.history[0], vh), vh - 2 * CHROME_MARGIN),
        )
      : Math.min(rawH, vh);
  const a: Anchor = p.anchor;
  const hx = a.endsWith("left") || a === "left" ? "l" : a.endsWith("right") || a === "right" ? "r" : "c";
  const vy = a.startsWith("top") ? "t" : a.startsWith("bottom") ? "b" : "c";
  let x = hx === "l" ? CHROME_MARGIN : hx === "r" ? vw - width - CHROME_MARGIN : (vw - width) / 2;
  let y = vy === "t" ? CHROME_MARGIN : vy === "b" ? vh - height - CHROME_MARGIN : (vh - height) / 2;
  x += p.x;
  y += p.y;
  const slackX = width * (1 - CHROME_LIMITS.onscreen);
  const slackY = height * (1 - CHROME_LIMITS.onscreen);
  x = clamp(x, -slackX, vw - width + slackX);
  y = clamp(y, -slackY, vh - height + slackY);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Re-validate props before applying them as CSS (defence in depth on the client). */
export function safeCssProps(p: ChromeApplyResult["applied"]) {
  return {
    opacity: clamp(num(p.opacity) ? p.opacity : 1, CHROME_LIMITS.opacity[0], 1),
    blur: clamp(num(p.blur) ? p.blur : 0, 0, CHROME_LIMITS.blur[1]),
    radius: clamp(num(p.radius) ? p.radius : 0, 0, CHROME_LIMITS.radius[1]),
    fontSize: clamp(num(p.fontSize) ? p.fontSize : 14, CHROME_LIMITS.fontSize[0], CHROME_LIMITS.fontSize[1]),
    accent: isSafeColour(p.accent) ? p.accent : "#7c9cff",
    background: isSafeColour(p.background) ? p.background : "rgba(22,23,30,.9)",
    foreground: isSafeColour(p.foreground) ? p.foreground : "#e6e6ea",
    font: FONT_STACKS[p.font] ?? FONT_STACKS.system,
    shadow: SHADOWS.includes(p.shadow) ? p.shadow : "soft",
  };
}
