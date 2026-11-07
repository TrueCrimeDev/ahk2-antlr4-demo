import { fuzzyMatch, highlightHits } from './symbolsview';
import { el, kbd } from './tooltip';

export type CommandGroup = 'symbol' | 'example' | 'action';

export interface Command {
    id: string;
    group: CommandGroup;
    title: string;
    /** Muted text after the title (line number, example group, ...). */
    detail?: string;
    /** Extra words that match but aren't shown. */
    keywords?: string;
    badge?: HTMLElement;
    keys?: string;
    run(): void;
}

const PREFIX: Record<string, CommandGroup> = { '>': 'action', '@': 'symbol', '#': 'example' };
const GROUP_LABEL: Record<CommandGroup, string> = { symbol: 'Go to', example: 'Examples', action: 'Commands' };
const MAX = 60;

/** Ctrl+K: one box to jump to a symbol, open an example or run a command. */
export class Palette {
    private backdrop: HTMLElement;
    private input: HTMLInputElement;
    private list: HTMLElement;
    private shown: Command[] = [];
    private index = 0;
    private commands: Command[] = [];
    private returnFocus: HTMLElement | null = null;

    constructor(private provider: () => Command[]) {
        this.input = el('input', 'palette-input');
        this.input.type = 'text';
        this.input.spellcheck = false;
        this.input.placeholder = 'Jump to a symbol, open an example, or run a command';
        this.input.setAttribute('aria-label', 'Command palette');
        this.input.setAttribute('role', 'combobox');
        this.input.setAttribute('aria-expanded', 'true');
        this.input.setAttribute('aria-controls', 'palette-list');
        this.list = el('ul', 'palette-list');
        this.list.id = 'palette-list';
        this.list.setAttribute('role', 'listbox');
        const foot = el('div', 'palette-foot',
            el('span', '', kbd('↑'), kbd('↓'), ' move'), el('span', '', kbd('Enter'), ' run'), el('span', '', kbd('Esc'), ' close'),
            el('span', 'palette-prefixes', el('code', '', '>'), ' commands  ', el('code', '', '@'), ' symbols  ', el('code', '', '#'), ' examples'));
        const panel = el('div', 'palette', this.input, this.list, foot);
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Command palette');
        this.backdrop = el('div', 'palette-backdrop', panel);
        this.backdrop.hidden = true;
        document.body.append(this.backdrop);
        this.backdrop.addEventListener('pointerdown', e => { if (e.target === this.backdrop) this.close(); });
        this.input.addEventListener('input', () => { this.index = 0; this.filter(); });
        this.input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
            else if (e.key === 'PageDown') { e.preventDefault(); this.move(8); }
            else if (e.key === 'PageUp') { e.preventDefault(); this.move(-8); }
            else if (e.key === 'Enter') { e.preventDefault(); this.run(this.shown[this.index]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
            else if (e.key === 'Tab') e.preventDefault();
        });
    }

    get isOpen() { return !this.backdrop.hidden; }

    open(prefix = '') {
        this.returnFocus = document.activeElement as HTMLElement | null;
        this.commands = this.provider();
        this.backdrop.hidden = false;
        this.input.value = prefix;
        this.index = 0;
        this.filter();
        this.input.focus();
        this.input.setSelectionRange(prefix.length, prefix.length);
    }

    close() {
        if (!this.isOpen) return;
        this.backdrop.hidden = true;
        this.returnFocus?.focus?.();
    }

    toggle(prefix = '') { if (this.isOpen) this.close(); else this.open(prefix); }

    private run(c: Command | undefined) {
        if (!c) return;
        this.close();
        c.run();
    }

    private move(d: number) {
        if (!this.shown.length) return;
        this.index = Math.max(0, Math.min(this.shown.length - 1, this.index + d));
        this.paintIndex();
    }

    private paintIndex() {
        this.list.querySelectorAll('.palette-item').forEach((li, i) => {
            li.classList.toggle('active', i === this.index);
            li.setAttribute('aria-selected', String(i === this.index));
            if (i === this.index) { li.scrollIntoView({ block: 'nearest' }); this.input.setAttribute('aria-activedescendant', li.id); }
        });
    }

    private filter() {
        let q = this.input.value;
        let only: CommandGroup | null = null;
        if (PREFIX[q[0]]) { only = PREFIX[q[0]]; q = q.slice(1); }
        q = q.trim();
        const scored: { c: Command; score: number; hits: number[] }[] = [];
        for (const c of this.commands) {
            if (only && c.group !== only) continue;
            const m = fuzzyMatch(q, c.title);
            const k = !m && c.keywords ? fuzzyMatch(q, c.keywords) : null;
            if (!m && !k) continue;
            // Without a query, keep the provider's order: commands first, then symbols, then examples.
            const groupBoost = q ? (c.group === 'symbol' ? 1.5 : c.group === 'action' ? 1 : 0) : 0;
            scored.push({ c, score: (m?.score ?? (k!.score - 3)) + groupBoost, hits: m?.hits ?? [] });
        }
        if (q) scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, MAX);
        this.shown = top.map(s => s.c);
        if (!top.length) {
            this.list.replaceChildren(el('li', 'palette-empty', q ? `Nothing matches "${q}".` : 'Nothing here.'));
            return;
        }
        let lastGroup: CommandGroup | null = null;
        const items: HTMLElement[] = [];
        top.forEach(({ c, hits }, i) => {
            if (!q && c.group !== lastGroup) { items.push(el('li', 'palette-group', GROUP_LABEL[c.group])); lastGroup = c.group; }
            const li = el('li', 'palette-item');
            li.id = `palette-item-${i}`;
            li.setAttribute('role', 'option');
            li.append(c.badge ?? el('span', `palette-badge group-${c.group}`, c.group === 'action' ? '›' : '#'),
                el('span', 'palette-title', ...highlightHits(c.title, hits)),
                c.detail ? el('span', 'palette-detail', c.detail) : '',
                c.keys ? kbd(c.keys) : '');
            li.onpointermove = () => { if (this.index !== i) { this.index = i; this.paintIndex(); } };
            li.onclick = () => this.run(c);
            items.push(li);
        });
        this.list.replaceChildren(...items);
        this.index = Math.min(this.index, top.length - 1);
        this.paintIndex();
    }
}
