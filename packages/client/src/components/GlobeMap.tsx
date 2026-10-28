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
import { getMap, type MapDef, type NestNode } from '@risk/engine';
import type { GlobeData } from '../globeData';
import { frameAt, landBox, livePatches, onPatch, pathRings, type Patch, type Vec3 } from '../globeLayout';
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
      // A huge board (Mega Earth's one-hexagon territories) has hexes three quarters of Hex Earth's: badges at 60%.
      const fit = Math.max(0.7, Math.min(1, Math.min(rect.width, rect.height) / 620)) * (live.current.map.territoryIds.length > 300 ? 0.6 : 1);
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
 * The live globe of a nested tournament: the boards of the round in play tile the sphere (globeLayout.ts), each drawn
 * as a patch in its holders' colours and repainted as the tournament feed changes. Click a patch to focus its table
 * (the side panel offers Watch table); the camera turns to the focused table. Spins slowly until grabbed, never with
 * reduced motion. When a round ends, each table's patch shrinks into its portal (the winner's starting territory) on
 * the next round's board while those boards fade in; with reduced motion the new round simply replaces the old.
 */
export function LiveGlobe({
  nodes,
  depth,
  mapOf,
  fill,
  armiesOf,
  attackOf,
  focus,
  labelOf,
  onPick,
  version,
  globe,
}: {
  nodes: readonly NestNode[];
  /** The depth of the round in play: its boards are drawn. */
  depth: number;
  mapOf: (id: string) => MapDef;
  /** Colour of a territory of a node's board. */
  fill: (node: number, territory: string) => string;
  /** Armies on a territory (null: not known); the land rises with them. */
  armiesOf: (node: number, territory: string) => number | null;
  /** A table's latest battle: drawn as a red arc over its patch for a few seconds. */
  attackOf: (node: number) => { from: string; to: string; at: number } | null;
  focus: number;
  labelOf: (node: number) => string;
  onPick: (node: number) => void;
  /** Changes whenever the colours may have changed (the feed): the patches are repainted. */
  version: unknown;
  /** The final's board as a globe, when the round in play is a final on a hex-globe board (Hex Earth). */
  globe?: GlobeData | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<number, HTMLDivElement>());
  const patches = useMemo(() => livePatches(nodes, depth, mapOf), [nodes, depth, mapOf]);
  const live = useRef({ fill, armiesOf, attackOf, focus, onPick, patches, nodes, mapOf, depth, globe });
  live.current = { fill, armiesOf, attackOf, focus, onPick, patches, nodes, mapOf, depth, globe };
  const api = useRef<{ repaint: () => void; focusOn: (i: number) => void; show: () => void } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  // The scene, camera and loop: built once; the round's boards come and go as layers (`show`).
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
    scn.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(2, 3, 4);
    camera.add(sun);
    scn.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 1.3;
    controls.maxDistance = 4.6;
    controls.autoRotateSpeed = 0.3;
    controls.autoRotate = !reducedMotion();
    const first = live.current.patches;
    const startAt = first.get(live.current.focus)?.centre ?? first.values().next().value?.centre ?? ([0, 0.3, 1] as Vec3);
    camera.position.set(...startAt).normalize().multiplyScalar(3.6);
    controls.update();

    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    scn.add(new THREE.Mesh(keep(new THREE.SphereGeometry(0.998, 64, 48)), keep(new THREE.MeshStandardMaterial({ color: 0x2c6e8a, roughness: 1 }))));
    scn.add(new THREE.Mesh(keep(new THREE.SphereGeometry(1.06, 48, 32)), keep(new THREE.MeshBasicMaterial({ color: 0x5c8fd6, transparent: true, opacity: 0.07, side: THREE.BackSide }))));
    const focusGeo = keep(new THREE.BufferGeometry());
    const focusLine = new THREE.LineSegments(focusGeo, keep(new THREE.LineBasicMaterial({ color: 0xf2c14e })));
    scn.add(focusLine);

    let layer: Layer | null = null;
    let leaving: { layer: Layer; from: Map<number, Patch>; to: Map<number, Patch>; t0: number } | null = null;
    let dirty = true;

    const showFocus = () => {
      const at = layer ? layer.order.indexOf(live.current.focus) : -1;
      focusLine.visible = at >= 0 && !leaving;
      if (at >= 0 && layer) focusGeo.setAttribute('position', new THREE.Float32BufferAttribute(layer.frames.slice(at * FRAME_FLOATS, (at + 1) * FRAME_FLOATS), 3));
      dirty = true;
    };
    // Attack arcs: one per table whose latest battle is younger than ARC_MS, fading out.
    const arcs = new THREE.Group();
    scn.add(arcs);
    const drawArcs = () => {
      for (const a of [...arcs.children]) {
        arcs.remove(a);
        const mesh = a as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      if (!layer) return;
      const { attackOf: battleOf, nodes: tree, mapOf: boardOf } = live.current;
      for (const i of layer.order) {
        const b = battleOf(i);
        if (!b || Date.now() - b.at > ARC_MS) continue;
        const board = boardOf(tree[i].map);
        const [A, B] = [board.territoryById[b.from], board.territoryById[b.to]];
        const p = layer.patches.get(i);
        if (!A || !B || !p) continue;
        const pts: THREE.Vector3[] = [];
        for (let s = 0; s <= 16; s++) {
          const t = s / 16;
          const lift = LIFT + 0.018 + Math.sin(Math.PI * t) * 0.012;
          pts.push(new THREE.Vector3(...onPatch(p, A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, lift)));
        }
        // A tube, so the arc reads at any zoom (a line is one pixel wide).
        const width = Math.min(0.004, Math.max(0.0015, p.k * 4));
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, width, 6), new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true }));
        tube.userData.at = b.at;
        arcs.add(tube);
      }
    };
    const repaint = () => {
      if (layer) {
        layer.paint(live.current.fill);
        layer.setHeights(live.current.armiesOf);
      }
      drawArcs();
      dirty = true;
    };

    // A new set of boards: the old round shrinks into its portals on the new boards (a round advanced), or is
    // simply replaced (first draw, a jump, reduced motion).
    const show = () => {
      const { patches: laid, nodes: tree, mapOf: boardOf, depth: level, globe: final } = live.current;
      const old = layer;
      const onGlobe = level === 0 && !!final;
      layer = onGlobe ? buildGlobeLayer(final!, tree) : buildLayer(laid, tree, boardOf);
      const next = layer.patches;
      layer.paint(live.current.fill);
      layer.setHeights(live.current.armiesOf);
      scn.add(layer.group);
      if (leaving) {
        scn.remove(leaving.layer.group);
        leaving.layer.dispose();
        leaving = null;
      }
      if (old) {
        const advanced = old.order.length > 0 && old.order.every((i) => tree[i]?.parent !== null && next.has(tree[i].parent!));
        if (advanced && !reducedMotion()) {
          const from = new Map(old.order.map((i) => [i, old.patches.get(i)!]));
          const to = new Map(
            old.order.map((i) => [i, onGlobe ? shrinkToGlobe(final!, tree, boardOf, i, old.patches.get(i)!) : shrinkTarget(tree, boardOf, i, next.get(tree[i].parent!)!, old.patches.get(i)!)]),
          );
          leaving = { layer: old, from, to, t0: performance.now() };
          layer.setOpacity(0);
        } else {
          scn.remove(old.group);
          old.dispose();
        }
        // A new round: turn to the focused table if it plays in it, or to the only board left (the final).
        const target = next.has(live.current.focus) ? live.current.focus : next.size === 1 ? [...next.keys()][0] : null;
        if (target !== null) focusOn(target);
      }
      showFocus();
    };

    // Turn to a table: the camera eases over the globe (jumps with reduced motion).
    let turn: { from: THREE.Vector3; to: THREE.Vector3; dist: number; t0: number } | null = null;
    const focusOn = (i: number) => {
      showFocus();
      const p = layer?.patches.get(i);
      if (!p) return;
      const to = new THREE.Vector3(...p.centre);
      const dist = camera.position.length();
      if (reducedMotion()) {
        camera.position.copy(to).multiplyScalar(dist);
        controls.update();
        return;
      }
      turn = { from: camera.position.clone().normalize(), to, dist, t0: performance.now() };
    };
    api.current = { repaint, focusOn, show };
    show();

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const el = renderer.domElement;
    const pick = (e: PointerEvent): number | null => {
      if (!layer) return null;
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(layer.mesh, false)[0];
      return hit && hit.faceIndex != null ? (layer.triNode[hit.faceIndex] ?? null) : null;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      controls.autoRotate = false;
      turn = null;
    };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        const i = pick(e);
        if (i !== null) live.current.onPick(i);
      }
      down = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const i = pick(e);
      setHover(i);
      el.style.cursor = i !== null ? 'pointer' : '';
    };
    const onLeave = () => setHover(null);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = w >= h ? 35 : Math.min(70, 2 * Math.atan(Math.tan((35 * Math.PI) / 360) / camera.aspect) * (180 / Math.PI));
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const v3 = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      if (turn) {
        const k = Math.min(1, (now - turn.t0) / TURN_MS);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        camera.position.copy(turn.from.clone().lerp(turn.to, e).normalize().multiplyScalar(turn.dist));
        if (k >= 1) turn = null;
      }
      if (leaving) {
        // The old boards shrink into their portals and fade at the end; the new boards fade in over the second half.
        const k = Math.min(1, (now - leaving.t0) / SHRINK_MS);
        const e = 1 - (1 - k) ** 3;
        const { from, to } = leaving;
        leaving.layer.place((i) => lerpPatch(from.get(i)!, to.get(i)!, e));
        leaving.layer.setOpacity(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
        layer?.setOpacity(k < 0.5 ? 0 : (k - 0.5) / 0.5);
        if (k >= 1) {
          scn.remove(leaving.layer.group);
          leaving.layer.dispose();
          leaving = null;
          layer?.setOpacity(1);
          showFocus();
        }
        dirty = true;
      }
      if (arcs.children.length) {
        for (const a of arcs.children) {
          const age = Date.now() - (a.userData.at as number);
          ((a as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - age / ARC_MS);
        }
        if (arcs.children.every((a) => Date.now() - (a.userData.at as number) > ARC_MS)) drawArcs();
        dirty = true;
      }
      const moved = controls.update();
      if (!dirty && !moved && !turn && !controls.autoRotate) return; // nothing changed: skip the frame
      dirty = false;
      renderer.render(scn, camera);
      // Table names over their patches, hidden on the far side (and while a round changes).
      const rect = el.getBoundingClientRect();
      camDir.copy(camera.position).normalize();
      for (const [i, node] of labelRefs.current) {
        const p = layer?.patches.get(i);
        if (!p || leaving) {
          node.style.opacity = '0';
          continue;
        }
        v3.set(...p.centre);
        const facing = v3.dot(camDir);
        if (facing < 0.3) {
          node.style.opacity = '0';
          continue;
        }
        v3.multiplyScalar(1.01).project(camera);
        node.style.transform = `translate(${((v3.x + 1) / 2) * rect.width}px, ${((1 - v3.y) / 2) * rect.height}px) translate(-50%, -50%)`;
        node.style.opacity = String(Math.min(1, (facing - 0.3) * 4));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      controls.dispose();
      layer?.dispose();
      leaving?.layer.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      el.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.show();
  }, [patches, globe]);
  useEffect(() => {
    api.current?.repaint();
  }, [version, fill]);
  useEffect(() => {
    api.current?.focusOn(focus);
  }, [focus]);

  const setRef = (i: number) => (node: HTMLDivElement | null) => {
    if (node) labelRefs.current.set(i, node);
    else labelRefs.current.delete(i);
  };
  return (
    <div ref={wrapRef} className="inception-globe">
      <div className="globe-overlay">
        {[...patches.keys()].map((i) => (
          <div key={i} ref={setRef(i)} className={`live-globe-label ${i === focus ? 'focus' : ''}`}>
            {labelOf(i)}
          </div>
        ))}
      </div>
      {hover !== null && <div className="globe-hover-name">{labelOf(hover)}: click to focus</div>}
    </div>
  );
}

