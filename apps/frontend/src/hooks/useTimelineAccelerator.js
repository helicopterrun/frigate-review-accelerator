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
const SETTLE_DELAY_MS = 400;

export function useTimelineAccelerator(camera, socket) {
  const [cursorTs, setCursorTs] = useState(null);
  const [rangeSec, setRangeSec] = useState(3600);
  const [resolvedSlots, setResolvedSlots] = useState([]);
  const [subscribed, setSubscribed] = useState(false);
  const [semanticFreshness, setSemanticFreshness] = useState('recovering');
  const [playbackState, setPlaybackState] = useState('SCRUB_REVIEW');
  const [playbackUrl, setPlaybackUrl] = useState(null);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [liveMode, setLiveMode] = useState(true); // Start in live mode
  const [loading, setLoading] = useState(true);
  const [timeline, setTimeline] = useState(null);
  const [density, setDensity] = useState(null);

  const updateTimerRef = useRef(null);
  const settleTimerRef = useRef(null);
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
    setPlaybackState('SCRUB_REVIEW');
  }, [camera]);

  // Subscribe when camera + socket are ready
  useEffect(() => {
    if (!socket || !camera || cursorTs == null) return;

    const handleSubscribed = (payload) => {
      setSubscribed(true);
      if (payload.semanticFreshness) setSemanticFreshness(payload.semanticFreshness);
      if (payload.playbackState) setPlaybackState(payload.playbackState);
    };

    const handleFreshness = (payload) => {
      if (payload.status) setSemanticFreshness(payload.status);
    };

    const handleSlotsDirty = (payload) => {
      if (payload.viewportId !== VIEWPORT_ID) return;
      setResolvedSlots(prev => prev.map(s =>
        payload.slotIndices?.includes(s.slotIndex)
          ? { ...s, status: 'dirty' }
          : s
      ));
    };

    const handleBatchResolved = (payload) => {
      if (payload.viewportId !== VIEWPORT_ID) return;
      setLoading(false);
      setResolvedSlots(prev => {
        const map = new Map(prev.map(s => [s.slotIndex, s]));
        for (const slot of payload.slots) {
          map.set(slot.slotIndex, slot);
        }
        const sorted = Array.from(map.values()).sort((a, b) => a.slotIndex - b.slotIndex);
        // Auto-show center slot preview if no preview set yet
        if (!previewSrc && sorted.length > 0) {
          const center = sorted[Math.floor(sorted.length / 2)];
          if (center?.mediaUrl) setPreviewSrc(center.mediaUrl);
        }
        return sorted;
      });
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

    const handlePlaybackState = (payload) => {
      if (payload.viewportId !== VIEWPORT_ID) return;
      setPlaybackState(payload.state);
      if (payload.vodUrl) {
        setPlaybackUrl(payload.vodUrl);
        setPlaying(true);
      }
      if (payload.state === 'SCRUB_REVIEW') {
        setPlaying(false);
      }
    };

    socket.on('viewport:subscribed', handleSubscribed);
    socket.on('slots:batch_resolved', handleBatchResolved);
    socket.on('slot:resolved', handleSlotResolved);
    socket.on('slots:dirty', handleSlotsDirty);
    socket.on('semantic:freshness', handleFreshness);
    socket.on('playback:state', handlePlaybackState);

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
      socket.off('slots:dirty', handleSlotsDirty);
      socket.off('semantic:freshness', handleFreshness);
      socket.off('playback:state', handlePlaybackState);
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
        clientState: { isScrubbing },
      });
      lastEmitRef.current = { tCursor: cursorTs, tWheel: rangeSec };
    }, DEBOUNCE_MS);

    return () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    };
  }, [socket, subscribed, cursorTs, rangeSec, isScrubbing]);

  // Slot duration in seconds (derived from viewport)
  const slotDurationSec = useMemo(() => {
    if (slots.length < 2) return rangeSec / SLOT_COUNT;
    return (slots[1].tSlotStart - slots[0].tSlotStart) / 1000;
  }, [slots, rangeSec]);

  // Snap a timestamp to the nearest slot center
  const snapToSlot = useCallback((ts) => {
    if (slots.length === 0) return ts;
    let best = slots[0];
    let bestDist = Math.abs(ts - best.tSlotCenter / 1000);
    for (const s of slots) {
      const dist = Math.abs(ts - s.tSlotCenter / 1000);
      if (dist < bestDist) { best = s; bestDist = dist; }
    }
    return best.tSlotCenter / 1000;
  }, [slots]);

  // Live mode timer — return to live after 5s of no interaction
  const liveModeTimerRef = useRef(null);
  const exitLiveMode = useCallback(() => {
    setLiveMode(false);
    if (liveModeTimerRef.current) clearTimeout(liveModeTimerRef.current);
    liveModeTimerRef.current = setTimeout(() => setLiveMode(true), 5000);
  }, []);

  // User actions
  const onSeek = useCallback((ts) => {
    if (startTs != null && endTs != null) {
      const clamped = clampTs(ts, startTs, endTs);
      setCursorTs(snapToSlot(clamped));
      exitLiveMode();
    }
  }, [startTs, endTs, snapToSlot, exitLiveMode]);

  /** Move the cursor by N slots (positive = forward/down toward NOW, negative = back/up toward PAST). */
  const onStepSlots = useCallback((slotDelta) => {
    setCursorTs(prev => {
      if (prev == null) return prev;
      const newTs = prev + slotDelta * slotDurationSec;
      if (startTs != null && endTs != null) {
        return clampTs(newTs, startTs, endTs);
      }
      return newTs;
    });
    setIsScrubbing(true);
    exitLiveMode();
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => setIsScrubbing(false), SETTLE_DELAY_MS);
  }, [slotDurationSec, startTs, endTs]);

  const onZoomChange = useCallback((newRangeSec) => {
    const clamped = Math.max(ZOOM_STOPS[0], Math.min(ZOOM_STOPS[ZOOM_STOPS.length - 1], newRangeSec));
    setRangeSec(clamped);
  }, []);

  const onPreviewRequest = useCallback((ts) => {
    // Show the nearest resolved slot's image as preview
    if (!resolvedSlots.length) return;
    const nearest = resolvedSlots.reduce((best, slot) =>
      Math.abs(slot.sourceTimestamp - ts) < Math.abs(best.sourceTimestamp - ts) ? slot : best
    );
    if (nearest?.mediaUrl) {
      setPreviewSrc(nearest.mediaUrl);
    }
  }, [resolvedSlots]);

  const onSlotClick = useCallback((slot) => {
    if (!slot) return;
    exitLiveMode();
    // Set preview to this slot's image
    if (slot.mediaUrl) setPreviewSrc(slot.mediaUrl);
    // Seek cursor to slot center
    setCursorTs(slot.sourceTimestamp);
  }, [socket]);

  const seek = useCallback((ts) => {
    setCursorTs(ts);
  }, []);

  const play = useCallback(() => {
    if (!socket || cursorTs == null) return;
    setPlaying(true);
    socket.emit('playback:request', {
      viewportId: VIEWPORT_ID,
      mode: 'play',
      startTime: cursorTs,
    });
  }, [socket, cursorTs]);

  const pause = useCallback(() => {
    if (!socket) return;
    setPlaying(false);
    socket.emit('playback:stop', { viewportId: VIEWPORT_ID });
  }, [socket]);

  return {
    cursorTs,
    startTs,
    endTs,
    rangeSec,
    timeline,
    density,
    resolvedSlots,
    slotDefs: slots,
    playbackState,
    semanticFreshness,
    playbackUrl,
    preview: previewSrc,
    playing,
    isScrubbing,
    liveMode,
    loading,
    subscribed,
    onSeek,
    onStepSlots,
    onZoomChange,
    onPreviewRequest,
    onSlotClick,
    seek,
    play,
    pause,
  };
}
