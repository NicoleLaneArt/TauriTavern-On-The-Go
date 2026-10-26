// Story Memory: a lean, per-chat story record.
//
// Every so often (one model call per batch of messages, never per reply) the
// older part of the chat is written down as short chapters ("what changed"),
// durable facts tagged with who knows them, and the current moment. Before a
// reply, that record goes into the prompt and the messages it covers leave it,
// so a long story keeps its continuity in a small context.
//
// Per chat and off until turned on. The record lives in the chat's own store
// (TauriTavern api.chat store), never in the chat file or a lorebook.

import { extension_settings, getContext } from '../../extensions.js';
import { eventSource, event_types, generateRaw, saveSettingsDebounced, setExtensionPrompt } from '../../../script.js';
import { extension_prompt_roles, extension_prompt_types } from '../../extension-prompts.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { POPUP_TYPE, Popup } from '../../popup.js';

const NAMESPACE = 'story-memory';
const RECORD_KEY = 'record';
const PROMPT_KEY = 'story_memory';
const SETTINGS_KEY = 'story_memory';

const DEFAULT_SETTINGS = Object.freeze({
    keepRecent: 30,
    chapterEvery: 16,
    maxChunk: 40,
    budgetTokens: 1500,
    toasts: true,
});

const MAX_CHAPTERS_BEFORE_ARC = 14;
const CHAPTERS_PER_ARC = 6;
const MESSAGE_CHAR_LIMIT = 2000;

/** @type {{ chatKey: string | null, record: any, handle: any, writing: boolean, failedAtLength: number }} */
const state = {
    chatKey: null,
    record: null,
    handle: null,
    writing: false,
    failedAtLength: -1,
};

function settings() {
    const current = extension_settings[SETTINGS_KEY] ?? (extension_settings[SETTINGS_KEY] = {});
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) current[key] = value;
    }
    return current;
}

function emptyRecord() {
    return {
        v: 1,
        enabled: false,
        base: 0,
        covered: 0,
        arcs: [],
        chapters: [],
        facts: [],
        now: null,
        cast: [],
        next: { arc: 1, chapter: 1, fact: 1 },
        updatedAt: 0,
    };
}

function normalizeRecord(value) {
    const record = { ...emptyRecord(), ...(value && typeof value === 'object' ? value : {}) };
    record.arcs = Array.isArray(record.arcs) ? record.arcs : [];
    record.chapters = Array.isArray(record.chapters) ? record.chapters : [];
    record.facts = Array.isArray(record.facts) ? record.facts : [];
    record.cast = Array.isArray(record.cast) ? record.cast : [];
    record.next = { ...emptyRecord().next, ...(record.next || {}) };
    record.base = Number(record.base) || 0;
    record.covered = Math.max(record.base, Number(record.covered) || 0);
    return record;
}

function currentChatKey() {
    const context = getContext();
    const id = context.getCurrentChatId?.();
    if (!id) return null;
    return `${context.groupId ? 'g' : 'c'}:${context.groupId ?? context.characterId}:${id}`;
}

function currentHandle() {
    const api = window.__TAURITAVERN__?.api?.chat;
    if (!api) return null;
    try {
        return api.current.handle();
    } catch {
        return null;
    }
}

async function readRecord(handle) {
    const keys = await handle.store.listKeys({ namespace: NAMESPACE });
    if (!Array.isArray(keys) || !keys.includes(RECORD_KEY)) {
        return emptyRecord();
    }
    return normalizeRecord(await handle.store.getJson({ namespace: NAMESPACE, key: RECORD_KEY }));
}

async function saveRecord(handle, record) {
    record.updatedAt = Date.now();
    await handle.store.setJson({ namespace: NAMESPACE, key: RECORD_KEY, value: record });
}

/** Loads the record of the chat on screen (once per chat). */
async function ensureLoaded() {
    const key = currentChatKey();
    if (!key) {
        state.chatKey = null;
        state.record = null;
        state.handle = null;
        updatePrompt();
        return null;
    }
    if (state.chatKey === key && state.record) {
        return state.record;
    }
    const handle = currentHandle();
    state.chatKey = key;
    state.handle = handle;
    state.record = null;
    state.failedAtLength = -1;
    if (!handle) {
        updatePrompt();
        return null;
    }
    try {
        const record = await readRecord(handle);
        if (state.chatKey === key) {
            state.record = record;
        }
    } catch (error) {
        // A brand-new chat has no store yet; it gets one on first save.
        console.debug('[Story Memory] No record yet:', error);
        if (state.chatKey === key) {
            state.record = emptyRecord();
        }
    }
    updatePrompt();
    return state.record;
}

// ---------------------------------------------------------------------------
// What the model sees before a reply

const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.6);

function knowsLabel(knows) {
    if (knows === 'all' || (Array.isArray(knows) && knows.length === 0)) return 'everyone';
    return Array.isArray(knows) ? knows.join(', ') : String(knows || 'everyone');
}

