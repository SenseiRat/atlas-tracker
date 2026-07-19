import type { ThemeMode } from '../types';

export const profilePalette = [
  '#16a34a',
  '#0f766e',
  '#0891b2',
  '#0284c7',
  '#2563eb',
  '#4f46e5',
  '#7c3aed',
  '#9333ea',
  '#c026d3',
  '#db2777',
  '#e11d48',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#65a30d',
];
export const defaultProfileColor = profilePalette[0];

export function normalizeHexColor(raw: string | undefined, fallback = defaultProfileColor) {
  const value = (raw ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex);
  const parsed = Number.parseInt(normalized.slice(1), 16);
  return {
    r: (parsed >> 16) & 0xff,
    g: (parsed >> 8) & 0xff,
    b: parsed & 0xff,
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const toHex = (channel: number) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r: number, g: number, b: number) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    switch (max) {
      case rr:
        hue = ((gg - bb) / delta) % 6;
        break;
      case gg:
        hue = (bb - rr) / delta + 2;
        break;
      default:
        hue = (rr - gg) / delta + 4;
        break;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return { h: hue, s: saturation, l: lightness };
}

function hslToRgb(h: number, s: number, l: number) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) {
    r = chroma;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = chroma;
  } else if (hue < 180) {
    g = chroma;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = chroma;
  } else if (hue < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }

  return {
    r: (r + match) * 255,
    g: (g + match) * 255,
    b: (b + match) * 255,
  };
}

function adjustHexColor(
  hex: string,
  adjustments: {
    hueShift?: number;
    saturationDelta?: number;
    lightnessDelta?: number;
  },
) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const shiftedHue = h + (adjustments.hueShift ?? 0);
  const nextSaturation = clamp(s + (adjustments.saturationDelta ?? 0), 0, 1);
  const nextLightness = clamp(l + (adjustments.lightnessDelta ?? 0), 0, 1);
  const nextRgb = hslToRgb(shiftedHue, nextSaturation, nextLightness);
  return rgbToHex(nextRgb.r, nextRgb.g, nextRgb.b);
}

export function mixHexColors(first: string, second: string, ratio = 0.5) {
  const weight = clamp(ratio, 0, 1);
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  return rgbToHex(
    a.r * (1 - weight) + b.r * weight,
    a.g * (1 - weight) + b.g * weight,
    a.b * (1 - weight) + b.b * weight,
  );
}

export function contrastingColor(hex: string) {
  const normalized = normalizeHexColor(hex);
  const parsed = Number.parseInt(normalized.slice(1), 16);
  const r = (parsed >> 16) & 0xff;
  const g = (parsed >> 8) & 0xff;
  const b = parsed & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? '#0b1220' : '#f8fafc';
}

export function createProfileVisuals(baseColor: string, themeMode: ThemeMode) {
  const normalized = normalizeHexColor(baseColor);

  const country = themeMode === 'dark' ? mixHexColors(normalized, '#dbeafe', 0.12) : mixHexColors(normalized, '#0f172a', 0.08);
  const stateFill =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { saturationDelta: 0.08, lightnessDelta: -0.02 })
      : adjustHexColor(normalized, { saturationDelta: 0.06, lightnessDelta: -0.12 });
  const selectedRegion =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { saturationDelta: 0.04, lightnessDelta: 0.12 })
      : adjustHexColor(normalized, { saturationDelta: 0.02, lightnessDelta: 0.02 });
  const city =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: -18, saturationDelta: 0.04, lightnessDelta: 0.18 })
      : adjustHexColor(normalized, { hueShift: -14, saturationDelta: 0.08, lightnessDelta: -0.04 });
  const airportBase =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: 176, saturationDelta: 0.04, lightnessDelta: 0.14 })
      : adjustHexColor(normalized, { hueShift: 176, saturationDelta: -0.02, lightnessDelta: -0.08 });
  const airport =
    themeMode === 'dark'
      ? mixHexColors(airportBase, '#f8fafc', 0.08)
      : mixHexColors(airportBase, '#0f172a', 0.06);
  const site =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: 28, saturationDelta: -0.02, lightnessDelta: 0.08 })
      : adjustHexColor(normalized, { hueShift: 30, saturationDelta: 0.01, lightnessDelta: -0.1 });
  // Routes draw on top of country fills tinted with the same base color, so
  // push their lightness well away from the base to keep them visible.
  const route =
    themeMode === 'dark'
      ? mixHexColors(adjustHexColor(normalized, { hueShift: -10, saturationDelta: 0.12, lightnessDelta: 0.24 }), '#ffffff', 0.15)
      : adjustHexColor(normalized, { hueShift: -8, saturationDelta: 0.1, lightnessDelta: -0.28 });

  return {
    base: normalized,
    country,
    stateFill,
    selectedRegion,
    city,
    airport,
    site,
    route,
  };
}
