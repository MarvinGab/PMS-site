// Curated palettes the admin can pick from. Each palette defines:
//   primary      — the single hex used for buttons, active tabs, send buttons, etc.
//   primaryDark  — a darker variant for gradients + pressed states.
//   heroFrom/Mid/To — the three stops for the employee-page hero gradient.
//   heroHighlight   — the secondary radial glow tucked into the top-right of the hero.
//
// A seventh "custom" option (not in this list) lets the admin pick a single primary and we
// derive the gradient from it with HSL math. See deriveCustomPalette() below.
export const BRAND_PALETTES = [
  {
    id: 'indigo',
    name: 'Indigo',
    description: 'The default — confident, professional blue.',
    primary: '#4F46E5',
    primaryDark: '#4338CA',
    heroFrom: '#0284C7',
    heroMid: '#2563EB',
    heroTo: '#14B8A6',
    heroHighlight: 'rgba(16,185,129,0.34)',
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cool cyan through periwinkle. Reads fresh + calm.',
    primary: '#0EA5E9',
    primaryDark: '#0369A1',
    heroFrom: '#06B6D4',
    heroMid: '#0EA5E9',
    heroTo: '#6366F1',
    heroHighlight: 'rgba(99,102,241,0.32)',
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Earthy greens — grounded and growth-oriented.',
    primary: '#15803D',
    primaryDark: '#166534',
    heroFrom: '#0F766E',
    heroMid: '#16A34A',
    heroTo: '#84CC16',
    heroHighlight: 'rgba(132,204,22,0.30)',
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm amber to coral. Energetic, distinct.',
    primary: '#EA580C',
    primaryDark: '#C2410C',
    heroFrom: '#F59E0B',
    heroMid: '#EA580C',
    heroTo: '#DB2777',
    heroHighlight: 'rgba(219,39,119,0.28)',
  },
  {
    id: 'amethyst',
    name: 'Amethyst',
    description: 'Violet through rose. Creative + premium.',
    primary: '#7C3AED',
    primaryDark: '#6D28D9',
    heroFrom: '#8B5CF6',
    heroMid: '#A855F7',
    heroTo: '#EC4899',
    heroHighlight: 'rgba(236,72,153,0.30)',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Deep slate with a subtle indigo glow. Enterprise-quiet.',
    primary: '#334155',
    primaryDark: '#1E293B',
    heroFrom: '#1E293B',
    heroMid: '#0F172A',
    heroTo: '#334155',
    heroHighlight: 'rgba(99,102,241,0.22)',
  },
];

export const DEFAULT_PALETTE_ID = 'indigo';

export function getPaletteById(id) {
  return BRAND_PALETTES.find((p) => p.id === id) || BRAND_PALETTES[0];
}

// --- Hex utilities --------------------------------------------------------
function parseHex(hex) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return null;
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16),
  };
}
function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120){ r = x; g = c; }
  else if (h < 180){ g = c; b = x; }
  else if (h < 240){ g = x; b = c; }
  else if (h < 300){ r = x; b = c; }
  else             { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function shiftHsl(hex, { dh = 0, ds = 0, dl = 0 } = {}) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const hsl = rgbToHsl(rgb);
  const next = {
    h: (hsl.h + dh + 360) % 360,
    s: Math.max(0, Math.min(1, hsl.s + ds)),
    l: Math.max(0, Math.min(1, hsl.l + dl)),
  };
  return toHex(hslToRgb(next));
}

// Build a palette from a single custom primary. Picks complementary stops for the hero gradient
// so the result always reads as a cohesive theme, not a flat wash.
export function deriveCustomPalette(primary) {
  const hex = parseHex(primary) ? primary : BRAND_PALETTES[0].primary;
  const heroMid = hex;
  const heroFrom = shiftHsl(hex, { dh: -22, dl: 0.05 });
  const heroTo = shiftHsl(hex, { dh: 32, dl: 0.08 });
  const highlight = shiftHsl(hex, { dh: 20, dl: 0.15 });
  const highlightRgb = parseHex(highlight);
  return {
    id: 'custom',
    name: 'Custom',
    description: 'Your own accent colour.',
    primary: hex,
    primaryDark: shiftHsl(hex, { dl: -0.12 }),
    heroFrom,
    heroMid,
    heroTo,
    heroHighlight: highlightRgb ? `rgba(${highlightRgb.r},${highlightRgb.g},${highlightRgb.b},0.30)` : 'rgba(255,255,255,0.20)',
  };
}

// Normalise whatever is on the org record into a usable palette object. The org may store either
// a string id ('indigo') or a full palette object (custom choice).
export function resolveBrandPalette(stored) {
  if (!stored) return getPaletteById(DEFAULT_PALETTE_ID);
  if (typeof stored === 'string') return getPaletteById(stored);
  if (stored.id === 'custom' && stored.primary) return deriveCustomPalette(stored.primary);
  if (stored.id) return getPaletteById(stored.id);
  return getPaletteById(DEFAULT_PALETTE_ID);
}

// Build the hero CSS `background` string for a palette.
export function buildHeroGradient(palette) {
  const p = palette || getPaletteById(DEFAULT_PALETTE_ID);
  return `radial-gradient(circle at 12% 0%,rgba(255,255,255,0.34),transparent 31%), radial-gradient(circle at 82% 18%,${p.heroHighlight},transparent 26%), linear-gradient(135deg,${p.heroFrom} 0%,${p.heroMid} 56%,${p.heroTo} 100%)`;
}

