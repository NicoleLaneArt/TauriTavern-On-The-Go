// @ts-check

/**
 * Nicole's build: big read-aloud button beside each character message.
 * Tap = narrate that message with the TTS extension; tap again = stop.
 */
export function installSpeakButtons() {
    /** @type {HTMLElement | null} */
    let activeButton = null;
    let pollTimer = 0;

    const tts = () => /** @type {any} */ (window).__TAURITAVERN_TTS__;

    const clearActive = () => {
        window.clearInterval(pollTimer);
        pollTimer = 0;
        if (activeButton) {
            activeButton.classList.remove('is-playing');
            activeButton.setAttribute('aria-label', 'Read this message aloud');
            activeButton.title = 'Read aloud';
        }
        activeButton = null;
    };

    /** @param {HTMLElement} button */
    const markActive = (button) => {
        clearActive();
        activeButton = button;
        button.classList.add('is-playing');
        button.setAttribute('aria-label', 'Stop reading');
        button.title = 'Stop';
        let sawBusy = false;
        const startedAt = Date.now();
        pollTimer = window.setInterval(() => {
            const busy = Boolean(tts()?.isBusy?.());
            if (busy) sawBusy = true;
            // Give the voice a few seconds to start before treating "not busy" as finished.
            if (!busy && (sawBusy || Date.now() - startedAt > 8000)) clearActive();
        }, 400);
    };

    document.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement | null} */ (event.target instanceof HTMLElement ? event.target : null);
        const button = target?.closest('.tt-speak-button');
        if (!(button instanceof HTMLElement)) return;
        event.preventDefault();
        event.stopPropagation();

        if (button === activeButton) {
            tts()?.stop?.();
            clearActive();
            return;
        }
        if (tts()?.isBusy?.()) {
            tts()?.stop?.();
        }

        const message = button.closest('.mes');
        const narrate = message?.querySelector('.mes_narrate');
        if (!(narrate instanceof HTMLElement)) {
            window.toastr?.info?.('Turn on Text-to-Speech in Extensions to use the speaker button.');
            return;
        }
        markActive(button);
        // The TTS extension's own handler resolves the message from this element.
        /** @type {any} */ (window).jQuery?.(narrate).trigger('click');
    }, true);
}
