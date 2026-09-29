/** @file Owns microphone permission, recorder lifecycle, and audio file handoff. */
import { ref, type Ref, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import type { RecordingPhase } from '../components/editor/editorToolbarContext';

/** Owns microphone permission, MediaRecorder lifecycle, and audio file handoff. */
export function useAudioRecording(
  editor: ShallowRef<Editor | undefined>,
  uiMessage: Ref<string>,
  handleAudioFile: (file: File) => Promise<void>,
) {
  const recordingPhase = ref<RecordingPhase>('idle');
  const audioStream = ref<MediaStream | null>(null);
  let audioRecorder: MediaRecorder | undefined;
  let audioChunks: Blob[] = [];

  function stopAudioStream() {
    audioStream.value?.getTracks().forEach((track) => track.stop());
    audioStream.value = null;
  }

  function stopRecording() {
    if (recordingPhase.value === 'recording') audioRecorder?.stop();
  }

  function toggleAudioRecording() {
    if (recordingPhase.value === 'recording') {
      audioRecorder?.stop();
    } else if (recordingPhase.value === 'idle') {
      void startAudioRecording();
    }
  }

  async function startAudioRecording() {
    if (!editor.value || recordingPhase.value !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      uiMessage.value = 'Audio recording is not available in this browser.';
      return;
    }

    recordingPhase.value = 'requesting_permission';
    try {
      const permState = await navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((permission) => permission.state)
        .catch(() => 'prompt' as PermissionState);

      if (permState === 'denied') {
        uiMessage.value =
          'Microphone access is blocked. Open Chrome settings → Privacy → Site settings → Microphone and allow this extension.';
        recordingPhase.value = 'idle';
        return;
      }

      audioStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      const mimeType = preferredAudioRecordingMimeType();
      audioRecorder = new MediaRecorder(audioStream.value, mimeType ? { mimeType } : undefined);
      audioRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) audioChunks.push(event.data);
      });
      audioRecorder.addEventListener('stop', () => {
        recordingPhase.value = 'processing';
        const recorderMimeType = audioRecorder?.mimeType || mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunks, { type: recorderMimeType });
        const extension = audioExtensionFromMimeType(recorderMimeType);
        const now = new Date();
        const date = now.toLocaleDateString('en-CA');
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const filename = `Recording ${date} ${hh}.${mm}.${extension}`;
        const file = new File([audioBlob], filename, { type: recorderMimeType });
        audioRecorder = undefined;
        audioChunks = [];
        stopAudioStream();
        void handleAudioFile(file).finally(() => {
          recordingPhase.value = 'idle';
        });
      });

      audioRecorder.start();
      recordingPhase.value = 'recording';
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError') {
        uiMessage.value =
          'Microphone access was denied or dismissed. Look for the permission prompt in the Chrome toolbar and click Allow, then try again.';
      } else {
        uiMessage.value =
          error instanceof Error ? error.message : 'Unable to start audio recording.';
      }
      stopAudioStream();
      recordingPhase.value = 'idle';
    }
  }

  return {
    recordingPhase,
    audioStream,
    stopAudioStream,
    stopRecording,
    toggleAudioRecording,
  };
}

function preferredAudioRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return (
    [
      'audio/mpeg',
      'audio/mp3',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
  );
}

function audioExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mp4') || normalized.includes('aac')) return 'm4a';
  return 'webm';
}