// Build a small preview CSS background — smaller, lower-shadow version for swatch chips.
export function buildSwatchGradient(palette) {
  const p = palette || getPaletteById(DEFAULT_PALETTE_ID);
  return `linear-gradient(135deg,${p.heroFrom} 0%,${p.heroMid} 55%,${p.heroTo} 100%)`;
}

// ─── Hero model ─────────────────────────────────────────────────────────────
// The hero can be driven three ways:
//   { mode: 'palette', palette: {id, primary?} }  — preset or custom gradient (default)
//   { mode: 'solid',   solid:   '#RRGGBB' }       — a single flat colour
//   { mode: 'image',   image:   'data:...'  }     — an uploaded image
//
// If nothing is stored, we mirror the primary palette so the hero tracks the accent by default.
export function resolveHero(storedHero, fallbackPrimaryPalette) {
  const fallback = fallbackPrimaryPalette || getPaletteById(DEFAULT_PALETTE_ID);
  if (!storedHero || !storedHero.mode) {
    return { mode: 'palette', palette: fallback };
  }
  if (storedHero.mode === 'solid' && storedHero.solid) {
    return { mode: 'solid', solid: storedHero.solid };
  }
  if (storedHero.mode === 'image' && storedHero.image) {
    return { mode: 'image', image: storedHero.image };
  }
  // 'palette' (explicit or defaulted) — resolve inner palette, falling back to the primary.
  const inner = storedHero.palette ? resolveBrandPalette(storedHero.palette) : fallback;
  return { mode: 'palette', palette: inner };
}

// Render the hero `background` CSS given a resolved hero descriptor. For image mode we also
// return a darken overlay so white text stays legible regardless of what was uploaded.
export function buildHeroBackground(resolved) {
  if (!resolved) return { background: buildHeroGradient(getPaletteById(DEFAULT_PALETTE_ID)) };
  if (resolved.mode === 'solid') {
    const base = resolved.solid;
    return {
      // Layered gradient keeps the subtle highlight vignette so the hero never looks flat-paint.
      background: `radial-gradient(circle at 12% 0%, rgba(255,255,255,0.22), transparent 34%), ${base}`,
    };
  }
  if (resolved.mode === 'image') {
    return {
      // Dark overlay sits on top of the image so hero text stays legible; user's image is the
      // base layer. Darken strength is conservative (34%) — enough for white text against most
      // photos without turning the image to mud.
      background: `linear-gradient(135deg, rgba(15,23,42,0.45), rgba(15,23,42,0.30)), url("${resolved.image}") center/cover no-repeat`,
    };
  }
  // 'palette' mode
  return { background: buildHeroGradient(resolved.palette) };
}

// ─── Accent fill (gradient vs solid) ────────────────────────────────────────
// Call sites that previously wrote `linear-gradient(135deg, primary, primaryDark)` should go
// through this helper so the global "solid fill" toggle flips them all at once.
export function fillAccent(palette, { gradient = true } = {}) {
  const p = palette || getPaletteById(DEFAULT_PALETTE_ID);
  if (!gradient) return p.primary;
  return `linear-gradient(135deg, ${p.primary}, ${p.primaryDark})`;
}

// ─── Card accent ────────────────────────────────────────────────────────────
// Three modes mirror what actually exists on the goal-card anatomy (white body + coloured
// perspective stripe) rather than inventing abstract washes:
//
//   'minimal'   — no left stripe, no body tint. Pure white card.
//   'default'   — coloured left stripe per perspective, white body. The historical look.
//   'colourful' — thicker stripe + a subtle tinted body wash.
//
// This helper returns ONLY the body/border tint. The coloured stripe itself is rendered
// separately by the card (as a left-edge bar), because its width also changes with the mode.
// Callers should check the mode to decide stripe width.
export function cardAccentStyle(mode, tint) {
  if (!tint || !mode || mode === 'minimal' || mode === 'default') return {};
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(tint || ''));
  if (!m) return {};
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  // 'colourful' — subtle gradient wash + matching border. Opacity is kept low so the card
  // body stays readable; the stripe does the heavy lifting for distinctness.
  return {
    background: `linear-gradient(90deg, rgba(${r},${g},${b},0.10) 0%, rgba(${r},${g},${b},0.03) 75%)`,
    borderColor: `rgba(${r},${g},${b},0.28)`,
  };
}

// Runtime stripe width (in px) per mode. The employee goal card renders a fixed-width bar on
// the left edge coloured by the perspective; we just widen or hide it based on the chosen mode.
export function cardStripeWidth(mode) {
  if (mode === 'minimal') return 0;
  if (mode === 'colourful') return 6;
  return 4; // 'default' + unknown fallback
}

// Back-compat: older stored values used different mode names. Map them to the new ids so an
// existing org with `brandCards: 'neutral'` keeps rendering the way it used to (no stripe).
export function normalizeCardsMode(mode) {
  if (mode === 'minimal' || mode === 'default' || mode === 'colourful') return mode;
  if (mode === 'neutral') return 'minimal';
  if (mode === 'tinted')  return 'default';
  return 'default';
}

export const CARD_ACCENT_MODES = [
  { id: 'minimal',   name: 'Minimal',   description: 'Pure white card — no coloured stripe.' },
  { id: 'default',   name: 'Default',   description: 'Coloured left stripe per perspective, white body.' },
  { id: 'colourful', name: 'Colourful', description: 'Thicker stripe + a subtle tinted body wash.' },
];

// Non-semantic swatches for previewing card modes. NEVER use green / amber / red here —
// those tones are reserved for approved / pending / rejected statuses on the real card.
export const CARD_PREVIEW_TINTS = ['#6366F1', '#0891B2'];