const SHRINK_MS = 1100;
/** How long a table's latest battle shows as an arc on the live globe. */
const ARC_MS = 4000;
/** Lift of a territory on a live patch with `armies` on it (the land rises with the log of its armies). */
const patchLift = (armies: number | null) => (armies === null ? LIFT : LIFT + 0.003 * Math.min(Math.log2(1 + armies), 7));
const LIFT = 1.004;
const FRAME_SEGMENTS = 64;
const FRAME_FLOATS = FRAME_SEGMENTS * 6;

/** One round's boards on the globe: the patches, their borders and frames, movable (`place`) and fadeable. */
interface Layer {
  group: THREE.Group;
  mesh: THREE.Mesh;
  /** Node of each triangle (picking). */
  triNode: number[];
  /** Nodes in drawing order, and their patches as laid out. */
  order: number[];
  patches: Map<number, Patch>;
  /** The circle around each patch, FRAME_FLOATS numbers per node in `order`. */
  frames: number[];
  paint(fill: (node: number, territory: string) => string): void;
  /** Raise each territory with its armies (and lay the layer out again). */
  setHeights(armies: (node: number, territory: string) => number | null): void;
  place(patchOf: (node: number) => Patch): void;
  setOpacity(o: number): void;
  dispose(): void;
}

function buildLayer(patches: Map<number, Patch>, nodes: readonly NestNode[], mapOf: (id: string) => MapDef): Layer {
  // Every vertex keeps its board point (u, v) and node, so the layer can be laid out again on other patches.
  const uv: number[] = [];
  const vNode: number[] = [];
  /** 1 for a vertex on top of the land (it rises with the armies), 0 for the foot of a side wall. */
  const vTop: number[] = [];
  /** 1 for a side-wall vertex (painted darker). */
  const vWall: number[] = [];
  const triNode: number[] = [];
  const ranges: { node: number; territory: string; from: number; to: number; bFrom: number; bTo: number }[] = [];
  const buv: number[] = [];
  const bNode: number[] = [];
  const frames: number[] = [];
  const MAX_ARC = 0.05; // split triangles longer than this (radians) so big boards follow the curve
  for (const [i, p] of patches) {
    const map = mapOf(nodes[i].map);
    for (const t of map.territories) {
      const from = uv.length / 2;
      const bFrom = buv.length / 2;
      for (const ring of pathRings(t.path)) {
        const contour = ring.map(([u, v]) => new THREE.Vector2(u, v));
        if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        const emit = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, level: number) => {
          const len = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) * p.k;
          if (len > MAX_ARC && level < 4) {
            const [ab, bc, ca] = [a.clone().lerp(b, 0.5), b.clone().lerp(c, 0.5), c.clone().lerp(a, 0.5)];
            emit(a, ab, ca, level + 1);
            emit(ab, b, bc, level + 1);
            emit(ca, bc, c, level + 1);
            emit(ab, bc, ca, level + 1);
            return;
          }
          // Board v grows downwards, so flip the winding to face outwards.
          for (const q of [a, c, b]) uv.push(q.x, q.y), vNode.push(i), vTop.push(1), vWall.push(0);
          triNode.push(i);
        };
        for (const [a, b, c] of tris) emit(contour[a], contour[b], contour[c], 0);
        for (let k = 0; k < ring.length; k++) {
          const [u0, v0] = ring[k];
          const [u1, v1] = ring[(k + 1) % ring.length];
          buv.push(u0, v0, u1, v1);
          bNode.push(i, i);
          // A side wall under this edge, from the land's foot up to its top (seen once the territory rises).
          for (const [u, v, top] of [[u0, v0, 1], [u1, v1, 1], [u0, v0, 0], [u1, v1, 1], [u1, v1, 0], [u0, v0, 0]] as const)
            uv.push(u, v), vNode.push(i), vTop.push(top), vWall.push(1);
          triNode.push(i, i);
        }
      }
      ranges.push({ node: i, territory: t.id, from, to: uv.length / 2, bFrom, bTo: buv.length / 2 });
    }
    // A thin circle around each table's patch.
    const [x0, y0, x1, y1] = landBox(map);
    const a = p.k * (Math.hypot(x1 - x0, y1 - y0) / 2) * 1.02;
    for (let s = 0; s < FRAME_SEGMENTS; s++) {
      for (const m of [s, s + 1]) {
        const th = (m / FRAME_SEGMENTS) * Math.PI * 2;
        const d = [0, 1, 2].map((x) => p.east[x] * Math.cos(th) + p.north[x] * Math.sin(th));
        frames.push(...[0, 1, 2].map((x) => (p.centre[x] * Math.cos(a) + d[x] * Math.sin(a)) * 1.002));
      }
    }
  }
  const group = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(uv.length * 1.5);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const colours = new Float32Array(uv.length * 1.5);
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const meshMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide, transparent: true });
  const mesh = new THREE.Mesh(geo, meshMat);
  group.add(mesh);
  const borderGeo = new THREE.BufferGeometry();
  const bpos = new Float32Array(buv.length * 1.5);
  borderGeo.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
  const borderMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  group.add(new THREE.LineSegments(borderGeo, borderMat));
  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.Float32BufferAttribute(frames, 3));
  const frameMat = new THREE.LineBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.35 });
  const frameLines = new THREE.LineSegments(frameGeo, frameMat);
  group.add(frameLines);

  // Each vertex's distance from the centre: the land's lift, raised with the territory's armies.
  const vLift = new Float32Array(vNode.length).fill(LIFT);
  // Wall feet sit just under the land so a flat territory shows no wall.
  for (let v = 0; v < vNode.length; v++) if (!vTop[v]) vLift[v] = LIFT - 0.0005;
  const bLift = new Float32Array(bNode.length).fill(LIFT);
  let current: (node: number) => Patch = (node) => patches.get(node)!;
  const place = (patchOf: (node: number) => Patch) => {
    current = patchOf;
    for (let v = 0; v < vNode.length; v++) pos.set(onPatch(patchOf(vNode[v]), uv[2 * v], uv[2 * v + 1], vLift[v]), 3 * v);
    for (let v = 0; v < bNode.length; v++) bpos.set(onPatch(patchOf(bNode[v]), buv[2 * v], buv[2 * v + 1], bLift[v] + 0.0008), 3 * v);
    geo.attributes.position.needsUpdate = true;
    borderGeo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    borderGeo.computeBoundingSphere();
    // Frames belong to the laid-out patches; while the boards move (a round change) they are hidden.
    frameLines.visible = patchOf === laidOut;
  };
  const laidOut = (node: number) => patches.get(node)!;
  place(laidOut);

  const c = new THREE.Color();
  return {
    group,
    mesh,
    triNode,
    order: [...patches.keys()],
    patches,
    frames,
    paint(fill) {
      for (const r of ranges) {
        c.set(fill(r.node, r.territory));
        const [wr, wg, wb] = [c.r * 0.55, c.g * 0.55, c.b * 0.55];
        for (let v = r.from; v < r.to; v++) colours.set(vWall[v] ? [wr, wg, wb] : [c.r, c.g, c.b], v * 3);
      }
      geo.attributes.color.needsUpdate = true;
    },
    setHeights(armies) {
      let changed = false;
      for (const r of ranges) {
        const h = patchLift(armies(r.node, r.territory));
        if (vLift[r.from] === Math.fround(h) && (r.bFrom === r.bTo || bLift[r.bFrom] === Math.fround(h))) continue;
        for (let v = r.from; v < r.to; v++) if (vTop[v]) vLift[v] = h;
        bLift.fill(h, r.bFrom, r.bTo);
        changed = true;
      }
      if (changed) place(current);
    },
    place,
    setOpacity(o) {
      meshMat.opacity = o;
      borderMat.opacity = 0.35 * o;
      frameMat.opacity = 0.35 * o;
      group.visible = o > 0.001;
    },
    dispose() {
      for (const x of [geo, borderGeo, frameGeo, meshMat, borderMat, frameMat]) x.dispose();
    },
  };
}

