import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type {
  AudioSegmentPayload,
  UtteranceSegment,
  WebviewPlaybackCutoff,
} from '../../../src/shared/protocol';

export type PlaybackEventKind =
  | 'audio_blocked'
  | 'audio_unlocked'
  | 'html_audio_fallback'
  | 'decode_error'
  | 'speech_synth_timeout';

interface UseAudioSyncQueueOptions {
  onSegmentStarted: (segment: UtteranceSegment) => void;
  onSegmentEnded: (segment: UtteranceSegment) => void;
  onQueueEmpty: (turnId: number) => void;
  onPlaybackEvent?: (kind: PlaybackEventKind, detail?: string) => void;
  onPauseStateChange?: (paused: boolean) => void;
}

interface ActivePlaybackState {
  segment: UtteranceSegment;
  startedAtMs: number;
  accumulatedMs: number;
  durationMs: number;
  stopFn: () => void;
  pauseFn: () => void;
  resumeFn: () => void;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAudioContextInstance(): AudioContext | null {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return Ctx ? new Ctx() : null;
}

async function tryResumeAudioContext(
  ctx: AudioContext,
  timeoutMs = 250
): Promise<boolean> {
  if (ctx.state === 'running') {
    return true;
  }
  await Promise.race([
    ctx.resume().catch(() => undefined),
    sleepMs(timeoutMs),
  ]);
  return (ctx.state as AudioContextState) === 'running';
}

export function useAudioSyncQueue({
  onSegmentStarted,
  onSegmentEnded,
  onQueueEmpty,
  onPlaybackEvent,
  onPauseStateChange,
}: UseAudioSyncQueueOptions) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const onStartedRef = useRef(onSegmentStarted);
  const onEndedRef = useRef(onSegmentEnded);
  const onEmptyRef = useRef(onQueueEmpty);
  const onEventRef = useRef(onPlaybackEvent);
  const onPauseChangeRef = useRef(onPauseStateChange);
  onStartedRef.current = onSegmentStarted;
  onEndedRef.current = onSegmentEnded;
  onEmptyRef.current = onQueueEmpty;
  onEventRef.current = onPlaybackEvent;
  onPauseChangeRef.current = onPauseStateChange;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<AudioSegmentPayload[]>([]);
  const activeRef = useRef<ActivePlaybackState | null>(null);
  const preStartCancelRef = useRef<(() => void) | null>(null);
  const isPlayingLoopRef = useRef(false);
  const isPausedRef = useRef(false);
  const resumeResolversRef = useRef<Array<() => void>>([]);
  const minAcceptedTurnIdRef = useRef(0);
  const currentTurnIdRef = useRef(0);
  const audioBlockedRef = useRef(false);
  const speechSynthBrokenRef = useRef(false);
  const htmlFallbackLoggedRef = useRef(false);

  const releasePauseWaiters = useCallback(() => {
    const waiters = resumeResolversRef.current.splice(
      0,
      resumeResolversRef.current.length
    );
    for (const resolve of waiters) {
      resolve();
    }
  }, []);

