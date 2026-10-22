/**
 * The 3D globe view of a hex-globe board (Hex Earth): the sphere's hexes drawn with three.js, land raised by army
 * count in its owner's colour, army badges as HTML laid over the canvas, sea links as arcs. Drag to spin, wheel or
 * pinch to zoom, click a hex or a badge like a territory on the flat map. The camera follows the action (it turns to
 * each attack, move and capture) unless the viewer grabbed the globe in the last few seconds or switched Follow
 * off; with reduced motion it jumps instead of turning and never spins by itself.
 *
 * Lazy-loaded by Map.tsx (three.js is its own chunk), with the same props as the flat map.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getMap } from '@risk/engine';
import type { GlobeData } from '../globeData';
import { continentColor, POUR_MS, type Highlight, type MapProps } from './Map';

const LAND = 1.012; // top of a territory with no armies (sea level is 1)
const ICE = 1.006;
const FOLLOW_PAUSE_MS = 10_000; // after the viewer grabs the globe, it stops following for this long
const IDLE_SPIN_MS = 12_000; // with nothing happening for this long, the globe spins slowly
const TURN_MS = 700;
const MOVE_MS = 700;

/** Height of a territory's hexes: grows with the log of its armies, so a big stack is a clear plateau. */
const heightFor = (armies: number) => LAND + 0.009 * Math.min(Math.log2(1 + armies), 7);

function lonLatToVec(lon: number, lat: number, r = 1): THREE.Vector3 {
  const a = (lon * Math.PI) / 180;
  const b = (lat * Math.PI) / 180;
  return new THREE.Vector3(r * Math.cos(b) * Math.cos(a), r * Math.sin(b), -r * Math.cos(b) * Math.sin(a));
}

/** Points along a raised great-circle arc from a to b (unit vectors), higher for longer arcs. */
function arcPoints(a: THREE.Vector3, b: THREE.Vector3, base: number, steps = 48): THREE.Vector3[] {
  const lift = 0.02 + a.angleTo(b) * 0.12;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = a.clone().lerp(b, t);
    if (p.lengthSq() < 1e-9) p.set(0, 1, 0);
    out.push(p.normalize().multiplyScalar(base + Math.sin(Math.PI * t) * lift));
  }
  return out;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Static geometry derived once from the globe file. */
interface Shape {
  corners: THREE.Vector3[];
  centres: THREE.Vector3[];
  /** Land cells by territory index. */
  cellsOf: number[][];
  landCells: number[];
  /** Cell edges between two different owners (territory index, -1 sea, -2 ice): [cornerA, cornerB, cellA, cellB]. */
  borders: [number, number, number, number][];
  /** Badge cell centre (unit vector) per territory id. */
  badgeDir: Map<string, THREE.Vector3>;
}

function buildShape(globe: GlobeData): Shape {
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < globe.corners.length; i += 2) corners.push(lonLatToVec(globe.corners[i], globe.corners[i + 1]));
  const centres = globe.cells.map((c) => c.v.reduce((s, k) => s.add(corners[k]), new THREE.Vector3()).normalize());
  const cellsOf: number[][] = globe.territories.map(() => []);
  const landCells: number[] = [];
  globe.cells.forEach((c, i) => {
    if (c.t >= 0) cellsOf[c.t].push(i), landCells.push(i);
  });
  const byEdge = new Map<string, number[]>();
  globe.cells.forEach((c, i) =>
    c.v.forEach((k, j) => {
      const m = c.v[(j + 1) % c.v.length];
      const key = k < m ? `${k},${m}` : `${m},${k}`;
      byEdge.set(key, [...(byEdge.get(key) ?? []), i]);
    }),
  );
  const borders: Shape['borders'] = [];
  for (const [key, cells] of byEdge) {
    if (cells.length !== 2) continue;
    const [a, b] = cells;
    if (globe.cells[a].t === globe.cells[b].t || (globe.cells[a].t < 0 && globe.cells[b].t < 0)) continue;
    const [p, q] = key.split(',').map(Number);
    borders.push([p, q, a, b]);
  }
  const badgeDir = new Map(globe.territories.map((id, i) => [id, centres[globe.badges[i]].clone()]));
  return { corners, centres, cellsOf, landCells, borders, badgeDir };
}

interface Props extends MapProps {
  globe: GlobeData;
  onShowFlat: () => void;
}

