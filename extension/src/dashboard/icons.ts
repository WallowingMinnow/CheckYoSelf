// Small line icons for the dashboard, drawn as SVG paths on a 24x24 grid.
// Built with createElementNS (no innerHTML), like the rest of the extension.

const PATHS = {
  shield: ["M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z", "M9 12l2 2 4-4"],
  grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  layers: ["M12 3l9 5-9 5-9-5 9-5z", "M3 13l9 5 9-5"],
  image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"],
  list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  mapPin: ["M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z", "M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  idCard: ["M3 6h18v12H3z", "M7 10h5", "M7 14h7", "M16 10h2", "M16 14h2"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  alert: ["M12 3l9 16H3L12 3z", "M12 10v4", "M12 17h.01"],
  sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z", "M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z"],
  refresh: ["M20 11a8 8 0 0 0-14.3-4.9L4 8", "M4 4v4h4", "M4 13a8 8 0 0 0 14.3 4.9L20 16", "M20 20v-4h-4"],
  plus: ["M12 5v14", "M5 12h14"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  chevron: ["M6 9l6 6 6-6"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  check: ["M5 12l4 4 10-10"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  quote: ["M7 7h4v4c0 3-1.5 5-4 6", "M15 7h4v4c0 3-1.5 5-4 6"],
} as const;

export type IconName = keyof typeof PATHS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Creates an icon. Its color follows the text color (currentColor). */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Icon for each risk group in the breakdown. */
export const GROUP_ICONS = {
  location: "mapPin",
  personal: "user",
  identity: "idCard",
  routine: "clock",
  sensitive: "alert",
} as const satisfies Record<string, IconName>;