/**
 * Where a finished table's board ends up: centred on its portal (its winner's starting territory) on the parent's
 * patch, shrunk to that territory's size.
 */
function shrinkTarget(nodes: readonly NestNode[], mapOf: (id: string) => MapDef, node: number, parent: Patch, from: Patch): Patch {
  const n = nodes[node];
  const parentMap = mapOf(nodes[n.parent!].map);
  const portal = parentMap.territoryById[n.portal!];
  if (!portal) return { ...from, k: from.k * 0.05 };
  const [bx, by, bw, bh] = portal.bbox;
  const centre = onPatch(parent, bx + bw / 2, by + bh / 2, 1);
  const [x0, y0, x1, y1] = landBox(mapOf(n.map));
  const k = (parent.k * (Math.min(bw, bh) / 2)) / (Math.hypot(x1 - x0, y1 - y0) / 2);
  return { ...from, centre, ...frameAt(centre), k };
}

/** A patch part way from `a` to `b` (centres along the great circle, scale in between). */
function lerpPatch(a: Patch, b: Patch, t: number): Patch {
  const centre = [0, 1, 2].map((x) => a.centre[x] + (b.centre[x] - a.centre[x]) * t) as Vec3;
  const l = Math.hypot(...centre) || 1;
  const c: Vec3 = [centre[0] / l, centre[1] / l, centre[2] / l];
  return { ...a, centre: c, ...frameAt(c), k: a.k * (b.k / a.k) ** t };
}