  const waitUntilResumed = useCallback((): Promise<void> => {
    if (!isPausedRef.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      resumeResolversRef.current.push(resolve);
    });
  }, []);

  const setBlockedState = useCallback((blocked: boolean) => {
    const prev = audioBlockedRef.current;
    audioBlockedRef.current = blocked;
    setAudioBlocked(blocked);
    if (prev && !blocked) {
      onEventRef.current?.('audio_unlocked');
    }
  }, []);

  const getOrCreateAudioContext = useCallback((): AudioContext | null => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = createAudioContextInstance();
    }
    return audioCtxRef.current;
  }, []);

  const unlockAudio = useCallback(async () => {
    const ctx = getOrCreateAudioContext();
    if (!ctx) {
      return;
    }
    const running = await tryResumeAudioContext(ctx, 400);
    if (running) {
      setBlockedState(false);
    }
  }, [getOrCreateAudioContext, setBlockedState]);

  // Automatically resume AudioContext on the user's first click/keypress anywhere in the Webview,
  // unless playback is intentionally paused so UI browsing while paused stays silent.
  useEffect(() => {
    const handleUserGesture = () => {
      if (isPausedRef.current) {
        return;
      }
      const ctx = audioCtxRef.current ?? getOrCreateAudioContext();
      if (!ctx || ctx.state === 'running') {
        if (audioBlockedRef.current && ctx?.state === 'running') {
          setBlockedState(false);
        }
        return;
      }
      void ctx
        .resume()
        .then(() => {
          if (ctx.state === 'running') {
            setBlockedState(false);
          }
        })
        .catch(() => undefined);
    };

    window.addEventListener('pointerdown', handleUserGesture, {
      capture: true,
      passive: true,
    });
    window.addEventListener('keydown', handleUserGesture, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('pointerdown', handleUserGesture, { capture: true });
      window.removeEventListener('keydown', handleUserGesture, { capture: true });
    };
  }, [getOrCreateAudioContext, setBlockedState]);

  const playNext = useCallback(async () => {
    if (isPlayingLoopRef.current) {
      return;
    }
    isPlayingLoopRef.current = true;
    setIsSpeaking(true);

    try {
      while (queueRef.current.length > 0) {
        if (isPausedRef.current) {
          await waitUntilResumed();
          if (queueRef.current.length === 0) {
            break;
          }
        }

        const nextItem = queueRef.current.shift()!;
        const { segment } = nextItem;
        if (segment.turnId < minAcceptedTurnIdRef.current) {
          continue;
        }
        currentTurnIdRef.current = segment.turnId;

        await playSinglePayload({
          payload: nextItem,
          getOrCreateCtx: getOrCreateAudioContext,
          onAudioBlocked: (blocked, reason) => {
            const wasBlocked = audioBlockedRef.current;
            setBlockedState(blocked);
            if (blocked && !wasBlocked) {
              onEventRef.current?.('audio_blocked', reason);
            }
          },
          onPlaybackEvent: (kind, detail) => {
            onEventRef.current?.(kind, detail);
          },
          onStart: (state) => {
            preStartCancelRef.current = null;
            activeRef.current = state;
            onStartedRef.current(segment);
          },
          registerPreStartCancel: (fn) => {
            preStartCancelRef.current = fn;
          },
          isCancelled: () => minAcceptedTurnIdRef.current > segment.turnId,
          waitIfPaused: async () => {
            if (isPausedRef.current) {
              await waitUntilResumed();
            }
          },
          speechSynthBrokenRef,
          htmlFallbackLoggedRef,
        });

        preStartCancelRef.current = null;
        activeRef.current = null;
        if (segment.turnId >= minAcceptedTurnIdRef.current) {
          onEndedRef.current(segment);
        }
      }
    } finally {
      preStartCancelRef.current = null;
      activeRef.current = null;
      isPlayingLoopRef.current = false;
      setIsSpeaking(false);
      onEmptyRef.current(currentTurnIdRef.current);
    }
  }, [getOrCreateAudioContext, setBlockedState, waitUntilResumed]);

  const enqueue = useCallback(
    (payload: AudioSegmentPayload) => {
      if (payload.segment.turnId < minAcceptedTurnIdRef.current) {
        return;
      }
      queueRef.current.push(payload);
      void playNext();
    },
    [playNext]
  );

  const pausePlayback = useCallback(() => {
    if (isPausedRef.current) {
      return;
    }
    if (!isPlayingLoopRef.current && queueRef.current.length === 0 && !activeRef.current) {
      return;
    }
    isPausedRef.current = true;
    setIsPaused(true);
    activeRef.current?.pauseFn();
    onPauseChangeRef.current?.(true);
  }, []);

  const resumePlayback = useCallback(() => {
    if (!isPausedRef.current) {
      return;
    }
    isPausedRef.current = false;
    setIsPaused(false);
    activeRef.current?.resumeFn();
    releasePauseWaiters();
    if (queueRef.current.length > 0 && !isPlayingLoopRef.current) {
      void playNext();
    }
    onPauseChangeRef.current?.(false);
  }, [playNext, releasePauseWaiters]);

  const setPaused = useCallback(
    (paused: boolean) => {
      if (paused) {
        pausePlayback();
      } else {
        resumePlayback();
      }
    },
    [pausePlayback, resumePlayback]
  );

  const togglePause = useCallback(() => {
    if (isPausedRef.current) {
      resumePlayback();
    } else {
      pausePlayback();
    }
  }, [pausePlayback, resumePlayback]);

  const interruptAndFlush = useCallback(
    (nextMinTurnId?: number): WebviewPlaybackCutoff => {
      const active = activeRef.current;
      const wasPaused = isPausedRef.current;
      let cutoff: WebviewPlaybackCutoff = {
        turnId: currentTurnIdRef.current,
        spokenCharOffset: 0,
      };

      if (active) {
        const elapsedMs =
          active.accumulatedMs +
          (wasPaused ? 0 : Math.max(0, performance.now() - active.startedAtMs));
        const ratio =
          active.durationMs > 0 ? Math.min(1, elapsedMs / active.durationMs) : 1;
        cutoff = {
          turnId: active.segment.turnId,
          segmentId: active.segment.segmentId,
          spokenCharOffset: Math.round(active.segment.spokenText.length * ratio),
        };
        active.stopFn();
        activeRef.current = null;
      }

      if (preStartCancelRef.current) {
        preStartCancelRef.current();
        preStartCancelRef.current = null;
      }

      isPausedRef.current = false;
      setIsPaused(false);
      releasePauseWaiters();

      minAcceptedTurnIdRef.current =
        nextMinTurnId ?? Math.max(minAcceptedTurnIdRef.current, cutoff.turnId + 1);
      queueRef.current = [];

      if (wasPaused && audioCtxRef.current?.state === 'suspended') {
        void audioCtxRef.current.resume().catch(() => undefined);
      }

      try {
        window.speechSynthesis?.cancel();
      } catch {
        // ignore
      }
      setIsSpeaking(false);
      return cutoff;
    },
    [releasePauseWaiters]
  );

  useEffect(() => {
    return () => {
      releasePauseWaiters();
      preStartCancelRef.current?.();
      activeRef.current?.stopFn();
      try {
        void audioCtxRef.current?.close();
      } catch {
        // ignore
      }
    };
  }, [releasePauseWaiters]);

  return useMemo(
    () => ({
      isSpeaking,
      isPaused,
      audioBlocked,
      unlockAudio,
      pausePlayback,
      resumePlayback,
      togglePause,
      setPaused,
      enqueue,
      interruptAndFlush,
    }),
    [
      audioBlocked,
      enqueue,
      interruptAndFlush,
      isPaused,
      isSpeaking,
      pausePlayback,
      resumePlayback,
      setPaused,
      togglePause,
      unlockAudio,
    ]
  );
}

