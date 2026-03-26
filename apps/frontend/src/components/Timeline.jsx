import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as PIXI from 'pixi.js';
import { clampTs, formatHHMM } from '../utils/time.js';
import {
  RETICLE_FRACTION, RETICLE_COLOR, RETICLE_BAR_H, RETICLE_DOT_SIZE,
  ICON_SIZE_PERSON, ICON_SIZE_ANIMAL, ICON_FALLBACK_R,
  ARROW_W, ARROW_H, PERSON_LABELS, ANIMAL_LABELS,
  EVENT_COLORS, ASSET_PATHS, TICK_INTERVALS, MIN_TICK_PX,
  DAMPING, K, K_TOUCH,
} from '../utils/constants.js';

const WHEEL = {
  rowHeight: 112,
  displayRadius: 900,
  depthPower: 8.0,
  minScale: 0.02,
  maxScale: 1.0,
  minAlpha: 0.0,
  maxAlpha: 1.0,
  sideParallax: 30,
  textParallax: 12,
  visibleBackCutoff: -0.08,
  dividerMinAlpha: 0.0,
  dividerFrontAlpha: 0.25,
  unselectedTextColor: 0x6b7080,
  selectedTextColor: 0xf5f0ea,
  centerLineColor: 0x6b7485,
  centerLineAlpha: 0.22,
  rowPoolSize: 75,
};

// ── PixiJS app factory ───────────────────────────────────────────────────────

async function createApp(canvas, w, h) {
  const app = new PIXI.Application();
  await app.init({
    canvas,
    width: w,
    height: h,
    backgroundColor: 0x1a1d24,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    preference: 'webgpu',
  });
  return app;
}

function makeSprite(tex, { w, h, ax = 0.5, ay = 0.5, tint = 0xFFFFFF, alpha = 1 } = {}) {
  if (!tex) return null;
  const s = new PIXI.Sprite(tex);
  s.anchor.set(ax, ay);
  if (w != null) s.width = w;
  if (h != null) s.height = h;
  s.tint = tint;
  s.alpha = alpha;
  return s;
}

function makeFallbackCircle(color, alpha = 1) {
  const g = new PIXI.Graphics();
  g.circle(0, 0, ICON_FALLBACK_R).fill({ color, alpha });
  return g;
}

