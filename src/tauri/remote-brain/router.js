// @ts-check
// PC Brain routing: on a phone that reads from the PC, data commands run on the
// PC; device commands (window, speech, logs, sync, file pickers) stay here.

const LOCAL_PREFIXES = ['remote_brain_', 'devlog_', 'lan_sync_', 'tt_sync_', 'sync_'];

const LOCAL_COMMANDS = new Set([
    'get_window_snapshot',
    'capture_content_viewport',
    'set_window_backdrop',
    'backend_error_bridge_ready',
    'check_for_update',
    'register_agent_extension_tool',
    'set_agent_extension_tool_enabled',
    'resolve_agent_extension_tool_call',
    'subscribe_agent_run_live_projection',
    'get_runtime_paths',
    'set_data_root',
    'import_data_archive_from_picker',
    'start_export_data_archive',
    'get_data_archive_job_status',
    'cancel_data_archive_job',
    'save_export_data_archive',
    'export_user_backup_archive',
    'pick_import_files',
    'deliver_staged_file',
]);

/** Plugin commands that read the PC's files (chat payload streaming). */
const REMOTE_PLUGIN_PREFIXES = ['plugin:fs|', 'plugin:resources|'];

/** @param {string} command */
export function runsOnPc(command) {
    if (command.startsWith('plugin:')) {
        return REMOTE_PLUGIN_PREFIXES.some(prefix => command.startsWith(prefix));
    }
    if (LOCAL_COMMANDS.has(command)) {
        return false;
    }
    return !LOCAL_PREFIXES.some(prefix => command.startsWith(prefix));
}

/** @param {unknown} headers @returns {Record<string, string>} */
function plainHeaders(headers) {
    /** @type {Record<string, string>} */
    const out = {};
    if (!headers) {
        return out;
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => { out[key] = value; });
        return out;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            out[String(key)] = String(value);
        }
        return out;
    }
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
        if (value !== undefined && value !== null) {
            out[key] = String(value);
        }
    }
    return out;
}

/**
 * @param {(command: string, args?: any, options?: any) => Promise<any>} rawInvoke
 * @param {string} command
 * @param {any} args
 * @param {any} options
 */
export function invokeOnPc(rawInvoke, command, args, options) {
    const headers = plainHeaders(options?.headers);
    if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) {
        return rawInvoke('remote_brain_forward_raw', args, {
            headers: {
                'x-brain-cmd': command,
                'x-brain-headers': JSON.stringify(headers),
            },
        });
    }
    return rawInvoke('remote_brain_forward', {
        cmd: command,
        args: args ?? {},
        headers,
    });
}

/** @returns {{ client: boolean, pcHost: string } | null} */
export function remoteBrainSession() {
    if (typeof window === 'undefined') {
        return null;
    }
    // @ts-ignore - published once by boot.js before any app module loads.
    return window.__TAURITAVERN_REMOTE_BRAIN__ || null;
}