interface PlaySinglePayloadParams {
  payload: AudioSegmentPayload;
  getOrCreateCtx: () => AudioContext | null;
  onAudioBlocked: (blocked: boolean, reason?: string) => void;
  onPlaybackEvent: (kind: PlaybackEventKind, detail?: string) => void;
  onStart: (state: ActivePlaybackState) => void;
  registerPreStartCancel: (fn: () => void) => void;
  isCancelled: () => boolean;
  waitIfPaused: () => Promise<void>;
  speechSynthBrokenRef: MutableRefObject<boolean>;
  htmlFallbackLoggedRef: MutableRefObject<boolean>;
}

async function playSinglePayload({
  payload,
  getOrCreateCtx,
  onAudioBlocked,
  onPlaybackEvent,
  onStart,
  registerPreStartCancel,
  isCancelled,
  waitIfPaused,
  speechSynthBrokenRef,
  htmlFallbackLoggedRef,
}: PlaySinglePayloadParams): Promise<void> {
  const { segment, audioBase64, mimeType, fallbackTextOnly, ttsRate, muted } = payload;

  await waitIfPaused();
  if (isCancelled()) {
    return;
  }

  // Silent directive-only segment
  if (!segment.spokenText.trim()) {
    onStart({
      segment,
      startedAtMs: performance.now(),
      accumulatedMs: 0,
      durationMs: 1,
      stopFn: () => undefined,
      pauseFn: () => undefined,
      resumeFn: () => undefined,
    });
    return;
  }

  // Path A: Synthesized audio buffer available
  if (!muted && !fallbackTextOnly && audioBase64) {
    let preCancelled = false;
    registerPreStartCancel(() => {
      preCancelled = true;
    });

    const ctx = getOrCreateCtx();
    if (ctx) {
      const running = await tryResumeAudioContext(ctx, 250);
      await waitIfPaused();
      if (preCancelled || isCancelled()) {
        return;
      }

      if (running) {
        try {
          const rawBytes = base64ToUint8Array(audioBase64);
          const audioBuffer = await decodeAudioWithTimeout(
            ctx,
            rawBytes.buffer as ArrayBuffer,
            3000
          );
          await waitIfPaused();
          if (preCancelled || isCancelled()) {
            return;
          }

          onAudioBlocked(false);
          await playDecodedAudioBuffer(ctx, audioBuffer, segment, onStart);
          return;
        } catch (err) {
          onPlaybackEvent(
            'decode_error',
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }

    await waitIfPaused();
    if (preCancelled || isCancelled()) {
      return;
    }

    // Fallback inside Path A: HTMLAudioElement Blob playback
    const htmlRes = await playViaHtmlAudioElement({
      audioBase64,
      mimeType,
      ttsRate,
      segment,
      onStart: (state) => {
        if (!htmlFallbackLoggedRef.current) {
          htmlFallbackLoggedRef.current = true;
          onPlaybackEvent('html_audio_fallback');
        }
        onAudioBlocked(false);
        onStart(state);
      },
      registerPreStartCancel,
      isCancelled: () => preCancelled || isCancelled(),
    });

    if (htmlRes.started || isCancelled()) {
      return;
    }

    // Both AudioContext and HTMLAudioElement blocked -> timed silent subtitle cadence
    onAudioBlocked(true, htmlRes.error ?? 'AudioContext suspended waiting for user gesture');
    await playSilentReadingCadence(segment, ttsRate, onStart);
    return;
  }

  // Path B: Text-only speechSynthesis fallback when Edge/native TTS produced no audio buffer
  if (
    !muted &&
    !speechSynthBrokenRef.current &&
    typeof window !== 'undefined' &&
    'speechSynthesis' in window
  ) {
    const synthStarted = await playViaSpeechSynthesisWithTimeout(
      segment,
      ttsRate,
      registerPreStartCancel,
      onStart,
      isCancelled
    );
    if (synthStarted || isCancelled()) {
      return;
    }
    speechSynthBrokenRef.current = true;
    onPlaybackEvent('speech_synth_timeout', 'window.speechSynthesis did not start within 900ms');
  }

  // Path C: Timed silent reading cadence for muted mode or unavailable audio
  await waitIfPaused();
  if (!isCancelled()) {
    await playSilentReadingCadence(segment, ttsRate, onStart);
  }
}

async function decodeAudioWithTimeout(
  ctx: AudioContext,
  arrayBuffer: ArrayBuffer,
  timeoutMs = 3000
): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`decodeAudioData timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ctx
      .decodeAudioData(arrayBuffer)
      .then((buf) => {
        clearTimeout(timer);
        resolve(buf);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

async function playDecodedAudioBuffer(
  ctx: AudioContext,
  audioBuffer: AudioBuffer,
  segment: UtteranceSegment,
  onStart: (state: ActivePlaybackState) => void
): Promise<void> {
  await new Promise<void>((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    let finished = false;
    let paused = false;
    const durationMs = audioBuffer.duration * 1000;
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = undefined;
      }
      try {
        source.disconnect();
        source.buffer = null;
      } catch {
        // ignore
      }
      resolve();
    };

    const armSafety = (ms: number) => {
      if (safetyTimer) {
        clearTimeout(safetyTimer);
      }
      safetyTimer = setTimeout(cleanup, Math.max(3000, Math.round(ms) + 3000));
    };

    const activeState: ActivePlaybackState = {
      segment,
      startedAtMs: performance.now(),
      accumulatedMs: 0,
      durationMs,
      stopFn: () => {
        try {
          source.stop();
        } catch {
          // ignore
        }
        cleanup();
      },
      pauseFn: () => {
        if (finished || paused) {
          return;
        }
        paused = true;
        activeState.accumulatedMs += Math.max(
          0,
          performance.now() - activeState.startedAtMs
        );
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = undefined;
        }
        void ctx.suspend().catch(() => undefined);
      },
      resumeFn: () => {
        if (finished || !paused) {
          return;
        }
        paused = false;
        activeState.startedAtMs = performance.now();
        armSafety(Math.max(1000, durationMs - activeState.accumulatedMs));
        void ctx.resume().catch(() => undefined);
      },
    };

    armSafety(Math.max(4000, durationMs));
    source.onended = cleanup;
    onStart(activeState);
    source.start(0);
  });
}

async function playViaHtmlAudioElement(params: {
  audioBase64: string;
  mimeType: string;
  ttsRate: number;
  segment: UtteranceSegment;
  onStart: (state: ActivePlaybackState) => void;
  registerPreStartCancel: (fn: () => void) => void;
  isCancelled: () => boolean;
}): Promise<{ started: boolean; error?: string }> {
  const {
    audioBase64,
    mimeType,
    ttsRate,
    segment,
    onStart,
    registerPreStartCancel,
    isCancelled,
  } = params;

  let blobUrl: string | undefined;
  let audio: HTMLAudioElement | undefined;

  try {
    const bytes = base64ToUint8Array(audioBase64);
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
      type: mimeType || 'audio/mpeg',
    });
    blobUrl = URL.createObjectURL(blob);
    audio = new Audio(blobUrl);
    audio.playbackRate = Math.max(0.6, Math.min(2.0, ttsRate || 1.0));
  } catch (err) {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
    return { started: false, error: err instanceof Error ? err.message : String(err) };
  }

  let cancelledBeforeStart = false;
  registerPreStartCancel(() => {
    cancelledBeforeStart = true;
    try {
      audio?.pause();
      if (audio) {
        audio.src = '';
      }
    } catch {
      // ignore
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
    }
  });

  if (isCancelled() || cancelledBeforeStart) {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
    }
    return { started: false, error: 'Cancelled' };
  }

  try {
    const playOutcome = await Promise.race([
      audio.play().then(() => ({ ok: true as const })),
      sleepMs(1200).then(() => ({
        ok: false as const,
        reason: 'HTMLAudioElement.play() timed out',
      })),
    ]);

    if (!playOutcome.ok) {
      try {
        audio.pause();
        audio.src = '';
      } catch {
        // ignore
      }
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = undefined;
      }
      return { started: false, error: playOutcome.reason };
    }
  } catch (err) {
    try {
      audio.pause();
      audio.src = '';
    } catch {
      // ignore
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
    }
    return { started: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (isCancelled() || cancelledBeforeStart) {
    try {
      audio.pause();
      audio.src = '';
    } catch {
      // ignore
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
    }
    return { started: false, error: 'Cancelled' };
  }

  const estDurationMs =
    Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration * 1000
      : estimateSilentDurationMs(segment.spokenText, ttsRate);

  await new Promise<void>((resolve) => {
    let finished = false;
    let paused = false;
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = undefined;
      }
      try {
        audio?.pause();
        if (audio) {
          audio.onended = null;
          audio.onerror = null;
          audio.src = '';
        }
      } catch {
        // ignore
      }
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = undefined;
      }
      resolve();
    };

    const armSafety = (ms: number) => {
      if (safetyTimer) {
        clearTimeout(safetyTimer);
      }
      safetyTimer = setTimeout(cleanup, Math.max(8000, Math.round(ms) + 4000));
    };

    const activeState: ActivePlaybackState = {
      segment,
      startedAtMs: performance.now(),
      accumulatedMs: 0,
      durationMs: estDurationMs,
      stopFn: cleanup,
      pauseFn: () => {
        if (finished || paused) {
          return;
        }
        paused = true;
        activeState.accumulatedMs += Math.max(
          0,
          performance.now() - activeState.startedAtMs
        );
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = undefined;
        }
        try {
          audio?.pause();
        } catch {
          // ignore
        }
      },
      resumeFn: () => {
        if (finished || !paused) {
          return;
        }
        paused = false;
        activeState.startedAtMs = performance.now();
        armSafety(Math.max(1000, estDurationMs - activeState.accumulatedMs));
        void audio?.play().catch(() => undefined);
      },
    };

    armSafety(estDurationMs);
    audio!.onended = cleanup;
    audio!.onerror = cleanup;
    onStart(activeState);
  });

  return { started: true };
}

async function playViaSpeechSynthesisWithTimeout(
  segment: UtteranceSegment,
  ttsRate: number,
  registerPreStartCancel: (fn: () => void) => void,
  onStart: (state: ActivePlaybackState) => void,
  isCancelled: () => boolean
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const utter = new SpeechSynthesisUtterance(segment.spokenText);
    utter.lang = 'zh-CN';
    utter.rate = Math.max(0.6, Math.min(2.0, ttsRate || 1.0));

    let started = false;
    let finished = false;
    let paused = false;
    let startWatchdog: ReturnType<typeof setTimeout> | undefined;
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    const estDurationMs = Math.max(1000, segment.spokenText.length * 160);

    const finish = (didStart: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      if (startWatchdog) {
        clearTimeout(startWatchdog);
      }
      if (safetyTimer) {
        clearTimeout(safetyTimer);
      }
      resolve(didStart);
    };

    const armSafety = (ms: number) => {
      if (safetyTimer) {
        clearTimeout(safetyTimer);
      }
      safetyTimer = setTimeout(() => {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
        finish(started);
      }, Math.max(4000, Math.round(ms)));
    };

    registerPreStartCancel(() => {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
      finish(started);
    });

    if (isCancelled()) {
      finish(false);
      return;
    }

    startWatchdog = setTimeout(() => {
      if (!started && !finished) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
        finish(false);
      }
    }, 900);

    armSafety(segment.spokenText.length * 260);

    utter.onstart = () => {
      if (finished) {
        return;
      }
      started = true;
      if (startWatchdog) {
        clearTimeout(startWatchdog);
      }
      const activeState: ActivePlaybackState = {
        segment,
        startedAtMs: performance.now(),
        accumulatedMs: 0,
        durationMs: estDurationMs,
        stopFn: () => {
          try {
            window.speechSynthesis.cancel();
          } catch {
            // ignore
          }
          finish(true);
        },
        pauseFn: () => {
          if (finished || paused) {
            return;
          }
          paused = true;
          activeState.accumulatedMs += Math.max(
            0,
            performance.now() - activeState.startedAtMs
          );
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = undefined;
          }
          try {
            window.speechSynthesis.pause();
          } catch {
            // ignore
          }
        },
        resumeFn: () => {
          if (finished || !paused) {
            return;
          }
          paused = false;
          activeState.startedAtMs = performance.now();
          armSafety(Math.max(3000, estDurationMs * 1.6 - activeState.accumulatedMs));
          try {
            window.speechSynthesis.resume();
          } catch {
            // ignore
          }
        },
      };
      onStart(activeState);
    };

    utter.onend = () => finish(started);
    utter.onerror = () => finish(started);

    try {
      window.speechSynthesis.speak(utter);
    } catch {
      finish(false);
    }
  });
}

function estimateSilentDurationMs(spokenText: string, ttsRate: number): number {
  return Math.max(
    1200,
    Math.min(
      6000,
      Math.round((spokenText.length * 140) / Math.max(0.5, ttsRate || 1))
    )
  );
}

async function playSilentReadingCadence(
  segment: UtteranceSegment,
  ttsRate: number,
  onStart: (state: ActivePlaybackState) => void
): Promise<void> {
  const readDurationMs = estimateSilentDurationMs(segment.spokenText, ttsRate);

  await new Promise<void>((resolve) => {
    let finished = false;
    let paused = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (!finished) {
        finished = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve();
      }
    };

    const armTimer = (ms: number) => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(finish, Math.max(200, ms));
    };

    const activeState: ActivePlaybackState = {
      segment,
      startedAtMs: performance.now(),
      accumulatedMs: 0,
      durationMs: readDurationMs,
      stopFn: finish,
      pauseFn: () => {
        if (finished || paused) {
          return;
        }
        paused = true;
        activeState.accumulatedMs += Math.max(
          0,
          performance.now() - activeState.startedAtMs
        );
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
      resumeFn: () => {
        if (finished || !paused) {
          return;
        }
        paused = false;
        activeState.startedAtMs = performance.now();
        armTimer(Math.max(200, readDurationMs - activeState.accumulatedMs));
      },
    };

    armTimer(readDurationMs);
    onStart(activeState);
  });
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binaryStr = atob(b64);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}