function shortestAngleDiff(a, b) {
  const TAU = Math.PI * 2;
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

function pickTickInterval(rangeSec, h) {
  const maxTicks = Math.max(3, Math.floor(h / MIN_TICK_PX));
  return TICK_INTERVALS.find(t => t >= rangeSec / maxTicks) ?? 86400;
}

function formatParts(ts, timeFormat) {
  const d = new Date(ts * 1000);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();
  const is12h = timeFormat === '12h';
  const isPM = hours >= 12;

  let displayHours = hours;
  if (is12h) {
    displayHours = hours % 12;
    if (displayHours === 0) displayHours = 12;
  }

  return {
    hh: String(displayHours).padStart(2, '0'),
    mm: String(minutes).padStart(2, '0'),
    ss: String(seconds).padStart(2, '0'),
    is12h,
    isPM,
  };
}

function createWheelRow(fontFamily) {
  const row = new PIXI.Container();

  const divider = new PIXI.Graphics();
  row.addChild(divider);

  const simpleText = new PIXI.Text({
    text: '12:00',
    style: new PIXI.TextStyle({
      fontFamily,
      fontSize: 48,
      fontWeight: '500',
      fill: '#a7afbc',
    }),
  });
  simpleText.anchor.set(0.5);
  row.addChild(simpleText);

  const centerReadout = new PIXI.Container();
  centerReadout.visible = false;
  row.addChild(centerReadout);

  const leftIconSlot = new PIXI.Container();
  const rightIconSlot = new PIXI.Container();
  row.addChild(leftIconSlot);
  row.addChild(rightIconSlot);

  row.divider = divider;
  row.simpleText = simpleText;
  row.centerReadout = centerReadout;
  row.leftIconSlot = leftIconSlot;
  row.rightIconSlot = rightIconSlot;

  return row;
}

function buildCenterReadout(container, parts, fontFamily) {
  container.removeChildren();

  const white = 0xf5f0ea;
  const orange = RETICLE_COLOR;

  let x = 0;

  // AM/PM badge — only show the active one in a rounded rect
  if (parts.is12h) {
    const badgeLabel = parts.isPM ? 'PM' : 'AM';

    const badgeBg = new PIXI.Graphics();
    badgeBg.roundRect(-2, -14, 32, 28, 6).stroke({ color: 0x888888, alpha: 0.6, width: 1.5 });
    container.addChild(badgeBg);

    const badge = new PIXI.Text({
      text: badgeLabel,
      style: new PIXI.TextStyle({
        fontFamily,
        fontSize: 13,
        fontWeight: '700',
        fill: white,
      }),
    });
    badge.anchor.set(0.5, 0.5);
    badge.x = 14;
    badge.y = 0;
    container.addChild(badge);

    x += 40;
  }

  const makeBig = (text, color = white) => new PIXI.Text({
    text,
    style: new PIXI.TextStyle({
      fontFamily,
      fontSize: 36,
      fontWeight: '700',
      fill: color,
      letterSpacing: -1,
    }),
  });

  const makeSubscript = (text, color = white) => new PIXI.Text({
    text,
    style: new PIXI.TextStyle({
      fontFamily,
      fontSize: 14,
      fontWeight: '600',
      fill: color,
    }),
  });

  const hh = makeBig(parts.hh);
  hh.anchor.set(0, 0.5);
  hh.x = x;
  hh.y = 0;
  container.addChild(hh);
  x += hh.width + 1;

  const hLbl = makeSubscript('H');
  hLbl.anchor.set(0, 0);
  hLbl.x = x;
  hLbl.y = 2;
  container.addChild(hLbl);
  x += hLbl.width + 4;

  const mm = makeBig(parts.mm);
  mm.anchor.set(0, 0.5);
  mm.x = x;
  mm.y = 0;
  container.addChild(mm);
  x += mm.width + 1;

  const mLbl = makeSubscript('M');
  mLbl.anchor.set(0, 0);
  mLbl.x = x;
  mLbl.y = 2;
  container.addChild(mLbl);
  x += mLbl.width + 4;

  const ss = makeBig(parts.ss, orange);
  ss.anchor.set(0, 0.5);
  ss.x = x;
  ss.y = 0;
  container.addChild(ss);
  x += ss.width + 1;

  const sLbl = makeSubscript('S', orange);
  sLbl.anchor.set(0, 0);
  sLbl.x = x;
  sLbl.y = 2;
  container.addChild(sLbl);
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Timeline({
  startTs,
  endTs,
  gaps = [],
  events = [],
  densityData = null,
  activeLabels = null,
  cursorTs,
  onSeek,
  onPan,
  onPreviewRequest = null,
  timeFormat = '12h',
  paddingLeft = 10,
  paddingRight = 8,
}) {
  const canvasRef = useRef(null);
  const appRef = useRef(null);
  const appReadyRef = useRef(false);
  const layersRef = useRef({});
  const texRef = useRef({});

  const isDragging = useRef(false);
  const touchStartRef = useRef(null);
  const scrollVelocityRef = useRef(0);
  const scrollRafRef = useRef(null);
  const touchPannedRef = useRef(false);
  const animRef = useRef(null);

  const [dims, setDims] = useState({ w: 215, h: 600 });

  const range = endTs - startTs;
  const secondsPerPixel = useMemo(() => (dims.h > 0 ? range / dims.h : 1), [range, dims.h]);
  const tsToY = useCallback(ts => (endTs - ts) / secondsPerPixel, [endTs, secondsPerPixel]);
  const yToTs = useCallback(
    y => clampTs(endTs - y * secondsPerPixel, startTs, endTs),
    [startTs, endTs, secondsPerPixel]
  );

  const fontFamily = 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace';

  const createEventIcon = useCallback((label, tint, alpha = 1) => {
    const isPerson = PERSON_LABELS.has(label);
    const isAnimal = ANIMAL_LABELS.has(label);
    const tex = isPerson ? texRef.current.person : isAnimal ? texRef.current.animal : null;

    if (tex) {
      const dim = isPerson ? ICON_SIZE_PERSON : ICON_SIZE_ANIMAL;
      return makeSprite(tex, { w: dim.w, h: dim.h, tint, alpha });
    }

    return makeFallbackCircle(tint, alpha);
  }, []);

  // Reticle bar — the rtcl-bar SVG already has triangular endpoints built in,
  // so we just stretch it from the midpoint to the right edge. No dots needed.
  function buildReticle(container, w, reticleY) {
    container.removeChildren();
    const tex = texRef.current;

    const barStart = Math.round(w * 0.48);
    const barEnd = w;
    const barW = barEnd - barStart;
    const barH = 16;

    if (tex.rtclBar) {
      const bar = makeSprite(tex.rtclBar, {
        w: barW,
        h: barH,
        ax: 0,
        ay: 0.5,
        tint: RETICLE_COLOR,
      });
      bar.x = barStart;
      bar.y = reticleY;
      container.addChild(bar);
    } else {
      // Fallback: simple line with triangle endpoints
      const g = new PIXI.Graphics();
      g.moveTo(barStart, reticleY).lineTo(barEnd, reticleY)
        .stroke({ color: RETICLE_COLOR, alpha: 0.9, width: 3 });
      // Left triangle
      g.poly([barStart, reticleY, barStart + 8, reticleY - 6, barStart + 8, reticleY + 6])
        .fill({ color: RETICLE_COLOR });
      // Right triangle
      g.poly([barEnd, reticleY, barEnd - 8, reticleY - 6, barEnd - 8, reticleY + 6])
        .fill({ color: RETICLE_COLOR });
      container.addChild(g);
    }
  }

  // Hints on BOTH left and right edges
  function buildScrollHints(container, w, h) {
    container.removeChildren();
    const tex = texRef.current;
    if (!tex.arrow) return;

    const edgeInset = 18;
    const arrowGap = ARROW_W * 0.6;

    // Helper: place a pair of arrows + label at a given edge X
    function placeHintColumn(centerX, label, isTop) {
      for (const xOff of [-arrowGap, arrowGap]) {
        const s = makeSprite(tex.arrow, {
          w: ARROW_W,
          h: ARROW_H,
          ax: 0.5,
          ay: isTop ? 1 : 0,
          tint: 0x808080,
          alpha: 0.55,
        });
        if (isTop) s.scale.y = -1;
        s.x = centerX + xOff;
        s.y = isTop ? 42 : h - 42;
        container.addChild(s);
      }

      const txt = new PIXI.Text({
        text: label,
        style: new PIXI.TextStyle({
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 10,
          fill: '#808080',
        }),
      });
      txt.anchor.set(0.5, 0.5);
      txt.rotation = -Math.PI / 2;
      txt.x = centerX;
      txt.y = isTop ? 14 : h - 14;
      container.addChild(txt);
    }

    // PAST hints — top, on both left and right edges
    placeHintColumn(edgeInset, 'PAST', true);
    placeHintColumn(w - edgeInset, 'PAST', true);

    // NOW hints — bottom, on both left and right edges
    placeHintColumn(edgeInset, 'NOW', false);
    placeHintColumn(w - edgeInset, 'NOW', false);
  }

  const drawAllRef = useRef(null);

  const drawAll = useCallback(() => {
    if (!appReadyRef.current) return;

    const { bg, wheelC, hintC, reticleC } = layersRef.current;
    const { w, h } = dims;
    const reticleY = h * RETICLE_FRACTION;

    // Plain flat background
    bg.clear();
    bg.rect(0, 0, w, h).fill({ color: 0x1a1d24 });

    wheelC.removeChildren();

    const tickSec = pickTickInterval(range, h);
    const currentTickFloat = cursorTs / tickSec;
    const angleStep = (Math.PI * 2) / 60;
    const currentAngle = currentTickFloat * angleStep;
    const baseIndex = Math.floor(currentTickFloat);
    const halfPool = Math.floor(WHEEL.rowPoolSize / 2);

    // Icon zone — right portion of canvas
    const iconZoneLeft = Math.round(w * 0.58);
    const iconZoneRight = w - paddingRight;
    const iconZoneMid = (iconZoneLeft + iconZoneRight) / 2;

    for (let slot = 0; slot < WHEEL.rowPoolSize; slot++) {
      const row = createWheelRow(fontFamily);
      const logicalIndex = baseIndex + (slot - halfPool);
      const tickTs = logicalIndex * tickSec;

      if (tickTs < startTs - tickSec * 2 || tickTs > endTs + tickSec * 2) continue;

      const rowAngle = logicalIndex * angleStep;
      const angle = shortestAngleDiff(rowAngle, currentAngle);

      const y = Math.sin(angle) * WHEEL.displayRadius;
      const z = Math.cos(angle);
      const front = Math.max(0, z);
      const shaped = Math.pow(front, WHEEL.depthPower);
      // Alpha drops even faster than scale — use a steeper curve
      const alphaShape = Math.pow(front, WHEEL.depthPower * 1.5);

      const isCenter = Math.abs(angle) < angleStep * 0.5;

      // Pin the center row to the reticle line; other rows float on the wheel
      if (isCenter) {
        row.y = reticleY - WHEEL.rowHeight / 2;
      } else {
        row.y = reticleY + y - WHEEL.rowHeight / 2;
      }
      row.visible = z > WHEEL.visibleBackCutoff;

      const rowAlpha = WHEEL.minAlpha + alphaShape * (WHEEL.maxAlpha - WHEEL.minAlpha);
      row.alpha = rowAlpha;

      const scale = WHEEL.minScale + shaped * (WHEEL.maxScale - WHEEL.minScale);
      const yScale = scale * (0.65 + 0.35 * front);
      const sideOffset = (1 - front) * WHEEL.sideParallax;
      const textOffset = -Math.sin(angle) * WHEEL.textParallax;

      // Divider line — full canvas width, fades with row
      row.divider.clear();
      const divAlpha = WHEEL.dividerMinAlpha + shaped * WHEEL.dividerFrontAlpha;
      row.divider.moveTo(0, WHEEL.rowHeight).lineTo(w, WHEEL.rowHeight).stroke({
        color: 0x3a3f4a,
        alpha: divAlpha,
        width: 1,
      });

      row.simpleText.visible = !isCenter;
      row.centerReadout.visible = isCenter;

      if (!isCenter) {
        row.simpleText.text = formatHHMM(tickTs, timeFormat);
        // Center the text horizontally in the left half of the canvas
        row.simpleText.x = w * 0.25 + textOffset;
        row.simpleText.y = WHEEL.rowHeight / 2;
        row.simpleText.scale.set(scale, yScale);
        // Blend text color toward dim based on distance from center
        const colorBlend = Math.pow(shaped, 0.5);
        const dimR = 0x40, dimG = 0x44, dimB = 0x4c;
        const brightR = 0xa7, brightG = 0xaf, brightB = 0xbc;
        const r = Math.round(dimR + (brightR - dimR) * colorBlend);
        const g = Math.round(dimG + (brightG - dimG) * colorBlend);
        const b = Math.round(dimB + (brightB - dimB) * colorBlend);
        row.simpleText.style.fill = (r << 16) | (g << 8) | b;
        row.simpleText.style.fontWeight = '500';
      } else {
        const parts = formatParts(cursorTs, timeFormat);
        buildCenterReadout(row.centerReadout, parts, fontFamily);
        row.centerReadout.x = 8;
        row.centerReadout.y = WHEEL.rowHeight / 2;
      }

      // Event icons — placed in right zone, scaled with the row
      row.leftIconSlot.removeChildren();
      row.rightIconSlot.removeChildren();

      const nearbyEvents = events.filter(evt => {
        const ts = evt.start_ts ?? evt.start_time ?? evt.timestamp;
        if (ts == null) return false;
        return Math.abs(ts - tickTs) < tickSec * 0.5;
      });

      const leftEvent =
        nearbyEvents.find(evt => PERSON_LABELS.has(evt.label)) ??
        nearbyEvents[0] ??
        null;

      const rightEvent =
        nearbyEvents.find(evt => ANIMAL_LABELS.has(evt.label)) ??
        nearbyEvents[1] ??
        nearbyEvents[0] ??
        null;

      if (leftEvent) {
        const col = EVENT_COLORS[leftEvent.label] ?? EVENT_COLORS.default;
        const icon = createEventIcon(leftEvent.label, isCenter ? RETICLE_COLOR : col, 1);
        if (icon) {
          icon.x = iconZoneMid - 30 - sideOffset;
          icon.y = WHEEL.rowHeight / 2;
          icon.scale.set(scale * 1.2);
          row.leftIconSlot.addChild(icon);
        }
      }

      if (rightEvent) {
        const col = EVENT_COLORS[rightEvent.label] ?? EVENT_COLORS.default;
        const icon = createEventIcon(rightEvent.label, isCenter ? RETICLE_COLOR : col, 1);
        if (icon) {
          icon.x = iconZoneMid + 30 + sideOffset;
          icon.y = WHEEL.rowHeight / 2;
          icon.scale.set(scale * 1.2);
          row.rightIconSlot.addChild(icon);
        }
      }

      wheelC.addChild(row);
    }

    buildScrollHints(hintC, w, h);
    buildReticle(reticleC, w, reticleY);

    appRef.current?.render();
  }, [
    dims,
    startTs,
    endTs,
    events,
    cursorTs,
    range,
    timeFormat,
    paddingLeft,
    paddingRight,
    createEventIcon,
  ]);

  // Keep drawAllRef in sync so the init effect can call it without a dep cycle
  useEffect(() => { drawAllRef.current = drawAll; }, [drawAll]);

  // Init PixiJS app — only re-runs on canvas size change, NOT on drawAll identity
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dead = false;

    (async () => {
      const app = await createApp(canvas, dims.w, dims.h);
      if (dead) {
        app.destroy();
        return;
      }

      appRef.current = app;

      try {
        const tex = {};
        tex.rtclBar = await PIXI.Assets.load(ASSET_PATHS.rtclBar);
        tex.rtclDot = await PIXI.Assets.load(ASSET_PATHS.rtclDot);
        tex.person = await PIXI.Assets.load(ASSET_PATHS.person);
        tex.animal = await PIXI.Assets.load(ASSET_PATHS.animal);
        tex.arrow = await PIXI.Assets.load(ASSET_PATHS.arrow);
        texRef.current = tex;
      } catch (e) {
        console.warn('[Timeline] SVG load failed:', e.message);
      }

      const bg = new PIXI.Graphics();
      const wheelC = new PIXI.Container();
      const hintC = new PIXI.Container();
      const reticleC = new PIXI.Container();

      app.stage.addChild(bg, wheelC, hintC, reticleC);
      layersRef.current = { bg, wheelC, hintC, reticleC };

      appReadyRef.current = true;
      if (!dead) drawAllRef.current?.();
    })();

    return () => {
      dead = true;
      appReadyRef.current = false;
      appRef.current?.destroy(false);
      appRef.current = null;
    };
  }, [dims.w, dims.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw when drawAll changes (cursor, zoom, data, etc.)
  useEffect(() => {
    if (!appReadyRef.current) return;
    drawAll();
  }, [drawAll]);

  // Resize renderer when canvas dimensions change
  useEffect(() => {
    if (!appReadyRef.current) return;
    appRef.current?.renderer.resize(dims.w, dims.h);
    drawAllRef.current?.();
  }, [dims.w, dims.h]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setDims({ w: Math.max(width, 1), h: Math.max(height, 1) });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => () => {
    if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);
  }, []);

  const decayScroll = useCallback(() => {
    const DEAD = secondsPerPixel * 0.002;
    const rs = endTs - startTs;
    const zf = Math.min(1.0, rs / 3600);

    scrollVelocityRef.current *= 0.88 + (DAMPING - 0.88) * zf;

    if (Math.abs(scrollVelocityRef.current) < DEAD) {
      scrollVelocityRef.current = 0;
      scrollRafRef.current = null;
      return;
    }

    onPan(scrollVelocityRef.current);
    scrollRafRef.current = requestAnimationFrame(decayScroll);
  }, [onPan, secondsPerPixel, endTs, startTs]);

  const handleWheel = useCallback((e) => {
    if (!onPan) return;
    e.preventDefault();

    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }

    const nd = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 15);
    const curved = Math.sign(nd) * (nd / 15) ** 2 * 15;
    const zf = Math.min(1.0, (endTs - startTs) / 3600);

    scrollVelocityRef.current += curved * secondsPerPixel * K * (0.3 + 0.7 * zf);
    onPan(scrollVelocityRef.current);

    const maxV = Math.min((endTs - startTs) * 0.10, 3600);
    scrollVelocityRef.current = Math.max(-maxV, Math.min(maxV, scrollVelocityRef.current));

    scrollRafRef.current = requestAnimationFrame(decayScroll);
  }, [onPan, secondsPerPixel, endTs, startTs, decayScroll]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    c.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      c.removeEventListener('wheel', handleWheel);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [handleWheel]);

  const getTs = useCallback(e => {
    const r = canvasRef.current?.getBoundingClientRect();
    return r ? yToTs(e.clientY - r.top) : null;
  }, [yToTs]);

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
  }, []);

  const handleMouseUp = useCallback((e) => {
    if (!isDragging.current) return;
    isDragging.current = false;

    const ts = getTs(e);
    if (ts == null) return;

    const from = cursorTs;
    const t0 = performance.now();

    if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);

    function tick(now) {
      const p = Math.min((now - t0) / 250, 1);
      const interp = from + (ts - from) * (1 - (1 - p) ** 3);
      onSeek?.(interp);
      if (p < 1) animRef.current = { rafId: requestAnimationFrame(tick) };
      else animRef.current = null;
    }

    animRef.current = { rafId: requestAnimationFrame(tick) };
  }, [getTs, onSeek, cursorTs]);

  const handleMouseLeave = useCallback(() => {
    scrollVelocityRef.current = 0;
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    isDragging.current = false;
  }, []);

  return (
    <div className="timeline-wrapper">
      <div className="timeline-canvas-container">
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onMouseMove={e => {
            if (!onPreviewRequest) return;
            const ts = getTs(e);
            if (ts != null) onPreviewRequest(ts);
          }}
          onTouchStart={e => {
            scrollVelocityRef.current = 0;
            touchPannedRef.current = false;
            if (scrollRafRef.current) {
              cancelAnimationFrame(scrollRafRef.current);
              scrollRafRef.current = null;
            }
            e.preventDefault();
            e.stopPropagation();
            const t = e.touches[0];
            touchStartRef.current = { x: t.clientX, y: t.clientY };
            handleMouseDown();
          }}
          onTouchMove={e => {
            e.preventDefault();
            e.stopPropagation();
            const t = e.touches[0];
            const dy = t.clientY - (touchStartRef.current?.y ?? t.clientY);

            if (Math.abs(dy) > 5 && onPan) {
              touchPannedRef.current = true;
              if (scrollRafRef.current) {
                cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = null;
              }
              const nd = Math.sign(dy) * Math.min(Math.abs(dy), 60);
              const curved = Math.sign(nd) * (nd / 60) ** 2 * 60;
              const zf = Math.min(1.0, (endTs - startTs) / 3600);
              scrollVelocityRef.current = curved * secondsPerPixel * K_TOUCH * (0.3 + 0.7 * zf);
              onPan(scrollVelocityRef.current);
              touchStartRef.current = { x: t.clientX, y: t.clientY };
            }
          }}
          onTouchEnd={e => {
            e.preventDefault();
            e.stopPropagation();
            const t = e.changedTouches[0];

            if (touchPannedRef.current) {
              if (Math.abs(scrollVelocityRef.current) > secondsPerPixel * 0.002) {
                if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = requestAnimationFrame(decayScroll);
              }
              isDragging.current = false;
            } else {
              handleMouseUp({ clientX: t.clientX, clientY: t.clientY });
            }
          }}
        />
      </div>
    </div>
  );
}
