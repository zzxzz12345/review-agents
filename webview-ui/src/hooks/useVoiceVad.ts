import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { VoiceMode } from '../../../src/shared/protocol';

interface UseVoiceVadOptions {
  voiceMode: VoiceMode;
  isAssistantSpeaking: boolean;
  micActive: boolean;
  isUserSpeaking: boolean;
  micLevel: number;
  onStartMic: () => void;
  onStopMic: () => void;
  onPttStart: () => void;
  onPttEnd: () => void;
  onBargeIn: () => void;
}

export function useVoiceVad({
  voiceMode,
  isAssistantSpeaking,
  micActive,
  isUserSpeaking,
  micLevel,
  onStartMic,
  onStopMic,
  onPttStart,
  onPttEnd,
  onBargeIn,
}: UseVoiceVadOptions) {
  const voiceModeRef = useRef(voiceMode);
  const speakingRef = useRef(isAssistantSpeaking);
  const micActiveRef = useRef(micActive);
  const onStartMicRef = useRef(onStartMic);
  const onStopMicRef = useRef(onStopMic);
  const onPttStartRef = useRef(onPttStart);
  const onPttEndRef = useRef(onPttEnd);
  const onBargeInRef = useRef(onBargeIn);
  const pttPressedRef = useRef(false);

  voiceModeRef.current = voiceMode;
  speakingRef.current = isAssistantSpeaking;
  micActiveRef.current = micActive;
  onStartMicRef.current = onStartMic;
  onStopMicRef.current = onStopMic;
  onPttStartRef.current = onPttStart;
  onPttEndRef.current = onPttEnd;
  onBargeInRef.current = onBargeIn;

  const toggleMic = useCallback(() => {
    if (micActiveRef.current) {
      pttPressedRef.current = false;
      onStopMicRef.current();
    } else {
      onStartMicRef.current();
    }
  }, []);

  const startPttHold = useCallback(() => {
    if (pttPressedRef.current) {
      return;
    }
    pttPressedRef.current = true;
    if (speakingRef.current) {
      onBargeInRef.current();
    }
    onPttStartRef.current();
  }, []);

  const endPttHold = useCallback(() => {
    if (!pttPressedRef.current) {
      return;
    }
    pttPressedRef.current = false;
    onPttEndRef.current();
  }, []);

  // Option / Alt key hold shortcut for Push-to-Talk
  useEffect(() => {
    const isOptionKey = (e: KeyboardEvent): boolean =>
      e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt';

    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) {
        return false;
      }
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        !isOptionKey(e) ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey
      ) {
        return;
      }
      if (isEditableTarget(e.target)) {
        return;
      }
      if (voiceModeRef.current === 'ptt') {
        e.preventDefault();
        startPttHold();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isOptionKey(e)) {
        return;
      }
      if (pttPressedRef.current || (voiceModeRef.current === 'ptt' && !isEditableTarget(e.target))) {
        e.preventDefault();
        endPttHold();
      }
    };

    const onBlur = () => {
      if (pttPressedRef.current) {
        endPttHold();
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden && pttPressedRef.current) {
        endPttHold();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [endPttHold, startPttHold]);

  return useMemo(
    () => ({
      micActive,
      isUserSpeaking,
      micLevel,
      toggleMic,
      startPttHold,
      endPttHold,
    }),
    [endPttHold, isUserSpeaking, micActive, micLevel, startPttHold, toggleMic]
  );
}
