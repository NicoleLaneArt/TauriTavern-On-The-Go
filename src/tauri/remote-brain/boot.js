// @ts-check
// PC Brain startup. Runs before the app loads:
// - phone (client): check the PC answers, then publish the session so the
//   bridge routes data commands to it; otherwise show the "PC offline" screen.
// - PC (host): remember the phone's change count so a stale page reloads.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** @param {string} command @param {any} [args] */
function localInvoke(command, args) {
    // @ts-ignore - Tauri global API.
    return window.__TAURI__.core.invoke(command, args);
}

/** @param {unknown} error */
function errorText(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Settings shared from the PC say "localhost" for services running on the PC
 * (Chatterbox, Kokoro…). On the phone that must mean the PC.
 * @param {string} pcHost
 */
function rewriteLocalhostFetches(pcHost) {
    const nativeFetch = window.fetch.bind(window);
    /** @param {string} raw */
    const rewrite = (raw) => {
        try {
            const url = new URL(raw, window.location.href);
            if ((url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname)) {
                url.hostname = pcHost;
                return url.toString();
            }
        } catch {
            // Not a URL; leave it alone.
        }
        return null;
    };
    window.fetch = function pcBrainFetch(input, init) {
        if (typeof input === 'string' || input instanceof URL) {
            const next = rewrite(String(input));
            if (next) return nativeFetch(next, init);
        } else if (input instanceof Request) {
            const next = rewrite(input.url);
            if (next) return nativeFetch(new Request(next, input), init);
        }
        return nativeFetch(input, init);
    };
}

/** Reload when the other device changed the data while this page was away. */
function reloadWhenOtherDeviceWrote(readCount, baseline) {
    let checking = false;
    const check = async () => {
        if (checking || document.visibilityState !== 'visible') return;
        checking = true;
        try {
            const count = await readCount();
            if (typeof count === 'number' && count !== baseline) {
                console.info('[PC Brain] The other device changed your data; reloading.');
                window.location.reload();
            }
        } catch {
            // Offline right now; the next command will say so.
        } finally {
            checking = false;
        }
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
}

const OVERLAY_ID = 'tt-pc-brain-offline';

/**
 * @param {string} reason
 * @param {{ address: string, passcode: string }} client
 * @param {any} config
 */
function showOfflineScreen(reason, client, config) {
    return new Promise(() => {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('role', 'alertdialog');
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647', 'background:#111', 'color:#fff',
            'display:flex', 'align-items:center', 'justify-content:center', 'padding:24px',
            'font-family:system-ui,sans-serif', 'overflow:auto',
        ].join(';');
        overlay.innerHTML = `
            <div style="max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px">
                <div style="font-size:40px;line-height:1">🧠</div>
                <h1 style="margin:0;font-size:28px">PC offline</h1>
                <p data-reason style="margin:0;font-size:16px;line-height:1.4;color:#ddd"></p>
                <button data-retry type="button">Try again</button>
                <details style="font-size:16px">
                    <summary style="cursor:pointer;padding:8px 0">Change PC address or passcode</summary>
                    <label style="display:block;margin-top:8px">PC address
                        <input data-address type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
                    </label>
                    <label style="display:block;margin-top:8px">Passcode
                        <input data-passcode type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
                    </label>
                    <button data-save type="button" style="margin-top:12px">Save and try again</button>
                </details>
                <button data-local type="button" class="secondary">Use this phone's own data instead</button>
                <p data-status style="margin:0;min-height:1.4em;color:#ffd400"></p>
            </div>`;
        const style = document.createElement('style');
        style.textContent = `
            #${OVERLAY_ID} button { font-size:18px;padding:14px;border-radius:12px;border:3px solid #000;
                background:#ffd400;color:#000;font-weight:700;cursor:pointer;width:100% }
            #${OVERLAY_ID} button.secondary { background:#333;color:#fff;border-color:#666 }
            #${OVERLAY_ID} input { display:block;width:100%;box-sizing:border-box;font-size:18px;padding:10px;
                margin-top:4px;border-radius:8px;border:2px solid #888;background:#222;color:#fff }`;
        overlay.prepend(style);
        const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (overlay.querySelector(selector));
        $('[data-reason]').textContent = reason;
        /** @type {HTMLInputElement} */ ($('[data-address]')).value = client.address || '';
        /** @type {HTMLInputElement} */ ($('[data-passcode]')).value = client.passcode || '';
        const status = $('[data-status]');

        $('[data-retry]').addEventListener('click', () => window.location.reload());
        $('[data-save]').addEventListener('click', async () => {
            status.textContent = 'Saving…';
            try {
                const next = structuredClone(config);
                next.client.address = /** @type {HTMLInputElement} */ ($('[data-address]')).value;
                next.client.passcode = /** @type {HTMLInputElement} */ ($('[data-passcode]')).value;
                await localInvoke('remote_brain_save_config', { config: next });
                window.location.reload();
            } catch (error) {
                status.textContent = errorText(error);
            }
        });
        $('[data-local]').addEventListener('click', async () => {
            status.textContent = 'Switching…';
            try {
                const next = structuredClone(config);
                next.client.enabled = false;
                await localInvoke('remote_brain_save_config', { config: next });
                window.location.reload();
            } catch (error) {
                status.textContent = errorText(error);
            }
        });

        const mount = () => document.body.append(overlay);
        if (document.body) mount();
        else document.addEventListener('DOMContentLoaded', mount, { once: true });
    });
}

export async function bootRemoteBrain() {
    /** @type {any} */
    let state;
    try {
        state = await localInvoke('remote_brain_get_state');
    } catch (error) {
        console.warn('[PC Brain] Unavailable on this device:', error);
        return;
    }

    const { client, host } = state.config;

    if (client.enabled) {
        let hello;
        try {
            hello = await localInvoke('remote_brain_check');
        } catch (error) {
            await showOfflineScreen(errorText(error), client, state.config);
            return;
        }
        const pcHost = new URL(hello.address).hostname;
        // @ts-ignore - read by tauri/remote-brain/router.js.
        window.__TAURITAVERN_REMOTE_BRAIN__ = Object.freeze({
            client: true,
            pcHost,
            pcName: String(hello.name || 'PC'),
        });
        rewriteLocalhostFetches(pcHost);
        reloadWhenOtherDeviceWrote(
            async () => (await localInvoke('remote_brain_check')).pcWrites,
            hello.pcWrites,
        );
        console.info(`[PC Brain] Reading from ${hello.name} at ${hello.address}`);
        return;
    }

    if (host.enabled) {
        reloadWhenOtherDeviceWrote(
            async () => (await localInvoke('remote_brain_get_state')).phoneWrites,
            state.phoneWrites,
        );
    }
}
