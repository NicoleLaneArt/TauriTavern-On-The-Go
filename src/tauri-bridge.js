// Core Tauri bridge for frontend modules.

import { invokeOnPc, remoteBrainSession, runsOnPc } from './tauri/remote-brain/router.js';

function getTauri() {
    if (typeof window === 'undefined') {
        return null;
    }

    return window.__TAURI__ || null;
}

function isPlainObject(value) {
    if (Object.prototype.toString.call(value) !== '[object Object]') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
}

function withTauriArgumentAliases(args) {
    if (!isPlainObject(args)) {
        return args;
    }

    const aliased = { ...args };
    for (const [key, value] of Object.entries(args)) {
        if (!key.includes('_')) {
            continue;
        }

        const camelCaseKey = key.replace(/_+([a-zA-Z0-9])/g, (_, char) => char.toUpperCase());
        if (!Object.prototype.hasOwnProperty.call(aliased, camelCaseKey)) {
            aliased[camelCaseKey] = value;
        }
    }

    return aliased;
}

export const invoke = (...args) => {
    const fn = getTauri()?.core?.invoke;
    if (typeof fn !== 'function') {
        throw new Error('Tauri invoke is unavailable');
    }

    if (isPlainObject(args[1])) {
        args[1] = withTauriArgumentAliases(args[1]);
    }

    if (remoteBrainSession()?.client && runsOnPc(String(args[0]))) {
        return invokeOnPc(fn, args[0], args[1], args[2]);
    }

    return fn(...args);
};

function getHostSafeInvoke() {
    if (typeof window === 'undefined') {
        return null;
    }

    const fn = window.__TAURITAVERN__?.invoke?.safeInvoke;
    return typeof fn === 'function' ? fn : null;
}

async function invokeWithHostNormalization(command, args) {
    const safeInvoke = getHostSafeInvoke();
    if (safeInvoke) {
        return safeInvoke(command, args);
    }

    return args === undefined ? invoke(command) : invoke(command, args);
}

export const listen = (...args) => {
    const fn = getTauri()?.event?.listen;
    if (typeof fn !== 'function') {
        throw new Error('Tauri listen is unavailable');
    }
    return fn(...args);
};

export function createChannel(onmessage) {
    const Channel = getTauri()?.core?.Channel;
    if (typeof Channel !== 'function') {
        throw new Error('Tauri Channel is unavailable');
    }

    return new Channel(onmessage);
}

export function getCurrentWindow() {
    const getCurrentWindow = getTauri()?.window?.getCurrentWindow;
    if (typeof getCurrentWindow !== 'function') {
        throw new Error('Tauri window API is unavailable');
    }
    return getCurrentWindow();
}

// Optional plugin: absence is a valid state, not an error.
export function getBarcodeScanner() {
    return getTauri()?.barcodeScanner;
}

export function startSpeechRecognition(config) {
    return invoke('plugin:stt|start_listening', { config });
}

export function stopSpeechRecognition() {
    return invoke('plugin:stt|stop_listening');
}

export function requestSpeechRecognitionPermission() {
    return invoke('plugin:stt|request_permission');
}

export function getSpeechRecognitionAvailability() {
    return invoke('plugin:stt|is_available');
}

export function listSpeechRecognitionModels() {
    return invoke('plugin:stt|list_models');
}

export function installSpeechRecognitionModel(id) {
    return invoke('plugin:stt|install_model', { id });
}

export function setSpeechRecognitionModel(id) {
    return invoke('plugin:stt|set_active_model', { id });
}

// Mobile plugins deliver events through plugin channels (Kotlin `trigger`),
// not the global event bus the desktop backend emits on.
async function addSpeechPluginListener(event, handler) {
    const tauri = getTauri();
    const addPluginListener = tauri?.core?.addPluginListener;
    if (typeof addPluginListener === 'function') {
        const listener = await addPluginListener('stt', event, handler);
        return () => void listener?.unregister?.();
    }

    const handlerChannel = createChannel(handler);
    await invoke('plugin:stt|registerListener', { event, handler: handlerChannel });
    return () => void invoke('plugin:stt|remove_listener', { event, channelId: handlerChannel.id }).catch(() => {});
}

async function listenForSpeechRecognitionEvent(name, legacyName, pluginEvent, handler) {
    const unlisten = await Promise.all([
        listen(name, (event) => handler(event.payload)),
        listen(legacyName, (event) => handler(event.payload)),
        addSpeechPluginListener(pluginEvent, handler).catch(() => () => {}),
    ]);
    return () => unlisten.forEach(stopListening => stopListening());
}

export function listenForSpeechRecognitionResult(handler) {
    return listenForSpeechRecognitionEvent('plugin:stt:result', 'stt://result', 'result', handler);
}

export function listenForSpeechRecognitionState(handler) {
    return listenForSpeechRecognitionEvent('plugin:stt:stateChange', 'stt://stateChange', 'stateChange', handler);
}

export function listenForSpeechRecognitionError(handler) {
    return listenForSpeechRecognitionEvent('plugin:stt:error', 'stt://error', 'error', handler);
}

export function listenForSpeechRecognitionDownloadProgress(handler) {
    return listen('stt://download-progress', (event) => handler(event.payload));
}

export const convertFileSrc = (path, protocol = 'asset') => {
    const fn = getTauri()?.core?.convertFileSrc;
    if (typeof fn !== 'function') {
        throw new Error('Tauri convertFileSrc is unavailable');
    }
    return fn(path, protocol);
};

export async function getClientVersion() {
    return invoke('get_client_version');
}

export async function checkForUpdate(channel) {
    return invokeWithHostNormalization('check_for_update', { channel });
}

export async function getTauriTavernSettings() {
    return invoke('get_tauritavern_settings');
}

export async function getChatBackupStorageStats() {
    return invoke('get_chat_backup_storage_stats');
}

export async function updateTauriTavernSettings(dto) {
    if (!isPlainObject(dto)) {
        throw new Error('Invalid TauriTavern settings DTO');
    }

    return invokeWithHostNormalization('update_tauritavern_settings', { dto });
}

export async function getRuntimePaths() {
    return invoke('get_runtime_paths');
}

export async function setDataRoot(dataRoot) {
    if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
        throw new Error('Invalid data root path');
    }
    return invokeWithHostNormalization('set_data_root', { data_root: dataRoot });
}

export async function openDialog(options = {}) {
    if (!isPlainObject(options)) {
        throw new Error('Invalid dialog options: expected an object');
    }

    Object.freeze(options);

    return invokeWithHostNormalization('plugin:dialog|open', { options });
}

export function writeClipboardText(text) {
    return invoke('plugin:clipboard-manager|write_text', { text });
}

function normalizeExternalUrl(url) {
    const value = String(url instanceof URL ? url.href : url ?? '').trim();
    if (!value) {
        throw new Error('External URL is required');
    }

    try {
        return new URL(value, window.location.href).toString();
    } catch {
        throw new Error(`Invalid external URL: ${value}`);
    }
}

export async function openExternalUrl(url, openWith) {
    const href = normalizeExternalUrl(url);
    return invoke('plugin:opener|open_url', {
        url: href,
        with: openWith,
    });
}