/**
 * The round in play when it is a final on a hex-globe board (Hex Earth): the whole globe is that board, its hexes in
 * the final table's colours (portals show the arriving winners before the deal), raised with their armies. It is a
 * layer like a round of patches, so the previous round shrinks into it. Its one "patch" is the final itself, centred
 * between its portals (for the camera and the label).
 */
function buildGlobeLayer(globe: GlobeData, nodes: readonly NestNode[]): Layer {
  const shape = buildShape(globe);
  const root = nodes.findIndex((n) => n.parent === null);
  const portals = nodes[root]?.portals ?? [];
  // A portal hex picks the board inside it (zoom into the flat sub-board); any other hex picks the final.
  const insideOf = new Map(portals.map((t) => [t, nodes.findIndex((n) => n.parent === root && n.portal === t)]));
  const between = new THREE.Vector3();
  for (const t of portals) {
    const d = shape.badgeDir.get(t);
    if (d) between.add(d);
  }
  const centre: Vec3 = between.lengthSq() > 1e-6 ? (between.normalize().toArray() as Vec3) : [0, 0, 1];
  const patches = new Map<number, Patch>([[root, { centre, ...frameAt(centre), k: 0, cu: 0, cv: 0 }]]);

  const group = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, side: THREE.DoubleSide, transparent: true });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);
  const lines = new THREE.BufferGeometry();
  const lineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 });
  group.add(new THREE.LineSegments(lines, lineMat));
  const triNode: number[] = [];
  let fillOf: (node: number, territory: string) => string = () => '#888';
  let armiesOf: (node: number, territory: string) => number | null = () => null;

  const build = () => {
    const pos: number[] = [];
    const col: number[] = [];
    triNode.length = 0;
    const c = new THREE.Color();
    const heights = new Map<string, number>();
    const heightOf = (t: number) => {
      if (t < 0) return t === -2 ? ICE : 1;
      const id = globe.territories[t];
      if (!heights.has(id)) heights.set(id, heightFor(armiesOf(root, id) ?? 0));
      return heights.get(id)!;
    };
    globe.cells.forEach((cell, ci) => {
      const id = cell.t >= 0 ? globe.territories[cell.t] : null;
      const h = heightOf(cell.t);
      if (id) c.set(fillOf(root, id));
      else c.set(cell.t === -2 ? '#e6edf5' : '#3b86a8');
      c.offsetHSL(0, 0, (((ci * 7) % 5) - 2) * 0.01);
      const side = c.clone().multiplyScalar(0.6);
      const ctr = shape.centres[ci].clone().multiplyScalar(h);
      const ring = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(h));
      const base = cell.v.map((k) => shape.corners[k].clone().multiplyScalar(0.999));
      const pick = id && insideOf.has(id) && insideOf.get(id)! >= 0 ? insideOf.get(id)! : root;
      const put = (p: THREE.Vector3, k: THREE.Color) => {
        pos.push(p.x, p.y, p.z);
        col.push(k.r, k.g, k.b);
      };
      for (let j = 0; j < ring.length; j++) {
        const n = (j + 1) % ring.length;
        put(ctr, c), put(ring[n].clone().lerp(ctr, 0.035), c), put(ring[j].clone().lerp(ctr, 0.035), c);
        triNode.push(pick);
        if (h > 1) {
          put(ring[j], side), put(ring[n], side), put(base[j], side);
          put(ring[n], side), put(base[n], side), put(base[j], side);
          triNode.push(pick, pick);
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
  build();

  return {
    group,
    mesh,
    triNode,
    order: [root],
    patches,
    frames: [],
    paint(fill) {
      fillOf = fill;
      build();
    },
    setHeights(armies) {
      armiesOf = armies;
      build();
    },
    place() {
      // The globe never moves.
    },
    setOpacity(o) {
      mat.opacity = o;
      lineMat.opacity = 0.45 * o;
      group.visible = o > 0.001;
    },
    dispose() {
      for (const x of [geo, lines, mat, lineMat]) x.dispose();
    },
  };
}

/** Where a board ends up when the final is a hex-globe board: on its portal's hexes, shrunk to that territory's size. */
function shrinkToGlobe(globe: GlobeData, nodes: readonly NestNode[], mapOf: (id: string) => MapDef, node: number, from: Patch): Patch {
  const shape = globeShapes.get(globe) ?? globeShapes.set(globe, buildShape(globe)).get(globe)!;
  const dir = shape.badgeDir.get(nodes[node].portal ?? '');
  if (!dir) return { ...from, k: from.k * 0.05 };
  const centre = dir.toArray() as Vec3;
  const t = globe.territories.indexOf(nodes[node].portal!);
  const cells = globe.cells.filter((c) => c.t === t).length || 1;
  // A hex is about 0.1 rad across at frequency 12: a territory of n hexes is about 0.05 * sqrt(n) rad in radius.
  const radius = (0.6 / globe.frequency) * Math.sqrt(cells);
  const [x0, y0, x1, y1] = landBox(mapOf(nodes[node].map));
  return { ...from, centre, ...frameAt(centre), k: radius / (Math.hypot(x1 - x0, y1 - y0) / 2) };
}
const globeShapes = new WeakMap<GlobeData, Shape>();
