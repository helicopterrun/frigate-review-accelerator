/**
 * React hook that wires the accelerator pipeline via Socket.IO:
 *   viewport changes → emit to core-server → receive resolved slots
 *
 * The core-server owns slot resolution; the frontend only sends
 * viewport intent and renders results.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { buildViewport } from '../timeline/viewport.js';
import { buildSlots } from '../timeline/slots.js';
import { clampTs } from '../utils/time.js';
import { ZOOM_STOPS } from '../utils/constants.js';

const SLOT_COUNT = 60;
const VIEWPORT_ID = 'vp_main';
const DEBOUNCE_MS = 50;

export function useTimelineAccelerator(camera, socket) {
  const [cursorTs, setCursorTs] = useState(null);
  const [rangeSec, setRangeSec] = useState(3600);
  const [resolvedSlots, setResolvedSlots] = useState([]);
  const [subscribed, setSubscribed] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState(null);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [timeline, setTimeline] = useState(null);
  const [density, setDensity] = useState(null);

  const updateTimerRef = useRef(null);
  const lastEmitRef = useRef({ tCursor: 0, tWheel: 0 });

  // Derived viewport (millisecond units)
  const tWheelMs = rangeSec * 1000;
  const tCursorMs = cursorTs != null ? cursorTs * 1000 : null;
  const tNowMs = Date.now();

  const viewport = useMemo(() => {
    if (tCursorMs == null) return null;
    return buildViewport(tCursorMs, tNowMs, tWheelMs, SLOT_COUNT);
  }, [tCursorMs, tWheelMs, tNowMs]);

  const slots = useMemo(() => {
    if (!viewport) return [];
    return buildSlots(viewport);
  }, [viewport]);

  const startTs = viewport ? viewport.tViewStart / 1000 : null;
  const endTs = viewport ? viewport.tViewEnd / 1000 : null;

  // Init cursor to now
  useEffect(() => {
    if (camera && cursorTs == null) {
      setCursorTs(Date.now() / 1000);
    }
  }, [camera, cursorTs]);

  // Reset on camera change
  useEffect(() => {
    setResolvedSlots([]);
    setSubscribed(false);
    setTimeline(null);
    setDensity(null);
    setPlaybackUrl(null);
    setPreviewSrc(null);
    setPlaying(false);
  }, [camera]);

  // Subscribe when camera + socket are ready
  useEffect(() => {
    if (!socket || !camera || cursorTs == null) return;

    const handleSubscribed = (payload) => {
      setSubscribed(true);
    };

    const handleBatchResolved = (payload) => {
      if (payload.viewportId !== VIEWPORT_ID) return;
      setResolvedSlots(payload.slots);
    };

    const handleSlotResolved = (payload) => {
      if (payload.viewportId !== VIEWPORT_ID) return;
      setResolvedSlots(prev => {
        const next = [...prev];
        const idx = next.findIndex(s => s.slotIndex === payload.slotIndex);
        if (idx >= 0) next[idx] = payload;
        else next.push(payload);
        return next;
      });
    };

    socket.on('viewport:subscribed', handleSubscribed);
    socket.on('slots:batch_resolved', handleBatchResolved);
    socket.on('slot:resolved', handleSlotResolved);

    // Send initial subscription
    socket.emit('viewport:subscribe', {
      viewportId: VIEWPORT_ID,
      cameraIds: [camera],
      tCursor: cursorTs,
      tWheel: rangeSec,
      cSlots: SLOT_COUNT,
      filters: { objectLabels: [], zones: [], confidenceMin: 0 },
      clientState: { isScrubbing: false, wantsLive: false, scrollDirection: 'none' },
    });

    lastEmitRef.current = { tCursor: cursorTs, tWheel: rangeSec };

    return () => {
      socket.off('viewport:subscribed', handleSubscribed);
      socket.off('slots:batch_resolved', handleBatchResolved);
      socket.off('slot:resolved', handleSlotResolved);
    };
  }, [socket, camera]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced viewport updates on cursor/zoom change
  useEffect(() => {
    if (!socket || !subscribed || cursorTs == null) return;

    const last = lastEmitRef.current;
    if (last.tCursor === cursorTs && last.tWheel === rangeSec) return;

    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);

    updateTimerRef.current = setTimeout(() => {
      socket.emit('viewport:update', {
        viewportId: VIEWPORT_ID,
        tCursor: cursorTs,
        tWheel: rangeSec,
        clientState: { isScrubbing: false },
      });
      lastEmitRef.current = { tCursor: cursorTs, tWheel: rangeSec };
    }, DEBOUNCE_MS);

    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [socket, subscribed, cursorTs, rangeSec]);

  // User actions
  const onSeek = useCallback((ts) => {
    if (startTs != null && endTs != null) {
      setCursorTs(clampTs(ts, startTs, endTs));
    }
  }, [startTs, endTs]);

  const onPan = useCallback((deltaSec) => {
    setCursorTs(prev => prev != null ? prev + deltaSec : prev);
  }, []);

  const onZoomChange = useCallback((newRangeSec) => {
    const clamped = Math.max(ZOOM_STOPS[0], Math.min(ZOOM_STOPS[ZOOM_STOPS.length - 1], newRangeSec));
    setRangeSec(clamped);
  }, []);

  const onPreviewRequest = useCallback((ts) => {
    // Preview requests will be handled via media-service in later milestones
  }, []);

  const seek = useCallback((ts) => {
    setCursorTs(ts);
  }, []);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);

  return {
    cursorTs,
    startTs,
    endTs,
    rangeSec,
    timeline,
    density,
    resolvedSlots,
    playbackState: 'SCRUB_REVIEW',
    playbackUrl,
    preview: previewSrc,
    playing,
    subscribed,
    onSeek,
    onPan,
    onZoomChange,
    onPreviewRequest,
    seek,
    play,
    pause,
  };
}
