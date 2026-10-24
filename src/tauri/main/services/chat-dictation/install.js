// @ts-check

import { hostPlatform, isDesktopHost } from '../../../../scripts/util/host-identity.js';
import {
    getSpeechRecognitionAvailability,
    installSpeechRecognitionModel,
    listenForSpeechRecognitionDownloadProgress,
    listenForSpeechRecognitionError,
    listenForSpeechRecognitionResult,
    listenForSpeechRecognitionState,
    listSpeechRecognitionModels,
    requestSpeechRecognitionPermission,
    setSpeechRecognitionModel,
    startSpeechRecognition,
    stopSpeechRecognition,
} from '../../../../tauri-bridge.js';

const MAX_RECORDING_DURATION_MS = 10 * 60 * 1000;

function normalizeError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === 'object' && 'message' in error) {
        return String(error.message);
    }
    return String(error ?? 'Unknown speech recognition error');
}

function appendDraft(textarea, text) {
    const transcript = String(text ?? '').trim();
    if (!transcript) {
        return false;
    }

    const existing = textarea.value;
    const separator = existing && !/\s$/.test(existing) ? ' ' : '';
    textarea.value = `${existing}${separator}${transcript}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

async function prepareDesktopModel(setStatus) {
    const response = await listSpeechRecognitionModels();
    const models = Array.isArray(response?.models) ? response.models : [];
    const usable = models.filter(model => model?.fitsInMemory !== false);
    const active = usable.find(model => model.active && model.installed);
    const installed = active || usable.find(model => model.installed);

    if (installed) {
        if (!installed.active) {
            await setSpeechRecognitionModel(installed.id);
        }
        return true;
    }

    const recommended = usable.find(model => model.recommended) || usable[0];
    if (!recommended) {
        throw new Error('No local speech model is available for this PC.');
    }

    const size = Number.isFinite(recommended.sizeMb) ? `about ${recommended.sizeMb} MB` : 'a speech model';
    const accepted = window.confirm(
        `TauriTavern needs to download ${size} once for private, local speech recognition on this PC. Continue?`,
    );
    if (!accepted) {
        setStatus('The local speech model is not installed yet.');
        return false;
    }

    setStatus('Downloading the local speech model…');
    await installSpeechRecognitionModel(recommended.id);
    await setSpeechRecognitionModel(recommended.id);
    setStatus('Speech model ready. Tap the microphone to record.');
    return false;
}

export function installChatDictation() {
    if (hostPlatform() === 'ohos') {
        return;
    }

    const button = document.getElementById('tt_dictation_button');
    const status = document.getElementById('tt_dictation_status');
    const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
    if (!(button instanceof HTMLElement) || !(status instanceof HTMLElement) || !textarea) {
        throw new Error('Chat dictation controls are missing from the composer');
    }

    /** @type {'idle' | 'starting' | 'listening' | 'processing' | 'downloading'} */
    let state = 'idle';
    /** @type {string[]} */
    let transcriptSegments = [];
    let isInstallingModel = false;
    let lastTranscriptSegment = '';
    let lastTranscriptAt = 0;

    const setStatus = (message) => {
        status.textContent = message;
    };
    const updateButton = () => {
        const recording = state === 'listening';
        const busy = state === 'starting' || state === 'processing' || state === 'downloading';
        button.classList.toggle('is-recording', recording);
        button.classList.toggle('fa-microphone', !recording);
        button.classList.toggle('fa-stop', recording);
        button.setAttribute('aria-label', recording ? 'Stop and transcribe' : 'Start dictation');
        button.setAttribute('title', recording ? 'Stop and transcribe' : 'Start dictation');
        button.setAttribute('aria-pressed', String(recording));
        button.setAttribute('aria-disabled', String(busy));
        button.setAttribute('aria-busy', String(busy));
    };

    void listenForSpeechRecognitionResult((result) => {
        if (!result?.isFinal) {
            return;
        }
        const segment = String(result.transcript ?? '').trim();
        if (!segment) {
            return;
        }
        const now = Date.now();
        if (segment === lastTranscriptSegment && now - lastTranscriptAt < 200) {
            return;
        }
        lastTranscriptSegment = segment;
        lastTranscriptAt = now;
        transcriptSegments.push(segment);
    }).catch((error) => console.error('TauriTavern: Failed to listen for speech results:', error));

    let stopRequested = false;
    let stopFallbackTimer = 0;

    // Move collected segments into the composer and return to idle.
    const finishSession = (message) => {
        window.clearTimeout(stopFallbackTimer);
        stopFallbackTimer = 0;
        stopRequested = false;
        const transcript = transcriptSegments.join(' ').trim();
        transcriptSegments = [];
        state = 'idle';
        if (transcript) {
            appendDraft(textarea, transcript);
            setStatus('Transcript added to your draft. Review it, then tap Send.');
        } else if (message) {
            setStatus(message);
        } else if (!isInstallingModel) {
            setStatus('Ready.');
        }
        updateButton();
    };

    void listenForSpeechRecognitionState((event) => {
        const nextState = String(event?.state ?? '');
        if (nextState === 'listening') {
            if (stopRequested) {
                return;
            }
            state = 'listening';
            setStatus('Recording… Tap the microphone again to stop and transcribe.');
        } else if (nextState === 'processing') {
            // Android reports "processing" at the start and end of each spoken
            // phrase while still recording; only show it once the user stops.
            if (!stopRequested) {
                return;
            }
            state = 'processing';
            setStatus('Transcribing…');
        } else if (nextState === 'idle') {
            if (state !== 'listening' && state !== 'processing') {
                return;
            }
            finishSession();
            return;
        }
        updateButton();
    }).catch((error) => console.error('TauriTavern: Failed to listen for speech state:', error));

    void listenForSpeechRecognitionError((error) => {
        if (state !== 'listening' && state !== 'processing') {
            return;
        }
        // Keep anything already transcribed; only surface the error if nothing was captured.
        finishSession(normalizeError(error));
    }).catch((error) => console.error('TauriTavern: Failed to listen for speech errors:', error));

    void listenForSpeechRecognitionDownloadProgress((progress) => {
        if (progress?.status === 'downloading') {
            const percentage = Number(progress.progress);
            setStatus(Number.isFinite(percentage)
                ? `Downloading speech model… ${Math.round(percentage)}%`
                : 'Downloading the local speech model…');
        }
    }).catch(() => {
        // Progress events are optional; the model installation result is authoritative.
    });

    const start = async () => {
        stopRequested = false;
        state = 'starting';
        transcriptSegments = [];
        setStatus('Checking microphone permission…');
        updateButton();

        try {
            const permission = await requestSpeechRecognitionPermission();
            if (permission?.microphone === 'denied') {
                throw new Error('Microphone permission is denied. Allow microphone access for TauriTavern in your device settings.');
            }
            if (permission?.speechRecognition === 'denied') {
                throw new Error('Speech recognition permission is denied. Allow it for TauriTavern in your device settings.');
            }

            if (isDesktopHost()) {
                isInstallingModel = true;
                state = 'downloading';
                updateButton();
                const ready = await prepareDesktopModel(setStatus);
                isInstallingModel = false;
                if (!ready) {
                    state = 'idle';
                    updateButton();
                    return;
                }
            }

            const availability = await getSpeechRecognitionAvailability();
            if (!availability?.available) {
                throw new Error(availability?.reason || 'Speech recognition is unavailable on this device.');
            }

            setStatus('Starting microphone…');
            await startSpeechRecognition({
                language: 'en-US',
                maxDuration: MAX_RECORDING_DURATION_MS,
                interimResults: false,
                continuous: true,
            });
            // The native state event switches the UI to recording.
            state = 'listening';
            setStatus('Recording… Tap the microphone again to stop and transcribe.');
        } catch (error) {
            isInstallingModel = false;
            state = 'idle';
            setStatus(normalizeError(error));
        } finally {
            updateButton();
        }
    };

    const stop = async () => {
        stopRequested = true;
        state = 'processing';
        setStatus('Stopping and transcribing…');
        updateButton();
        // Never leave the button stuck if the engine does not report back.
        window.clearTimeout(stopFallbackTimer);
        stopFallbackTimer = window.setTimeout(() => {
            if (state === 'processing') {
                finishSession('No speech was recognized. Try again.');
            }
        }, 8000);
        try {
            await stopSpeechRecognition();
        } catch (error) {
            finishSession(normalizeError(error));
        }
    };

    const toggle = () => {
        if (state === 'starting' || state === 'processing' || state === 'downloading') {
            return;
        }
        if (state === 'listening') {
            void stop();
        } else {
            void start();
        }
    };

    button.addEventListener('click', toggle);
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
    updateButton();
}
