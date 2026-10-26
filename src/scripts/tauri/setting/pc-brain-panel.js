// @ts-check
// PC Brain panel: choose whether this device shares its data (PC) or reads
// from a PC (phone). Uses device-local commands only.

import { invoke } from '../../../tauri-bridge.js';
import { POPUP_TYPE } from '../../popup.js';
import { createTauriTavernPanelPopup } from './panel-popup.js';

const STYLE_ID = 'tt-pc-brain-style';

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .tt-pc-brain { display:flex; flex-direction:column; gap:12px; text-align:left; font-size:1.05em }
        .tt-pc-brain h3 { margin:0 }
        .tt-pc-brain .tt-pcb-roles { display:flex; flex-direction:column; gap:6px }
        .tt-pc-brain .tt-pcb-roles label { display:flex; gap:10px; align-items:flex-start; padding:10px;
            border:2px solid var(--SmartThemeBorderColor); border-radius:10px; cursor:pointer }
        .tt-pc-brain .tt-pcb-roles input { margin-top:4px; transform:scale(1.3) }
        .tt-pc-brain .tt-pcb-box { display:flex; flex-direction:column; gap:8px; padding:10px;
            border-radius:10px; background:var(--black30a) }
        .tt-pc-brain .tt-pcb-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
        .tt-pc-brain code { font-size:1.15em; user-select:all; padding:2px 6px; border-radius:6px;
            background:var(--black50a) }
        .tt-pc-brain .tt-pcb-status { font-weight:600 }
        .tt-pc-brain .tt-pcb-ok { color:#7CFC8A }
        .tt-pc-brain .tt-pcb-bad { color:#ffd400 }
        .tt-pc-brain .tt-pcb-save { background:#ffd400; color:#000; border:3px solid #000; font-weight:700;
            border-radius:12px; padding:10px 16px; font-size:1.1em }`;
    document.head.append(style);
}

/** @param {unknown} error */
function errorText(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return JSON.stringify(error);
}

/** @param {string} tag @param {Record<string, any>} [props] @param {(Node|string)[]} [children] */
function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

function copyButton(/** @type {string} */ text) {
    const button = el('button', { type: 'button', className: 'menu_button', textContent: 'Copy' });
    button.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(text);
            button.textContent = 'Copied';
        } catch {
            button.textContent = 'Select & copy';
        }
    });
    return button;
}

export async function openPcBrainPanel() {
    ensureStyle();
    /** @type {any} */
    let state = await invoke('remote_brain_get_state');
    const originalRole = roleOf(state.config);

    const root = el('div', { className: 'tt-pc-brain' });
    const popup = createTauriTavernPanelPopup(root, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: false,
        large: false,
        allowVerticalScrolling: true,
    });

    /** @param {any} config */
    function roleOf(config) {
        if (config.client.enabled) return 'phone';
        if (config.host.enabled) return 'pc';
        return 'off';
    }

    function render() {
        const config = state.config;
        let role = roleOf(config);
        root.replaceChildren();
        root.append(
            el('h3', { textContent: '🧠 PC Brain' }),
            el('small', {
                textContent: 'Keep everything on your PC and let your phone read from it over Tailscale.',
            }),
        );

        const roles = el('div', { className: 'tt-pcb-roles' });
        const choices = [
            ['off', 'Off', 'This device uses its own data.'],
            ['pc', 'This is my PC', 'Share this device\'s characters and chats with my phone.'],
            ['phone', 'This is my phone', 'Use my PC\'s characters and chats instead of the phone\'s.'],
        ];
        for (const [value, title, hint] of choices) {
            const input = el('input', { type: 'radio', name: 'tt-pcb-role', value, checked: role === value });
            input.addEventListener('change', () => {
                role = value;
                pcBox.style.display = role === 'pc' ? '' : 'none';
                phoneBox.style.display = role === 'phone' ? '' : 'none';
            });
            roles.append(el('label', {}, [input, el('div', {}, [el('b', { textContent: title }), el('br'), el('small', { textContent: hint })])]));
        }
        root.append(roles);

        // PC section
        const pcBox = el('div', { className: 'tt-pcb-box' });
        const tailscale = state.hostAddresses.filter((/** @type {any} */ a) => a.tailscale);
        const running = state.hostRunning && config.host.enabled;
        pcBox.append(el('div', {
            className: `tt-pcb-status ${running ? 'tt-pcb-ok' : 'tt-pcb-bad'}`,
            textContent: state.hostError
                ? `Not running: ${state.hostError}`
                : running ? `✓ Sharing on port ${config.host.port}` : 'Not sharing yet. Choose "This is my PC" and Save.',
        }));
        if (tailscale.length) {
            for (const address of tailscale) {
                pcBox.append(el('div', { className: 'tt-pcb-row' }, [
                    'PC address: ', el('code', { textContent: address.ip }), copyButton(address.ip),
                ]));
            }
        } else {
            pcBox.append(el('div', {
                className: 'tt-pcb-bad',
                textContent: 'No Tailscale address found. Is Tailscale running on this PC?',
            }));
        }
        const passcodeInput = el('input', { type: 'text', className: 'text_pole', value: config.host.passcode, spellcheck: false });
        const newCode = el('button', { type: 'button', className: 'menu_button', textContent: 'New passcode' });
        newCode.addEventListener('click', () => {
            const words = ['amber', 'birch', 'cedar', 'daisy', 'ember', 'fern', 'hazel', 'iris', 'maple', 'otter', 'river', 'willow'];
            const pick = () => words[Math.floor(Math.random() * words.length)];
            passcodeInput.value = `${pick()}-${pick()}-${100 + Math.floor(Math.random() * 900)}`;
        });
        pcBox.append(
            el('div', { className: 'tt-pcb-row' }, ['Passcode: ', el('code', { textContent: config.host.passcode }), copyButton(config.host.passcode)]),
            el('label', {}, ['Change passcode', passcodeInput]),
            el('div', { className: 'tt-pcb-row' }, [newCode]),
            el('small', { textContent: `Only devices on your Tailscale network can connect (port ${config.host.port}). Keep this PC awake with TauriTavern open.` }),
        );

        // Phone section
        const phoneBox = el('div', { className: 'tt-pcb-box' });
        const addressInput = el('input', {
            type: 'text', className: 'text_pole', value: config.client.address,
            placeholder: '100.x.x.x', spellcheck: false, autocapitalize: 'off',
        });
        const phonePasscode = el('input', {
            type: 'text', className: 'text_pole', value: config.client.passcode,
            placeholder: 'word-word-123', spellcheck: false, autocapitalize: 'off',
        });
        const testResult = el('div', { className: 'tt-pcb-status' });
        const testButton = el('button', { type: 'button', className: 'menu_button', textContent: 'Test connection' });
        testButton.addEventListener('click', async () => {
            testResult.className = 'tt-pcb-status';
            testResult.textContent = 'Checking…';
            try {
                /** @type {any} */
                const hello = await invoke('remote_brain_check', {
                    address: addressInput.value,
                    passcode: phonePasscode.value,
                });
                testResult.className = 'tt-pcb-status tt-pcb-ok';
                testResult.textContent = `✓ Connected to ${hello.name}`;
            } catch (error) {
                testResult.className = 'tt-pcb-status tt-pcb-bad';
                testResult.textContent = errorText(error);
            }
        });
        phoneBox.append(
            el('label', {}, ['PC address (from the PC Brain panel on your PC)', addressInput]),
            el('label', {}, ['Passcode', phonePasscode]),
            el('div', { className: 'tt-pcb-row' }, [testButton]),
            testResult,
            el('small', { textContent: 'Your phone\'s own characters stay safe on the phone. Switch back to Off anytime.' }),
        );

        pcBox.style.display = role === 'pc' ? '' : 'none';
        phoneBox.style.display = role === 'phone' ? '' : 'none';
        root.append(pcBox, phoneBox);

        const saveStatus = el('div', { className: 'tt-pcb-status' });
        const save = el('button', { type: 'button', className: 'tt-pcb-save', textContent: 'Save' });
        save.addEventListener('click', async () => {
            const next = structuredClone(config);
            next.host.enabled = role === 'pc';
            next.client.enabled = role === 'phone';
            next.host.passcode = passcodeInput.value.trim() || config.host.passcode;
            next.client.address = addressInput.value.trim();
            next.client.passcode = phonePasscode.value.trim();
            saveStatus.className = 'tt-pcb-status';
            saveStatus.textContent = 'Saving…';
            try {
                if (role === 'phone') {
                    await invoke('remote_brain_check', { address: next.client.address, passcode: next.client.passcode });
                }
                state = await invoke('remote_brain_save_config', { config: next });
                const phoneChanged = (originalRole === 'phone') !== (role === 'phone');
                if (phoneChanged) {
                    saveStatus.textContent = 'Saved. Restarting…';
                    setTimeout(() => window.location.reload(), 600);
                    return;
                }
                render();
            } catch (error) {
                saveStatus.className = 'tt-pcb-status tt-pcb-bad';
                saveStatus.textContent = errorText(error);
            }
        });
        root.append(el('div', { className: 'tt-pcb-row' }, [save]), saveStatus);
    }

    render();
    await popup.show();
}