function factLine(fact) {
    const about = fact.about ? `about ${fact.about}; ` : '';
    return `- [${fact.weight || 'everyday'}] (${about}known by: ${knowsLabel(fact.knows)}) ${fact.text}`;
}

function nowText(now) {
    if (!now) return '';
    const lines = [];
    if (now.place) lines.push(`Place: ${now.place}`);
    if (now.time) lines.push(`Time: ${now.time}`);
    const present = Array.isArray(now.present) ? now.present.join(', ') : now.present;
    if (present) lines.push(`Present: ${present}`);
    if (now.mood) lines.push(`Mood: ${now.mood}`);
    const threads = Array.isArray(now.threads) ? now.threads.filter(Boolean) : [];
    if (threads.length) lines.push(`Open threads: ${threads.join('; ')}`);
    return lines.join('\n');
}

/** The parts of a character's knowledge box, in the order they are shown. */
const BOX_PARTS = Object.freeze([
    ['knows', 'Knows'],
    ['doesNotKnow', 'Does NOT know'],
    ['secrets', 'Keeping secret'],
    ['sees', 'Can see right now'],
    ['cantSee', 'Cannot see'],
    ['goals', 'Goals'],
]);

function boxText(box) {
    const lines = [`${box.name}:`];
    for (const [key, label] of BOX_PARTS) {
        const items = Array.isArray(box[key]) ? box[key].filter(Boolean) : [];
        if (items.length) lines.push(`  ${label}: ${items.join('; ')}`);
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

/** One character's box in the author's Scrivener format. */
function boxMarkdown(box) {
    const first = box.name.split(/\s+/)[0];
    const labels = {
        knows: `What ${first} knows`,
        doesNotKnow: `What ${first} does NOT know`,
        secrets: `What ${first} keeps SECRET`,
        sees: `What ${first} can see right now`,
        cantSee: `What ${first} CANNOT see`,
        goals: 'Active objectives',
    };
    const lines = [`**${box.name}:**`];
    for (const [key] of BOX_PARTS) {
        const items = Array.isArray(box[key]) ? box[key].filter(Boolean) : [];
        lines.push(`- **${labels[key]}:** ${items.length ? items.map(item => {
            const sentence = item.charAt(0).toUpperCase() + item.slice(1);
            return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
        }).join(' ') : '—'}`);
    }
    return lines.join('\n');
}

function boxesMarkdown(record, boxes) {
    const chapter = record.chapters.length ? record.chapters[record.chapters.length - 1].n : record.next.chapter;
    return [`**Character Knowledge Box — Chapter ${chapter}:**`, ...boxes.map(boxMarkdown)].join('\n\n');
}

async function copyText(text) {
    try {
        const { writeClipboardText } = await import('../../../tauri-bridge.js');
        await writeClipboardText(text);
    } catch {
        await navigator.clipboard.writeText(text);
    }
    toastr.success('Copied. Paste it into Scrivener.', 'Story Memory', { timeOut: 2000 });
}

function presentNames(record) {
    const present = record.now?.present;
    const list = Array.isArray(present) ? present : String(present || '').split(',');
    return new Set(list.map(name => String(name).trim().toLowerCase()).filter(Boolean));
}

/** Builds the memory block within the token budget, most important first. */
function buildPromptText(record) {
    const budget = Number(settings().budgetTokens) || DEFAULT_SETTINGS.budgetTokens;
    const facts = record.facts.filter(f => f && f.text);
    const rank = { key: 0, important: 1, everyday: 2 };
    const sortedFacts = [...facts].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
        || (rank[a.weight] ?? 2) - (rank[b.weight] ?? 2));

    const now = nowText(record.now);
    let used = estimateTokens(now) + 80;
    const chosenFacts = [];
    const chosenChapters = [];
    const chosenArcs = [];
    const chosenBoxes = [];

    const take = (text) => {
        const cost = estimateTokens(text);
        if (used + cost > budget) return false;
        used += cost;
        return true;
    };

    // Knowledge boxes of those in the scene, key and pinned facts, the last
    // three chapters, then everything else.
    const here = presentNames(record);
    const boxes = record.cast.filter(box => box && box.name && boxText(box));
    for (const box of boxes) {
        if (here.has(box.name.trim().toLowerCase()) && take(boxText(box))) chosenBoxes.push(box);
    }
    for (const fact of sortedFacts) {
        if ((fact.pinned || fact.weight === 'key') && take(factLine(fact))) chosenFacts.push(fact);
    }
    const chapters = [...record.chapters];
    for (const chapter of chapters.slice(-3).reverse()) {
        if (take(chapter.text)) chosenChapters.unshift(chapter);
    }
    for (const fact of sortedFacts) {
        if (!chosenFacts.includes(fact) && fact.weight === 'important' && take(factLine(fact))) chosenFacts.push(fact);
    }
    for (const arc of [...record.arcs].reverse()) {
        if (take(arc.text)) chosenArcs.unshift(arc);
    }
    for (const chapter of chapters.slice(0, -3).reverse()) {
        if (take(chapter.text)) chosenChapters.unshift(chapter);
    }
    for (const fact of sortedFacts) {
        if (!chosenFacts.includes(fact) && take(factLine(fact))) chosenFacts.push(fact);
    }
    for (const box of boxes) {
        if (!chosenBoxes.includes(box) && take(boxText(box))) chosenBoxes.push(box);
    }

    if (!now && !chosenFacts.length && !chosenChapters.length && !chosenArcs.length && !chosenBoxes.length) return '';

    const parts = ['[Story memory: what happened before the recent messages. Treat it as true history.]'];
    if (chosenArcs.length || chosenChapters.length) {
        parts.push('Story so far:');
        chosenArcs.forEach(arc => parts.push(`- ${arc.label}: ${arc.text}`));
        chosenChapters.forEach(ch => parts.push(`- Ch ${ch.n} (${ch.label}): ${ch.text}`));
    }
    if (chosenFacts.length) {
        parts.push('Facts (a character only knows a fact if they are listed under "known by"; keep secrets secret):');
        chosenFacts.forEach(fact => parts.push(factLine(fact)));
    }
    if (chosenBoxes.length) {
        parts.push('Knowledge boxes (each character acts only on what their box says they know and can see; never reveal what they keep secret or do not know):');
        chosenBoxes.forEach(box => parts.push(boxText(box)));
    }
    if (now) {
        parts.push('Where things stand:');
        parts.push(now);
    }
    return parts.join('\n');
}

function updatePrompt() {
    const record = state.record;
    const text = record?.enabled ? buildPromptText(record) : '';
    setExtensionPrompt(PROMPT_KEY, text, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

/** Absolute chat index of each message the generator is about to send. */
function absoluteIndexes(coreChat) {
    const chat = getContext().chat;
    const originals = [];
    chat.forEach((message, index) => {
        if (message && !message.is_system) originals.push({ message, index });
    });
    const bySendDate = new Map();
    originals.forEach(({ message, index }) => {
        if (message.send_date) bySendDate.set(`${message.send_date}\u0001${message.name}`, index);
    });
    return coreChat.map((item, position) => {
        const candidate = originals[position];
        if (candidate && candidate.message.send_date === item.send_date && candidate.message.name === item.name) {
            return candidate.index;
        }
        return bySendDate.get(`${item.send_date}\u0001${item.name}`) ?? -1;
    });
}

globalThis.storyMemory_interceptor = async function (coreChat) {
    const record = await ensureLoaded();
    updatePrompt();
    if (!record?.enabled || record.covered <= record.base) return;

    const keep = Math.max(4, Number(settings().keepRecent) || DEFAULT_SETTINGS.keepRecent);
    const indexes = absoluteIndexes(coreChat);
    const lastCuttable = coreChat.length - keep;
    for (let i = Math.min(lastCuttable, coreChat.length) - 1; i >= 0; i--) {
        const abs = indexes[i];
        if (abs >= record.base && abs < record.covered) {
            coreChat.splice(i, 1);
        }
    }
};

// ---------------------------------------------------------------------------
// Writing the memory (one model call per batch)

const WRITER_SYSTEM = `You keep the memory of an ongoing roleplay story. You read a stretch of the story and update its record.

Return ONLY a JSON object, no other text:
{"chapters":[{"label":"2-5 words","text":"3-6 sentences"}],
 "facts":[{"op":"add","text":"...","about":"<name or world>","knows":["Name","Name"] or "all","weight":"key|important|everyday"},
          {"op":"update","id":"f3","text":"...","knows":["..."]},
          {"op":"retire","id":"f4"}],
 "now":{"place":"","time":"","present":["names"],"mood":"one line on how the characters feel toward each other right now","threads":["unresolved hooks, promises, dangers"]},
 "cast":[{"name":"Name","knows":["..."],"doesNotKnow":["..."],"secrets":["..."],"sees":["..."],"cantSee":["..."],"goals":["..."]}]}

Rules:
- chapters: one per scene in the NEW MESSAGES (usually 1, at most 3). Write WHAT CHANGED: decisions, reveals, shifts in relationships, consequences. Not a retelling, no dialogue quotes.
- facts: durable things that stay true (identities, relationships, secrets, promises, injuries, possessions, world rules). "knows" lists exactly who knows it; use "all" only for public facts. Update a fact when it changed, retire it when it no longer matters. Never touch facts marked (locked). Skip trivia.
- weight: key = the story would break without it; important = matters often; everyday = small detail.
- now: describe the end of the LATEST MOMENT.
- cast: a knowledge box for each main character who acted or was present, including the user's character. Rewrite the whole box as it stands at the end of the LATEST MOMENT: knows (what they know that matters), doesNotKnow (important things they are unaware of, especially other characters' secrets and true identities), secrets (what they deliberately hide, and from whom), sees / cantSee (what is in or out of their view right now), goals (what they are trying to do). Short items, a few words to one sentence each. Skip boxes marked (locked).
- Use the characters' names as written. Write in English.`;

function messageLine(index, message) {
    const text = String(message.mes || '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHAR_LIMIT);
    return `[${index}] ${message.name}: ${text}`;
}

function buildWriterPrompt(record, start, end) {
    const context = getContext();
    const chat = context.chat;
    const lines = [];
    lines.push(`User's character: ${context.name1}`);
    const facts = record.facts.filter(f => f && f.text);
    lines.push('', 'CURRENT FACTS:');
    if (facts.length) {
        facts.forEach(f => lines.push(`${f.id} ${factLine(f).slice(2)}${f.locked ? ' (locked)' : ''}`));
    } else {
        lines.push('(none yet)');
    }
    const boxes = record.cast.filter(box => box && box.name);
    if (boxes.length) {
        lines.push('', 'CURRENT KNOWLEDGE BOXES:');
        boxes.forEach(box => lines.push(`${boxText(box) || `${box.name}: (empty)`}${box.locked ? ' (locked)' : ''}`));
    }
    const last = record.chapters[record.chapters.length - 1];
    if (last) {
        lines.push('', `PREVIOUS CHAPTER (for continuity): ${last.label}: ${last.text}`);
    }
    lines.push('', `NEW MESSAGES TO RECORD (${start}-${end - 1}):`);
    for (let i = start; i < end; i++) {
        const message = chat[i];
        if (message && !message.is_system) lines.push(messageLine(i, message));
    }
    lines.push('', 'LATEST MOMENT (only for "now"):');
    for (let i = Math.max(end, chat.length - 6); i < chat.length; i++) {
        const message = chat[i];
        if (message && !message.is_system) lines.push(messageLine(i, message));
    }
    return lines.join('\n');
}

function parseJsonObject(raw) {
    const text = removeReasoningFromString(String(raw || '')).replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The model did not return a memory record.');
    return JSON.parse(text.slice(start, end + 1));
}

function toList(value) {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
    return String(value || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
}

const WEIGHTS = new Set(['key', 'important', 'everyday']);

function normalizeKnows(knows) {
    if (knows === 'all' || knows === undefined || knows === null) return 'all';
    if (Array.isArray(knows)) {
        const names = knows.map(String).map(s => s.trim()).filter(Boolean);
        return names.length ? names : 'all';
    }
    return String(knows).split(',').map(s => s.trim()).filter(Boolean);
}

function applyWriterResult(record, result, start, end) {
    const written = [];
    for (const chapter of Array.isArray(result.chapters) ? result.chapters.slice(0, 3) : []) {
        const text = String(chapter?.text || '').trim();
        if (!text) continue;
        const n = record.next.chapter++;
        record.chapters.push({
            id: `c${n}`,
            n,
            label: String(chapter.label || `Chapter ${n}`).trim().slice(0, 60),
            text,
            from: start,
            to: end,
            at: Date.now(),
        });
        written.push(n);
    }
    for (const op of Array.isArray(result.facts) ? result.facts : []) {
        const kind = String(op?.op || 'add');
        if (kind === 'add') {
            const text = String(op.text || '').trim();
            if (!text) continue;
            record.facts.push({
                id: `f${record.next.fact++}`,
                text,
                about: String(op.about || '').trim(),
                knows: normalizeKnows(op.knows),
                weight: WEIGHTS.has(op.weight) ? op.weight : 'everyday',
                at: Date.now(),
            });
            continue;
        }
        const target = record.facts.find(f => f.id === op?.id);
        if (!target || target.locked || target.pinned) continue;
        if (kind === 'update') {
            if (op.text) target.text = String(op.text).trim();
            if (op.knows !== undefined) target.knows = normalizeKnows(op.knows);
            if (WEIGHTS.has(op.weight)) target.weight = op.weight;
            target.at = Date.now();
        } else if (kind === 'retire') {
            record.facts = record.facts.filter(f => f !== target);
        }
    }
    if (result.now && typeof result.now === 'object') {
        record.now = {
            place: String(result.now.place || '').trim(),
            time: String(result.now.time || '').trim(),
            present: Array.isArray(result.now.present) ? result.now.present.map(String) : String(result.now.present || ''),
            mood: String(result.now.mood || '').trim(),
            threads: Array.isArray(result.now.threads) ? result.now.threads.map(String).filter(Boolean) : [],
        };
    }
    for (const incoming of Array.isArray(result.cast) ? result.cast : []) {
        const name = String(incoming?.name || '').trim();
        if (!name) continue;
        let box = record.cast.find(b => b.name.trim().toLowerCase() === name.toLowerCase());
        if (box?.locked) continue;
        if (!box) {
            box = { name };
            record.cast.push(box);
        }
        for (const [key] of BOX_PARTS) {
            if (incoming[key] !== undefined) box[key] = toList(incoming[key]);
        }
        box.at = Date.now();
    }
    record.covered = end;
    return written;
}

async function mergeOldChaptersIntoArc(record) {
    if (record.chapters.length <= MAX_CHAPTERS_BEFORE_ARC) return;
    const oldest = record.chapters.slice(0, CHAPTERS_PER_ARC);
    const raw = await generateRaw({
        systemPrompt: 'Merge these story chapters into one arc. Return ONLY JSON: {"label":"2-5 words","text":"4-8 sentences on what changed overall"}.',
        prompt: oldest.map(ch => `Ch ${ch.n} (${ch.label}): ${ch.text}`).join('\n'),
        responseLength: 600,
    });
    const arc = parseJsonObject(raw);
    const text = String(arc.text || '').trim();
    if (!text) return;
    const n = record.next.arc++;
    record.arcs.push({
        id: `a${n}`,
        label: String(arc.label || `Arc ${n}`).trim().slice(0, 60),
        text,
        from: oldest[0].from,
        to: oldest[oldest.length - 1].to,
        at: Date.now(),
    });
    record.chapters = record.chapters.slice(CHAPTERS_PER_ARC);
}

function toast(message, kind = 'info') {
    if (!settings().toasts && kind === 'info') return;
    window.toastr?.[kind]?.(message, 'Story Memory', { timeOut: kind === 'info' ? 2500 : 5000 });
}

/**
 * Writes the next batch when enough messages are past the recent window.
 * @param {{ force?: boolean }} [options]
 */
async function maybeWrite({ force = false } = {}) {
    if (state.writing) return false;
    const record = await ensureLoaded();
    const handle = state.handle;
    const chatKey = state.chatKey;
    if (!record?.enabled || !handle) return false;

    const chat = getContext().chat;
    const { keepRecent, chapterEvery, maxChunk } = settings();
    if (record.covered > chat.length) record.covered = Math.max(record.base, chat.length);
    const limit = chat.length - Math.max(4, Number(keepRecent) || 30);
    const start = record.covered;
    const end = Math.min(limit, start + Math.max(8, Number(maxChunk) || 40));
    if (end <= start) return false;
    if (!force && end - start < Math.max(4, Number(chapterEvery) || 16)) return false;
    if (!force && state.failedAtLength >= 0 && chat.length < state.failedAtLength + 8) return false;

    state.writing = true;
    try {
        const raw = await generateRaw({
            systemPrompt: WRITER_SYSTEM,
            prompt: buildWriterPrompt(record, start, end),
            responseLength: 1500,
        });
        if (state.chatKey !== chatKey) return false;
        const written = applyWriterResult(record, parseJsonObject(raw), start, end);
        try {
            await mergeOldChaptersIntoArc(record);
        } catch (error) {
            console.warn('[Story Memory] Arc merge skipped:', error);
        }
        await saveRecord(handle, record);
        state.failedAtLength = -1;
        if (state.chatKey === chatKey) updatePrompt();
        toast(written.length ? `Chapter ${written.join(', ')} written` : 'Memory updated');
        // A long backlog (memory just turned on for an old chat) continues on its own.
        if (chat.length - Math.max(4, Number(keepRecent) || 30) - record.covered >= (Number(chapterEvery) || 16)) {
            setTimeout(() => void maybeWrite(), 1500);
        }
        return true;
    } catch (error) {
        console.error('[Story Memory] Could not write memory:', error);
        state.failedAtLength = getContext().chat.length;
        toast(`Could not update memory: ${error?.message || error}`, 'warning');
        return false;
    } finally {
        state.writing = false;
    }
}

// ---------------------------------------------------------------------------
// The notes screen

function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter(child => child !== null && child !== undefined));
    return node;
}

function field(label, input) {
    return el('label', { className: 'sm-field' }, [el('span', { textContent: label }), input]);
}

function textArea(value, rows = 3) {
    return el('textarea', { className: 'text_pole sm-text', value: value || '', rows });
}

function textInput(value, placeholder = '') {
    return el('input', { type: 'text', className: 'text_pole', value: value || '', placeholder });
}

async function openNotes() {
    const record = await ensureLoaded();
    if (!record || !state.handle) {
        toastr.info('Open a chat first.', 'Story Memory');
        return;
    }
    const handle = state.handle;
    const chatKey = state.chatKey;
    const config = settings();
    const root = el('div', { className: 'story-memory' });
    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    const working = structuredClone(record);
    const openSections = new Set(['now']);
    const section = (id, title, children) => {
        const details = el('details', { className: 'sm-section', open: openSections.has(id) }, [el('summary', { textContent: title }), ...children]);
        details.addEventListener('toggle', () => {
            if (details.open) openSections.add(id);
            else openSections.delete(id);
        });
        return details;
    };

    function render() {
        root.replaceChildren();
        const context = getContext();
        const title = context.groupId
            ? (context.groups.find(g => g.id === context.groupId)?.name || 'Group chat')
            : (context.name2 || 'Chat');
        root.append(el('h3', { textContent: `📖 Story Memory: ${title}` }));

        // On / off for this chat
        const status = el('div', { className: 'sm-status' });
        if (working.enabled) {
            const covered = Math.max(0, working.covered - working.base);
            status.textContent = covered
                ? `On. ${working.chapters.length + working.arcs.length} chapters/arcs and ${working.facts.length} facts cover messages ${working.base}–${working.covered - 1}; the last ${config.keepRecent} messages always stay word for word.`
                : `On. The first chapter is written once ${config.chapterEvery} messages have moved past the last ${config.keepRecent}.`;
        } else {
            status.textContent = 'Off for this chat. The story is sent as usual.';
        }
        const toggle = el('button', {
            type: 'button',
            className: working.enabled ? 'menu_button' : 'menu_button sm-primary',
            textContent: working.enabled ? 'Turn off for this chat' : 'Turn on for this chat',
        });
        toggle.addEventListener('click', () => {
            if (working.enabled) {
                working.enabled = false;
                return void persist('Story memory is off for this chat.');
            }
            const total = getContext().chat.length;
            const backlog = Math.max(0, total - config.keepRecent);
            if (working.covered > working.base || backlog < config.chapterEvery) {
                working.enabled = true;
                return void persist('Story memory is on for this chat.');
            }
            renderStartChoice(backlog);
        });
        root.append(el('div', { className: 'sm-row' }, [status]), el('div', { className: 'sm-row' }, [toggle]));

        if (working.enabled) {
            const writeNow = el('button', { type: 'button', className: 'menu_button', textContent: 'Write memory now' });
            writeNow.addEventListener('click', async () => {
                writeNow.disabled = true;
                writeNow.textContent = 'Writing…';
                await persist(null, false);
                const wrote = await maybeWrite({ force: true });
                if (!wrote) toastr.info('Nothing new to write yet: the recent messages stay word for word.', 'Story Memory');
                Object.assign(working, structuredClone(state.record || working));
                render();
            });
            root.append(el('div', { className: 'sm-row' }, [writeNow]));
        }

        const empty = !working.chapters.length && !working.arcs.length && !working.facts.length && !working.now && !working.cast.length;
        if (!working.enabled && empty) {
            root.append(renderSettings());
        } else {
            root.append(renderNow(), renderBoxes(), renderChapters(), renderFacts(), renderSettings());
        }

        const save = el('button', { type: 'button', className: 'menu_button sm-primary', textContent: 'Save changes' });
        save.addEventListener('click', () => void persist('Saved.'));
        root.append(el('div', { className: 'sm-row sm-save' }, [save]));
    }

    function renderStartChoice(backlog) {
        const calls = Math.ceil(backlog / (config.maxChunk || 40));
        const box = el('div', { className: 'sm-choice' }, [
            el('p', { textContent: `This chat already has ${backlog} messages before the recent ${config.keepRecent}. How should memory start?` }),
        ]);
        const fromNow = el('button', { type: 'button', className: 'menu_button sm-primary', textContent: 'From now on' });
        const readAll = el('button', { type: 'button', className: 'menu_button', textContent: `Read the whole chat (about ${calls} memory call${calls === 1 ? '' : 's'})` });
        fromNow.addEventListener('click', () => {
            working.enabled = true;
            working.base = Math.max(0, getContext().chat.length - config.keepRecent);
            working.covered = working.base;
            void persist('Story memory is on. It starts from here; older messages are sent as usual.');
        });
        readAll.addEventListener('click', () => {
            working.enabled = true;
            working.base = 0;
            working.covered = 0;
            void persist('Story memory is on. Reading the chat in the background…').then(() => maybeWrite({ force: true }));
        });
        box.append(el('div', { className: 'sm-row' }, [fromNow, readAll]));
        root.append(box);
        box.scrollIntoView({ behavior: 'smooth' });
    }

    const inputs = { now: {}, chapters: new Map(), arcs: new Map(), facts: new Map(), boxes: [] };

    function boxEditor(box) {
        const name = textInput(box.name, 'Character name');
        const parts = {};
        for (const [key] of BOX_PARTS) {
            parts[key] = textArea((box[key] || []).join('\n'), 2);
        }
        const locked = el('input', { type: 'checkbox', checked: Boolean(box.locked) });
        inputs.boxes.push({ box, name, parts, locked });
        const remove = el('button', { type: 'button', className: 'menu_button sm-small', textContent: 'Delete' });
        remove.addEventListener('click', () => {
            collect();
            working.cast = working.cast.filter(b => b !== box);
            render();
        });
        const copy = el('button', { type: 'button', className: 'menu_button sm-small', textContent: 'Copy' });
        copy.addEventListener('click', () => {
            collect();
            if (box.name) void copyText(boxMarkdown(box));
        });
        return el('div', { className: 'sm-item' }, [
            el('div', { className: 'sm-item-head' }, [
                el('label', { className: 'sm-lock' }, [locked, el('span', { textContent: 'Locked (the AI never changes it)' })]),
                el('div', { className: 'sm-row' }, [copy, remove]),
            ]),
            field('Character', name),
            ...BOX_PARTS.map(([key, label]) => field(`${label} (one per line)`, parts[key])),
        ]);
    }

    function renderBoxes() {
        inputs.boxes = [];
        const list = el('div');
        working.cast.forEach(box => list.append(boxEditor(box)));
        if (!working.cast.length) list.append(el('p', { className: 'sm-empty', textContent: 'No knowledge boxes yet. They are written with the next chapter.' }));
        const add = el('button', { type: 'button', className: 'menu_button', textContent: 'Add a character' });
        add.addEventListener('click', () => {
            collect();
            working.cast.push({ name: '', locked: true });
            openSections.add('boxes');
            render();
        });
        const copyAll = el('button', { type: 'button', className: 'menu_button sm-primary', textContent: 'Copy all boxes' });
        copyAll.addEventListener('click', () => {
            collect();
            const boxes = working.cast.filter(box => box.name);
            if (boxes.length) void copyText(boxesMarkdown(working, boxes));
        });
        const top = working.cast.length ? el('div', { className: 'sm-row' }, [copyAll]) : null;
        return section('boxes', `Knowledge boxes (${working.cast.length})`, [top, list, add].filter(Boolean));
    }

    function renderNow() {
        const now = working.now || {};
        inputs.now = {
            place: textInput(now.place, 'Where'),
            time: textInput(now.time, 'When'),
            present: textInput(Array.isArray(now.present) ? now.present.join(', ') : now.present, 'Who is there'),
            mood: textArea(now.mood, 2),
            threads: textArea((now.threads || []).join('\n'), 3),
        };
        return section('now', 'Right now', [
            field('Place', inputs.now.place),
            field('Time', inputs.now.time),
            field('Present', inputs.now.present),
            field('Mood between characters', inputs.now.mood),
            field('Open threads (one per line)', inputs.now.threads),
        ]);
    }

    function itemEditor(item, map, kind) {
        const label = textInput(item.label);
        const text = textArea(item.text, 4);
        map.set(item.id, { item, label, text });
        const remove = el('button', { type: 'button', className: 'menu_button sm-small', textContent: 'Delete' });
        remove.addEventListener('click', () => {
            if (kind === 'arc') working.arcs = working.arcs.filter(a => a.id !== item.id);
            else working.chapters = working.chapters.filter(c => c.id !== item.id);
            collect();
            render();
        });
        const heading = kind === 'arc' ? 'Arc' : `Chapter ${item.n}`;
        return el('div', { className: 'sm-item' }, [
            el('div', { className: 'sm-item-head' }, [el('b', { textContent: heading }), remove]),
            field('Label', label),
            field('What changed', text),
        ]);
    }

    function renderChapters() {
        inputs.chapters.clear();
        inputs.arcs.clear();
        const list = el('div');
        working.arcs.forEach(arc => list.append(itemEditor(arc, inputs.arcs, 'arc')));
        working.chapters.forEach(ch => list.append(itemEditor(ch, inputs.chapters, 'chapter')));
        if (!working.arcs.length && !working.chapters.length) {
            list.append(el('p', { className: 'sm-empty', textContent: 'No chapters yet.' }));
        }
        return section('chapters', `Story so far (${working.arcs.length + working.chapters.length})`, [list]);
    }

    function factEditor(fact) {
        const weight = el('select', { className: 'text_pole' }, ['key', 'important', 'everyday'].map(w => el('option', { value: w, textContent: w, selected: fact.weight === w })));
        const about = textInput(fact.about, 'name or world');
        const knows = textInput(fact.knows === 'all' ? 'all' : (fact.knows || []).join(', '), 'all, or names separated by commas');
        const text = textArea(fact.text, 2);
        const locked = el('input', { type: 'checkbox', checked: Boolean(fact.locked || fact.pinned) });
        inputs.facts.set(fact.id, { fact, weight, about, knows, text, locked });
        const remove = el('button', { type: 'button', className: 'menu_button sm-small', textContent: 'Delete' });
        remove.addEventListener('click', () => {
            collect();
            working.facts = working.facts.filter(f => f.id !== fact.id);
            render();
        });
        return el('div', { className: 'sm-item' }, [
            el('div', { className: 'sm-item-head' }, [
                el('label', { className: 'sm-lock' }, [locked, el('span', { textContent: 'Locked (the AI never changes it)' })]),
                remove,
            ]),
            field('Fact', text),
            el('div', { className: 'sm-grid' }, [field('About', about), field('Known by', knows), field('Weight', weight)]),
        ]);
    }

    function renderFacts() {
        inputs.facts.clear();
        const list = el('div');
        working.facts.forEach(fact => list.append(factEditor(fact)));
        if (!working.facts.length) list.append(el('p', { className: 'sm-empty', textContent: 'No facts yet.' }));
        const add = el('button', { type: 'button', className: 'menu_button', textContent: 'Add a fact' });
        add.addEventListener('click', () => {
            collect();
            working.facts.push({ id: `f${working.next.fact++}`, text: '', about: '', knows: 'all', weight: 'important', locked: true, at: Date.now() });
            render();
        });
        return section('facts', `Facts and who knows them (${working.facts.length})`, [list, add]);
    }

    function numberInput(value, min, max) {
        return el('input', { type: 'number', className: 'text_pole', value: String(value), min: String(min), max: String(max) });
    }

    let settingInputs = {};
    function renderSettings() {
        settingInputs = {
            keepRecent: numberInput(config.keepRecent, 6, 200),
            chapterEvery: numberInput(config.chapterEvery, 4, 100),
            budgetTokens: numberInput(config.budgetTokens, 300, 8000),
            toasts: el('input', { type: 'checkbox', checked: Boolean(config.toasts) }),
        };
        return section('settings', 'Settings (all chats)', [
            field('Recent messages kept word for word', settingInputs.keepRecent),
            field('Write a chapter every … messages', settingInputs.chapterEvery),
            field('Memory size in the prompt (tokens)', settingInputs.budgetTokens),
            el('label', { className: 'sm-lock' }, [settingInputs.toasts, el('span', { textContent: 'Show a small note when a chapter is written' })]),
        ]);
    }

    function collect() {
        if (inputs.now.place) {
            const threads = inputs.now.threads.value.split('\n').map(s => s.trim()).filter(Boolean);
            const present = inputs.now.present.value.split(',').map(s => s.trim()).filter(Boolean);
            const any = inputs.now.place.value || inputs.now.time.value || present.length || inputs.now.mood.value || threads.length;
            working.now = any ? {
                place: inputs.now.place.value.trim(),
                time: inputs.now.time.value.trim(),
                present,
                mood: inputs.now.mood.value.trim(),
                threads,
            } : null;
        }
        for (const map of [inputs.arcs, inputs.chapters]) {
            for (const { item, label, text } of map.values()) {
                if (item.label !== label.value || item.text !== text.value) item.edited = true;
                item.label = label.value.trim();
                item.text = text.value.trim();
            }
        }
        for (const { fact, weight, about, knows, text, locked } of inputs.facts.values()) {
            fact.weight = weight.value;
            fact.about = about.value.trim();
            fact.knows = normalizeKnows(knows.value.trim().toLowerCase() === 'all' ? 'all' : knows.value);
            fact.text = text.value.trim();
            fact.locked = locked.checked;
            delete fact.pinned;
        }
        working.facts = working.facts.filter(f => f.text);
        for (const { box, name, parts, locked } of inputs.boxes) {
            box.name = name.value.trim();
            for (const [key] of BOX_PARTS) box[key] = parts[key].value.split('\n').map(line => line.trim()).filter(Boolean);
            box.locked = locked.checked;
        }
        working.cast = working.cast.filter(box => box.name);
        if (settingInputs.keepRecent) {
            const clamp = (input, lo, hi, fallback) => Math.min(hi, Math.max(lo, Math.round(Number(input.value) || fallback)));
            config.keepRecent = clamp(settingInputs.keepRecent, 6, 200, DEFAULT_SETTINGS.keepRecent);
            config.chapterEvery = clamp(settingInputs.chapterEvery, 4, 100, DEFAULT_SETTINGS.chapterEvery);
            config.budgetTokens = clamp(settingInputs.budgetTokens, 300, 8000, DEFAULT_SETTINGS.budgetTokens);
            config.toasts = settingInputs.toasts.checked;
            saveSettingsDebounced();
        }
    }

    async function persist(message, rerender = true) {
        collect();
        if (state.chatKey !== chatKey) {
            toastr.warning('The chat changed; reopen Story Memory.', 'Story Memory');
            return;
        }
        try {
            await saveRecord(handle, working);
            state.record = structuredClone(working);
            updatePrompt();
            if (message) toastr.success(message, 'Story Memory', { timeOut: 2500 });
        } catch (error) {
            toastr.error(`Could not save: ${error?.message || error}`, 'Story Memory');
        }
        if (rerender) render();
    }

    render();
    await popup.show();
}

// ---------------------------------------------------------------------------

function addMenuItem() {
    if (document.getElementById('story_memory_menu_item')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = 'story_memory_menu_item';
    item.className = 'list-group-item flex-container flexGap5';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.append(
        Object.assign(document.createElement('div'), { className: 'fa-fw fa-solid fa-book-open extensionsMenuExtensionButton' }),
        Object.assign(document.createElement('span'), { textContent: 'Story Memory' }),
    );
    item.addEventListener('click', () => void openNotes());
    menu.append(item);
}

export async function init() {
    settings();
    addMenuItem();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        state.chatKey = null;
        void ensureLoaded();
    });
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(() => void maybeWrite(), 400);
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        const record = state.record;
        const length = getContext().chat.length;
        if (record && record.covered > length) {
            record.covered = Math.max(record.base, length);
        }
    });
    void ensureLoaded();
}
