/**
 * Hex-globe boards (`kind: 'hexglobe'` in scripts/maps) ship a second generated file,
 * src/generated/<map>.globe.json, that only the 3D globe view loads. This module is the small, always-loaded
 * part: which maps have a globe, whether this browser can draw one, and the viewer's globe/flat choice.
 * The globe itself (three.js) is a lazy chunk: GlobeMap.tsx.
 */

/** The globe file written by scripts/build-map.mjs. */
export interface GlobeData {
  id: string;
  frequency: number;
  spin: number;
  /** Territory ids in the engine map's order; a cell's `t` indexes this list. */
  territories: string[];
  /** Per territory, the cell its army badge sits on. */
  badges: number[];
  /** Cell corners as a flat [lon, lat, lon, lat, ...] list. */
  corners: number[];
  /**
   * Per cell: its corner indices (clockwise seen from outside), what it is (territory index, -1 sea, -2 ice) and, on a
   * board with closing ice (Mega Earth), `r`: its ring count from the North and the South pole.
   */
  cells: { v: number[]; t: number; r?: [number, number] }[];
}

const loaders = import.meta.glob<GlobeData>('./generated/*.globe.json', { import: 'default' });
const loaderFor = (mapId: string) => loaders[`./generated/${mapId}.globe.json`];

export const hasGlobe = (mapId: string) => !!loaderFor(mapId);
export const loadGlobe = (mapId: string): Promise<GlobeData> => loaderFor(mapId)();

let webgl: boolean | null = null;
/** Whether this browser can draw the globe (WebGL); without it hex-globe boards use the flat map. */
export function webglAvailable(): boolean {
  if (webgl === null) {
    try {
      const canvas = document.createElement('canvas');
      webgl = !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

const VIEW_KEY = 'risk.globeView';
/** The viewer's choice for hex-globe boards: the globe (default) or the flat map. Per browser only. */
export function preferFlat(): boolean {
  try {
    return localStorage.getItem(VIEW_KEY) === 'flat';
  } catch {
    return false;
  }
}
export function setPreferFlat(flat: boolean): void {
  try {
    localStorage.setItem(VIEW_KEY, flat ? 'flat' : 'globe');
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