export default function GlobeMap(props: Props) {
  const { view, globe, highlights, pendingPlacements, attackArrow, flashes, moves, floats, sweeps, onTerritoryClick, dimOthers, hidden, bonusView, onToggleBonusView, onShowFlat } = props;
  const map = getMap(view.options.map);
  const shape = useMemo(() => buildShape(globe), [globe]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const badgeRefs = useRef(new Map<string, HTMLDivElement>());
  const floatRefs = useRef(new Map<number, HTMLDivElement>());
  const moveRefs = useRef(new Map<number, HTMLDivElement>());
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const [hovered, setHovered] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Everything the render loop reads, refreshed on every React render (the loop itself lives in one effect).
  const live = useRef({ props, hovered, follow, map });
  live.current = { props, hovered, follow, map };

  const isHidden = (id: string) => !bonusView && !!(hidden?.has(id) || view.territories[id]?.hidden);
  const isFrozen = (id: string) => !!view.blizzards?.includes(id);
  const colorOf = (pid: string | null | undefined) => view.players.find((p) => p.id === pid)?.color ?? null;

  // Hovering a territory shows what it can attack, as on the flat map.
  const effectiveHighlights = useMemo(() => {
    if (!hovered || dimOthers || bonusView || isFrozen(hovered) || isHidden(hovered)) return highlights;
    const owner = view.territories[hovered]?.owner;
    const player = view.players.find((p) => p.id === owner);
    if (!owner || !player || player.isNeutral) return highlights;
    const merged: Record<string, Highlight> = { ...highlights };
    if (!merged[hovered]) merged[hovered] = 'hover-source';
    for (const n of map.adjacency[hovered] ?? [])
      if (!isFrozen(n) && view.territories[n]?.owner !== owner && (!merged[n] || merged[n] === 'source')) merged[n] = 'hover-target';
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights, hovered, dimOthers, bonusView, view, map]);
  const hlRef = useRef(effectiveHighlights);
  hlRef.current = effectiveHighlights;

  // The scene: built once per globe, torn down on unmount.
  const scene = useRef<{
    focus: (dirs: THREE.Vector3[]) => void;
    reset: () => void;
    zoom: (k: number) => void;
    dirty: () => void;
  } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setLoadError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = 'globe-canvas';
    wrap.prepend(renderer.domElement);

    const scn = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
    scn.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    scn.add(sun);
    scn.add(camera);
    sun.position.set(2, 3, 4);
    camera.add(sun); // light comes from over the viewer's shoulder, wherever the globe is turned

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 1.45;
    controls.maxDistance = 4.6;
    controls.autoRotateSpeed = 0.35;

    // Ocean floor, sea and ice cells (static).
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    scn.add(new THREE.Mesh(keep(new THREE.SphereGeometry(0.997, 64, 48)), keep(new THREE.MeshStandardMaterial({ color: 0x0b1d33, roughness: 1 }))));
    {
      const pos: number[] = [];
      const col: number[] = [];
      const c = new THREE.Color();
      globe.cells.forEach((cell, i) => {
        if (cell.t >= 0) return;
        const r = cell.t === -2 ? ICE : 1;
        c.set(cell.t === -2 ? '#e6edf5' : '#1c4470').offsetHSL(0, 0, ((i * 13) % 5 - 2) * 0.006);
        const ctr = shape.centres[i].clone().multiplyScalar(r);
        const ring = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(r).lerp(ctr, 0.035));
        for (let j = 0; j < ring.length; j++) {
          const [a, b] = [ring[j], ring[(j + 1) % ring.length]];
          pos.push(ctr.x, ctr.y, ctr.z, b.x, b.y, b.z, a.x, a.y, a.z);
          for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
        }
      });
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      scn.add(new THREE.Mesh(g, keep(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.05 }))));
    }
    // A thin atmosphere rim.
    scn.add(new THREE.Mesh(keep(new THREE.SphereGeometry(1.07, 48, 32)), keep(new THREE.MeshBasicMaterial({ color: 0x5c8fd6, transparent: true, opacity: 0.07, side: THREE.BackSide }))));

    // Land: one mesh rebuilt when owners, armies or highlights change (a few thousand triangles).
    const landCells = shape.landCells;
    const tris = landCells.reduce((s, i) => s + globe.cells[i].v.length * 3, 0); // top fan + two wall triangles per edge
    const landPos = new Float32Array(tris * 9);
    const landCol = new Float32Array(tris * 9);
    const triCell = new Int32Array(tris);
    const landGeo = keep(new THREE.BufferGeometry());
    landGeo.setAttribute('position', new THREE.BufferAttribute(landPos, 3));
    landGeo.setAttribute('color', new THREE.BufferAttribute(landCol, 3));
    const landMesh = new THREE.Mesh(landGeo, keep(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.75, side: THREE.DoubleSide })));
    scn.add(landMesh);

    // Borders: territory edges thin and faint, region edges and coasts dark.
    const borderGeo = keep(new THREE.BufferGeometry());
    const regionGeo = keep(new THREE.BufferGeometry());
    scn.add(new THREE.LineSegments(borderGeo, keep(new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }))));
    scn.add(new THREE.LineSegments(regionGeo, keep(new THREE.LineBasicMaterial({ color: 0x050a12, transparent: true, opacity: 0.95 }))));

    // Sea links (static dashed arcs) and the attack arrow (rebuilt when it changes).
    const linkGroup = new THREE.Group();
    scn.add(linkGroup);
    const linkMat = keep(new THREE.LineDashedMaterial({ color: 0xfff0b0, dashSize: 0.018, gapSize: 0.012, transparent: true, opacity: 0.75 }));
    for (const l of map.seaLinks) {
      const a = shape.badgeDir.get(l.a);
      const b = shape.badgeDir.get(l.b);
      if (!a || !b) continue;
      const line = new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(arcPoints(a, b, 1.02))), linkMat);
      line.computeLineDistances();
      linkGroup.add(line);
    }
    const arrowGroup = new THREE.Group();
    scn.add(arrowGroup);
    const arrowMat = keep(new THREE.MeshBasicMaterial({ color: 0xff5a5a }));
    let arrowKey = '';
    const setArrow = () => {
      const arrow = live.current.props.attackArrow;
      const key = arrow ? `${arrow.from}>${arrow.to}` : '';
      if (key === arrowKey) return;
      arrowKey = key;
      for (const c of [...arrowGroup.children]) {
        arrowGroup.remove(c);
        (c as THREE.Mesh).geometry.dispose();
      }
      if (!arrow) return;
      const a = shape.badgeDir.get(arrow.from);
      const b = shape.badgeDir.get(arrow.to);
      if (!a || !b) return;
      const pts = arcPoints(a, b, heightFor(8) + 0.01, 32);
      arrowGroup.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.slice(0, -3)), 32, 0.005, 6), arrowMat));
      const tip = pts[pts.length - 1];
      const from = pts[pts.length - 4];
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.045, 12), arrowMat);
      cone.position.copy(from.clone().lerp(tip, 0.5));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(from).normalize());
      arrowGroup.add(cone);
    };

    // Per-territory heights ease towards their targets (snap with reduced motion).
    const heightNow = new Map<string, number>();
    const flashStart = new Map<string, number>();
    const sweepStart = new Map<number, number>();
    const moveStart = new Map<number, number>();
    const tmp = new THREE.Color();
    const white = new THREE.Color('#ffffff');
    const black = new THREE.Color('#000000');

    /** The colour a territory shows now (owner, region, fog, blizzard, highlight, flash, capture pour). */
    const colourFor = (id: string, now: number): THREE.Color => {
      const { props: p, map: m } = live.current;
      const v = p.view;
      const fog = !p.bonusView && !!(p.hidden?.has(id) || v.territories[id]?.hidden);
      const ts = v.territories[id];
      const hl = hlRef.current[id];
      if (v.blizzards?.includes(id)) return tmp.set('#dfe8f2').clone();
      const region = m.territoryById[id]?.continent ?? '';
      const owner = v.players.find((pl) => pl.id === ts?.owner)?.color;
      const c = new THREE.Color(p.bonusView ? continentColor(m, region) : fog ? '#2a3140' : (owner ?? continentColor(m, region)));
      // A capture pours the new owner's colour over the old one.
      const sw = p.sweeps.find((s) => s.territory === id);
      if (sw && !fog) {
        const t0 = sweepStart.get(sw.id) ?? now;
        const k = Math.min(1, (now - t0) / POUR_MS);
        c.set(sw.prevColor).lerp(tmp.set(sw.color), k * k * (3 - 2 * k));
      }
      if (!p.bonusView && v.currentPlayer && ts?.owner === v.currentPlayer && v.phase !== 'lobby' && v.phase !== 'finished') c.lerp(white, 0.1);
      if (hl === 'source' || hl === 'selected' || hl === 'hover-source') c.lerp(white, 0.3);
      else if (hl) c.lerp(white, 0.45);
      else if (p.dimOthers) c.lerp(black, 0.55);
      const f = flashStart.get(id);
      if (f !== undefined && now - f < 1200) c.lerp(white, 0.6 * (1 - (now - f) / 1200));
      return c;
    };

    const targetHeight = (id: string) => {
      const { props: p } = live.current;
      if (p.bonusView || p.view.blizzards?.includes(id)) return LAND;
      if (p.hidden?.has(id) || p.view.territories[id]?.hidden) return LAND;
      return heightFor((p.view.territories[id]?.armies ?? 0) + (p.pendingPlacements[id] ?? 0));
    };

    /** Rebuilds land positions and colours; returns whether anything is still easing. */
    const paintLand = (now: number, step: number): boolean => {
      let easing = false;
      const tIndex = globe.territories;
      for (const id of tIndex) {
        const want = targetHeight(id);
        const cur = heightNow.get(id) ?? want;
        const next = step >= 1 ? want : cur + (want - cur) * step;
        if (Math.abs(next - want) > 1e-5) easing = true;
        heightNow.set(id, Math.abs(next - want) > 1e-5 ? next : want);
      }
      let o = 0;
      let tri = 0;
      for (const ci of landCells) {
        const cell = globe.cells[ci];
        const id = tIndex[cell.t];
        const h = heightNow.get(id) ?? LAND;
        const top = colourFor(id, now).offsetHSL(0, 0, ((ci * 7) % 5 - 2) * 0.012);
        const side = top.clone().multiplyScalar(0.55);
        const ctr = shape.centres[ci].clone().multiplyScalar(h);
        const ring = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(h));
        const inset = ring.map((p) => p.clone().lerp(ctr, 0.035));
        const base = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(0.999));
        const put = (p: THREE.Vector3, c: THREE.Color) => {
          landPos[o] = p.x;
          landPos[o + 1] = p.y;
          landPos[o + 2] = p.z;
          landCol[o] = c.r;
          landCol[o + 1] = c.g;
          landCol[o + 2] = c.b;
          o += 3;
        };
        for (let j = 0; j < ring.length; j++) {
          const n = (j + 1) % ring.length;
          put(ctr, top), put(inset[n], top), put(inset[j], top);
          triCell[tri++] = ci;
          put(ring[j], side), put(ring[n], side), put(base[j], side);
          put(ring[n], side), put(base[n], side), put(base[j], side);
          triCell[tri++] = ci;
          triCell[tri++] = ci;
        }
      }
      landGeo.attributes.position.needsUpdate = true;
      landGeo.attributes.color.needsUpdate = true;
      landGeo.computeBoundingSphere();

      // Borders sit on the higher of the two cells.
      const thin: number[] = [];
      const bold: number[] = [];
      const m = live.current.map;
      for (const [p, q, a, b] of shape.borders) {
        const [ta, tb] = [globe.cells[a].t, globe.cells[b].t];
        const ha = ta >= 0 ? heightNow.get(tIndex[ta]) ?? LAND : ta === -2 ? ICE : 1;
        const hb = tb >= 0 ? heightNow.get(tIndex[tb]) ?? LAND : tb === -2 ? ICE : 1;
        const r = Math.max(ha, hb) + 0.0008;
        const [A, B] = [shape.corners[p].clone().multiplyScalar(r), shape.corners[q].clone().multiplyScalar(r)];
        const sameRegion = ta >= 0 && tb >= 0 && m.territoryById[tIndex[ta]]?.continent === m.territoryById[tIndex[tb]]?.continent;
        (sameRegion ? thin : bold).push(A.x, A.y, A.z, B.x, B.y, B.z);
      }
      borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(thin, 3));
      regionGeo.setAttribute('position', new THREE.Float32BufferAttribute(bold, 3));
      return easing;
    };

    // ---- camera ----
    const home = (() => {
      // Start facing the current player's land (or the Atlantic side).
      const v = live.current.props.view;
      const mine = globe.territories.filter((id) => v.territories[id]?.owner && v.territories[id]?.owner === v.currentPlayer);
      const dirs = mine.map((id) => shape.badgeDir.get(id)?.clone()).filter(Boolean) as THREE.Vector3[];
      const d = dirs.reduce((s, x) => s.add(x), new THREE.Vector3());
      return d.lengthSq() > 1e-6 ? d.normalize() : lonLatToVec(10, 20);
    })();
    const DIST = 4;
    camera.position.copy(home).multiplyScalar(DIST);
    controls.update();

    let turn: { from: THREE.Vector3; to: THREE.Vector3; dist: number; t0: number } | null = null;
    let lastGrab = -Infinity;
    let lastEvent = performance.now();
    const focus = (dirs: THREE.Vector3[]) => {
      lastEvent = performance.now();
      if (!live.current.follow || performance.now() - lastGrab < FOLLOW_PAUSE_MS || !dirs.length) return;
      const to = dirs.reduce((s, x) => s.add(x), new THREE.Vector3()).normalize();
      const dist = camera.position.length();
      const from = camera.position.clone().normalize();
      if (from.angleTo(to) < 0.12) return; // already in view
      if (reducedMotion()) {
        camera.position.copy(to).multiplyScalar(dist);
        controls.update();
        return;
      }
      turn = { from, to, dist, t0: performance.now() };
    };
    controls.addEventListener('start', () => {
      lastGrab = performance.now();
      turn = null;
    });

    // ---- picking: click a hex (not after a drag), hover for names and attack targets ----
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (e: PointerEvent): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(landMesh, false)[0];
      if (!hit || hit.faceIndex == null) return null;
      return globe.territories[globe.cells[triCell[hit.faceIndex]].t] ?? null;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        const id = pick(e);
        if (id) live.current.props.onTerritoryClick(id, e.shiftKey);
      }
      down = null;
    };
    let hoverQueued: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.buttons === 0) hoverQueued = e;
    };
    const onLeave = () => setHovered(null);
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);

    // ---- size ----
    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Fit the globe in the shorter side.
      camera.fov = w >= h ? 35 : Math.min(70, 2 * Math.atan(Math.tan((35 * Math.PI) / 360) / camera.aspect) * (180 / Math.PI));
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // ---- the loop ----
    let dirty = true;
    let easing = false;
    let raf = 0;
    let last = performance.now();
    const v3 = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      const p = live.current.props;
      const reduce = reducedMotion();

      // Animations started since the last frame.
      for (const [id, at] of Object.entries(p.flashes)) if (Date.now() - at < 1200 && !flashStart.has(id)) flashStart.set(id, now - (Date.now() - at));
      for (const sw of p.sweeps) if (!sweepStart.has(sw.id)) sweepStart.set(sw.id, now);
      for (const mv of p.moves) if (!moveStart.has(mv.id)) moveStart.set(mv.id, now);
      const animating = [...flashStart.values()].some((t) => now - t < 1200) || [...sweepStart.values()].some((t) => now - t < POUR_MS);

      if (turn) {
        const k = Math.min(1, (now - turn.t0) / TURN_MS);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const dir = turn.from.clone().lerp(turn.to, e).normalize();
        camera.position.copy(dir).multiplyScalar(turn.dist);
        if (k >= 1) turn = null;
      }
      // The idle spin is for watching: never while the viewer has something to click (a player's own move).
      const choosing = Object.keys(p.highlights).length > 0 || p.dimOthers;
      controls.autoRotate = !reduce && !choosing && live.current.follow && !turn && now - lastEvent > IDLE_SPIN_MS && now - lastGrab > IDLE_SPIN_MS;
      // Drag slower when zoomed in, so a flick does not throw the board around.
      controls.rotateSpeed = 0.35 + 0.25 * (camera.position.length() - controls.minDistance);
      controls.update();

      if (dirty || easing || animating) {
        easing = paintLand(now, reduce ? 1 : Math.min(1, dt / 160));
        dirty = false;
      }
      setArrow();

      if (hoverQueued) {
        const id = pick(hoverQueued);
        hoverQueued = null;
        if (id !== live.current.hovered) setHovered(id);
      }

      renderer.render(scn, camera);

      // HTML overlays: badges, region labels, floats and move tokens follow their cells; hidden on the far side.
      const rect = el.getBoundingClientRect();
      // Smaller badges on small boards (phones), so they do not cover the hexes.
      const fit = Math.max(0.7, Math.min(1, Math.min(rect.width, rect.height) / 620));
      camDir.copy(camera.position).normalize();
      const place = (node: HTMLElement | undefined, dir: THREE.Vector3, r: number) => {
        if (!node) return;
        const facing = dir.dot(camDir);
        if (facing < 0.12) {
          node.style.opacity = '0';
          node.style.pointerEvents = 'none';
          return;
        }
        v3.copy(dir).multiplyScalar(r).project(camera);
        const x = ((v3.x + 1) / 2) * rect.width;
        const y = ((1 - v3.y) / 2) * rect.height;
        const s = fit * Math.max(0.8, Math.min(1.35, 3.8 / camera.position.length())) * (0.65 + 0.35 * Math.min(1, facing * 1.6));
        node.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${s.toFixed(3)})`;
        node.style.opacity = String(Math.min(1, (facing - 0.12) * 5));
        node.style.pointerEvents = '';
        node.style.zIndex = String(Math.round(facing * 100));
      };
      for (const [id, node] of badgeRefs.current) {
        const dir = shape.badgeDir.get(id);
        if (dir) place(node, dir, (heightNow.get(id) ?? LAND) + 0.004);
      }
      for (const [id, node] of labelRefs.current) {
        const region = live.current.map.continentById[id];
        if (!region) continue;
        const dirs = region.territories.map((t) => shape.badgeDir.get(t)).filter(Boolean) as THREE.Vector3[];
        place(node, dirs.reduce((s, x) => s.add(x), new THREE.Vector3()).normalize(), LAND + 0.02);
      }
      for (const f of p.floats) {
        const dir = shape.badgeDir.get(f.territory);
        if (dir) place(floatRefs.current.get(f.id), dir, (heightNow.get(f.territory) ?? LAND) + 0.03);
      }
      for (const mv of p.moves) {
        const [a, b] = [shape.badgeDir.get(mv.from), shape.badgeDir.get(mv.to)];
        if (!a || !b) continue;
        const k = Math.min(1, (now - (moveStart.get(mv.id) ?? now)) / MOVE_MS);
        const pts = arcPoints(a, b, 1, 24);
        const pt = pts[Math.round(k * 24)];
        place(moveRefs.current.get(mv.id), pt.clone().normalize(), pt.length() + 0.02);
      }
    };
    raf = requestAnimationFrame(frame);

    scene.current = {
      focus,
      reset: () => {
        turn = null;
        camera.position.copy(home).multiplyScalar(DIST);
        controls.update();
      },
      zoom: (k: number) => {
        const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, camera.position.length() / k));
        camera.position.setLength(d);
        controls.update();
      },
      dirty: () => {
        dirty = true;
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      controls.dispose();
      for (const c of arrowGroup.children) (c as THREE.Mesh).geometry.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      el.remove();
      scene.current = null;
    };
    // The scene is built once per globe; everything that changes is read through `live` and `hlRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globe, shape]);

  // Repaint the land whenever the board or the highlights change.
  useEffect(() => {
    scene.current?.dirty();
  }, [view, effectiveHighlights, pendingPlacements, hidden, bonusView, dimOthers, flashes, sweeps]);

  // Follow the action: turn to each new attack, capture and troop move.
  const lastFocus = useRef('');
  useEffect(() => {
    const ids = attackArrow ? [attackArrow.from, attackArrow.to] : sweeps.length ? [sweeps[sweeps.length - 1].from, sweeps[sweeps.length - 1].territory] : moves.length ? [moves[moves.length - 1].from, moves[moves.length - 1].to] : [];
    const key = ids.join('>');
    if (!key || key === lastFocus.current) return;
    lastFocus.current = key;
    scene.current?.focus(ids.map((id) => shape.badgeDir.get(id)?.clone()).filter(Boolean) as THREE.Vector3[]);
  }, [attackArrow, sweeps, moves, shape]);

  const capitalOf = (id: string) => Object.entries(view.capitals ?? {}).find(([, t]) => t === id)?.[0];
  const setRef = <K,>(store: Map<K, HTMLDivElement>, key: K) => (node: HTMLDivElement | null) => {
    if (node) store.set(key, node);
    else store.delete(key);
  };

  if (loadError) {
    return (
      <div className="map-wrap globe-wrap">
        <div className="globe-message">
          This browser cannot draw the globe. <button onClick={onShowFlat}>Show the flat map</button>
        </div>
      </div>
    );
  }

  const hoveredName = hovered ? map.territoryById[hovered]?.name : null;
  return (
    <div ref={wrapRef} className={`map-wrap globe-wrap ${dimOthers ? 'dimming' : ''}`}>
      <div className="globe-overlay" aria-hidden={bonusView ? true : undefined}>
        {!bonusView &&
          map.territories.map((t) => {
            const ts = view.territories[t.id];
            const fog = isHidden(t.id);
            const frozen = isFrozen(t.id);
            const hl = effectiveHighlights[t.id];
            const pending = pendingPlacements[t.id] ?? 0;
            const cap = capitalOf(t.id);
            const owner = fog ? '#3a4152' : (colorOf(ts?.owner) ?? '#555');
            const cls = ['globe-badge', hl ? `hl-${hl}` : '', dimOthers && !hl ? 'dim' : '', frozen ? 'blizzard' : '', fog ? 'fog' : ''].filter(Boolean).join(' ');
            return (
              <div
                key={t.id}
                ref={setRef(badgeRefs.current, t.id)}
                className={cls}
                title={fog ? `${t.name}: hidden by fog` : frozen ? `${t.name}: blizzard, impassable` : `${t.name}: ${view.players.find((p) => p.id === ts?.owner)?.name ?? 'unowned'}, ${ts?.armies ?? 0} armies`}
                onClick={(e) => onTerritoryClick(t.id, e.shiftKey)}
                onPointerEnter={() => setHovered(t.id)}
                onPointerLeave={() => setHovered(null)}
              >
                <span className="globe-badge-body" style={{ background: frozen ? '#dfe8f2' : owner } as CSSProperties}>
                  {frozen ? '❄' : fog ? '?' : (ts?.armies ?? 0) + pending}
                </span>
                {cap && !fog && <span className="globe-capital" style={{ color: colorOf(cap) ?? '#ffd166' }}>★</span>}
                {pending > 0 && <span className="globe-pending">+{pending}</span>}
                {hovered === t.id && <span className="globe-name">{t.name}</span>}
              </div>
            );
          })}
        {bonusView &&
          map.continents.map((c) => (
            <div key={c.id} ref={setRef(labelRefs.current, c.id)} className="globe-region" style={{ color: continentColor(map, c.id) }}>
              <b>+{c.bonus}</b>
              <span>{c.name}</span>
            </div>
          ))}
        {floats.map((f) => (
          <div key={f.id} ref={setRef(floatRefs.current, f.id)} className="globe-float-anchor">
            <span className={`globe-float ${f.burst ? 'burst' : ''}`} style={{ color: f.color, ...(f.durationMs ? { animationDuration: `${f.durationMs}ms` } : {}) }}>
              {f.text}
            </span>
          </div>
        ))}
        {moves.map((m) => (
          <div key={m.id} ref={setRef(moveRefs.current, m.id)} className="globe-move" style={{ background: m.color }}>
            {m.armies}
          </div>
        ))}
      </div>
      {hoveredName && !bonusView && <div className="globe-hover-name">{hoveredName}</div>}
      <div className="map-controls">
        <button title="Zoom in" onClick={() => scene.current?.zoom(1.25)}>
          +
        </button>
        <button title="Zoom out" onClick={() => scene.current?.zoom(1 / 1.25)}>
          −
        </button>
        <button title="Back to the start view" onClick={() => scene.current?.reset()}>
          ⟲
        </button>
        <button className={`globe-follow ${follow ? 'active' : ''}`} aria-pressed={follow} title="Follow the action: turn the globe to each attack and move" onClick={() => setFollow((f) => !f)}>
          ◎
        </button>
        <button className="globe-flat" title="Show the flat map" onClick={onShowFlat}>
          Flat
        </button>
        {onToggleBonusView && (
          <button className={`bonus-toggle ${bonusView ? 'active' : ''}`} aria-pressed={!!bonusView} title="Show region bonuses, colour-coded (shortcut: B)" onClick={onToggleBonusView}>
            {bonusView ? 'Back to board' : 'Bonuses'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A light globe for the Inception view of a nested tournament: one hex-globe board coloured by `fill` (the table's
 * holders, or regions before the deal), its portal territories raised in gold. Click a portal to zoom into the board
 * inside it (the flat sub-board); drag to spin, wheel or pinch to zoom. It spins slowly by itself unless the viewer
 * prefers reduced motion. No game state: the Inception view hands it colours only.
 */
export function InceptionGlobe({
  globe,
  fill,
  portals,
  labelOf,
  onPortal,
}: {
  globe: GlobeData;
  /** Colour of each territory (by id). */
  fill: (territory: string) => string;
  portals: string[];
  labelOf: (territory: string) => string;
  onPortal: (territory: string) => void;
}) {
  const shape = useMemo(() => buildShape(globe), [globe]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const live = useRef({ fill, portals, onPortal });
  live.current = { fill, portals, onPortal };
  const repaint = useRef<() => void>(() => undefined);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = 'globe-canvas';
    wrap.prepend(renderer.domElement);
    const scn = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
    scn.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(2, 3, 4);
    camera.add(sun);
    scn.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 1.45;
    controls.maxDistance = 4.6;
    controls.autoRotateSpeed = 0.35;
    controls.autoRotate = !reducedMotion();
    // Start facing the portals.
    const facing = live.current.portals.map((t) => shape.badgeDir.get(t)?.clone()).filter(Boolean) as THREE.Vector3[];
    const home = facing.reduce((s, v) => s.add(v), new THREE.Vector3());
    camera.position.copy(home.lengthSq() > 1e-6 ? home.normalize() : lonLatToVec(10, 20)).multiplyScalar(4);
    controls.update();

    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    scn.add(new THREE.Mesh(keep(new THREE.SphereGeometry(0.997, 64, 48)), keep(new THREE.MeshStandardMaterial({ color: 0x2c6e8a, roughness: 1 }))));
    const geo = keep(new THREE.BufferGeometry());
    const mesh = new THREE.Mesh(geo, keep(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, side: THREE.DoubleSide })));
    scn.add(mesh);
    const lines = keep(new THREE.BufferGeometry());
    scn.add(new THREE.LineSegments(lines, keep(new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }))));
    let triCell: number[] = [];

    const paint = () => {
      const { fill: colour, portals: gates } = live.current;
      const portalSet = new Set(gates);
      const pos: number[] = [];
      const col: number[] = [];
      triCell = [];
      const c = new THREE.Color();
      const heightOf = (t: number) => (t >= 0 ? (portalSet.has(globe.territories[t]) ? LAND + 0.03 : LAND) : t === -2 ? ICE : 1);
      globe.cells.forEach((cell, ci) => {
        const id = cell.t >= 0 ? globe.territories[cell.t] : null;
        const h = heightOf(cell.t);
        if (id && portalSet.has(id)) c.set('#f2c14e');
        else if (id) c.set(colour(id));
        else c.set(cell.t === -2 ? '#e6edf5' : '#3b86a8');
        c.offsetHSL(0, 0, (((ci * 7) % 5) - 2) * 0.01);
        const side = c.clone().multiplyScalar(0.6);
        const ctr = shape.centres[ci].clone().multiplyScalar(h);
        const ring = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(h));
        const base = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(0.999));
        const put = (p: THREE.Vector3, k: THREE.Color) => {
          pos.push(p.x, p.y, p.z);
          col.push(k.r, k.g, k.b);
        };
        for (let j = 0; j < ring.length; j++) {
          const n = (j + 1) % ring.length;
          put(ctr, c), put(ring[n].clone().lerp(ctr, 0.035), c), put(ring[j].clone().lerp(ctr, 0.035), c);
          triCell.push(ci);
          if (h > 1) {
            put(ring[j], side), put(ring[n], side), put(base[j], side);
            put(ring[n], side), put(base[n], side), put(base[j], side);
            triCell.push(ci, ci);
          }
        }
      });
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.computeBoundingSphere();
      const seg: number[] = [];
      for (const [p, q, a, b] of shape.borders) {
        const r = Math.max(heightOf(globe.cells[a].t), heightOf(globe.cells[b].t)) + 0.0008;
        const [A, B] = [shape.corners[p].clone().multiplyScalar(r), shape.corners[q].clone().multiplyScalar(r)];
        seg.push(A.x, A.y, A.z, B.x, B.y, B.z);
      }
      lines.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    };
    paint();
    repaint.current = paint;

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (e: PointerEvent): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(mesh, false)[0];
      if (!hit || hit.faceIndex == null) return null;
      const t = globe.cells[triCell[hit.faceIndex]]?.t ?? -1;
      return t >= 0 ? globe.territories[t] : null;
    };
    const isPortal = (id: string | null): id is string => !!id && live.current.portals.includes(id);
    let down: { x: number; y: number } | null = null;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      controls.autoRotate = false; // grabbed: stop spinning for good
    };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        const id = pick(e);
        if (isPortal(id)) live.current.onPortal(id);
      }
      down = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const id = pick(e);
      setHover(isPortal(id) ? id : null);
      el.style.cursor = isPortal(id) ? 'pointer' : '';
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = w >= h ? 35 : Math.min(70, 2 * Math.atan(Math.tan((35 * Math.PI) / 360) / camera.aspect) * (180 / Math.PI));
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      controls.update();
      renderer.render(scn, camera);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      controls.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      el.remove();
      repaint.current = () => undefined;
    };
  }, [globe, shape]);

  // New holders or portals: repaint the hexes.
  useEffect(() => {
    repaint.current();
  }, [fill, portals]);

  return (
    <div ref={wrapRef} className="inception-globe">
      {hover && <div className="globe-hover-name">Zoom into {labelOf(hover)}</div>}
    </div>
  );
}
