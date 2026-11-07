import type { SrcPos, SrcRange } from './parse';
import type { SymbolItem, SymbolKind } from './symbols';
import { el } from './tooltip';

export const KIND_BADGES: Record<SymbolKind, { letter: string; label: string }> = {
    class: { letter: 'C', label: 'Class' },
    method: { letter: 'M', label: 'Method' },
    property: { letter: 'P', label: 'Property' },
    field: { letter: 'F', label: 'Field' },
    function: { letter: 'ƒ', label: 'Function' },
    hotkey: { letter: 'H', label: 'Hotkey' },
    hotstring: { letter: 'S', label: 'Hotstring' },
    variable: { letter: 'V', label: 'Global variable' },
};

export function kindBadge(kind: SymbolKind): HTMLElement {
    const b = el('span', `kind-badge kind-${kind}`, KIND_BADGES[kind].letter);
    b.title = KIND_BADGES[kind].label;
    return b;
}

/** Subsequence match of `query` in `text`, scored so word starts and runs rank higher. */
export function fuzzyMatch(query: string, text: string): { score: number; hits: number[] } | null {
    if (!query) return { score: 0, hits: [] };
    const q = query.toLowerCase(), t = text.toLowerCase();
    const hits: number[] = [];
    let score = 0, ti = 0, prev = -2;
    for (const ch of q) {
        if (ch === ' ') continue;
        const at = t.indexOf(ch, ti);
        if (at < 0) return null;
        const boundary = at === 0 || /[^a-z0-9]/i.test(text[at - 1]) || (text[at] !== t[at] && text[at - 1] === t[at - 1]);
        score += 1 + (at === prev + 1 ? 3 : 0) + (boundary ? 4 : 0) - Math.min(at - ti, 6) * 0.15;
        hits.push(at);
        prev = at;
        ti = at + 1;
    }
    if (t.startsWith(q)) score += 6;
    if (t === q) score += 10;
    return { score: score - text.length * 0.02, hits };
}

/** Text with matched characters wrapped in <mark>. */
export function highlightHits(text: string, hits: number[]): (Node | string)[] {
    if (!hits.length) return [text];
    const set = new Set(hits);
    const out: (Node | string)[] = [];
    let buf = '', inMark = false;
    const flush = () => { if (buf) out.push(inMark ? el('mark', '', buf) : buf); buf = ''; };
    [...text].forEach((ch, i) => {
        const m = set.has(i);
        if (m !== inMark) { flush(); inMark = m; }
        buf += ch;
    });
    flush();
    return out;
}

export interface SymbolsCallbacks {
    onSelect(item: SymbolItem): void;
}

interface Row { item: SymbolItem; depth: number; key: string; parent: Row | null; el: HTMLElement; li: HTMLElement }

const contains = (r: SrcRange, p: SrcPos) =>
    (r.from.line < p.line || r.from.line === p.line && r.from.col <= p.col) && (p.line < r.to.line || p.line === r.to.line && p.col <= r.to.col);

/** Declarations as a filterable tree: classes with their members, functions, hotkeys, globals. */
export class SymbolsView {
    private filter: HTMLInputElement;
    private summary: HTMLElement;
    private list: HTMLElement;
    private items: SymbolItem[] = [];
    private rows: Row[] = [];
    private closed = new Set<string>();
    private cursor: SrcPos | null = null;

    constructor(host: HTMLElement, private cb: SymbolsCallbacks) {
        this.filter = el('input', 'panel-filter');
        this.filter.type = 'search';
        this.filter.placeholder = 'Filter symbols';
        this.filter.setAttribute('aria-label', 'Filter symbols');
        this.summary = el('div', 'panel-summary');
        this.list = el('ul', 'sym-list');
        this.list.setAttribute('role', 'tree');
        host.append(el('div', 'panel-head', this.filter, this.summary), this.list);
        this.filter.addEventListener('input', () => this.render());
        this.filter.addEventListener('keydown', e => {
            if (e.key === 'Enter') { const first = this.rows.find(r => !r.li.hidden); if (first) this.cb.onSelect(first.item); }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.focusRow(0, 1); }
            if (e.key === 'Escape' && this.filter.value) { e.stopPropagation(); this.filter.value = ''; this.render(); }
        });
        this.list.addEventListener('keydown', e => {
            const i = this.rows.findIndex(r => r.el === document.activeElement);
            if (i < 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); this.focusRow(i + 1, 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (!this.focusRow(i - 1, -1)) this.filter.focus(); }
            else if (e.key === 'Enter') { e.preventDefault(); this.cb.onSelect(this.rows[i].item); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.setOpen(this.rows[i], e.key === 'ArrowRight'); }
        });
    }

    setSymbols(items: SymbolItem[]) {
        this.items = items;
        this.render();
    }

    private focusRow(start: number, dir: number): boolean {
        for (let i = start; i >= 0 && i < this.rows.length; i += dir) {
            if (!this.rows[i].li.hidden && this.isShown(this.rows[i])) { this.rows[i].el.focus(); return true; }
        }
        return false;
    }

    private isShown(r: Row): boolean {
        for (let p = r.parent; p; p = p.parent) if (p.li.classList.contains('closed')) return false;
        return true;
    }

    private setOpen(r: Row, open: boolean) {
        if (!r.item.children.length) return;
        r.li.classList.toggle('closed', !open);
        r.el.setAttribute('aria-expanded', String(open));
        if (open) this.closed.delete(r.key); else this.closed.add(r.key);
    }

    private render() {
        const q = this.filter.value.trim();
        this.rows = [];
        const counts = new Map<SymbolKind, number>();
        const make = (item: SymbolItem, depth: number, parent: Row | null, prefix: string): { li: HTMLElement; visible: boolean } => {
            counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
            const key = `${prefix}${item.kind}:${item.name}`;
            const li = el('li', 'sym-item');
            const row = el('div', 'sym-row');
            row.tabIndex = -1;
            row.setAttribute('role', 'treeitem');
            row.style.paddingLeft = `${8 + depth * 16}px`;
            const twisty = el('span', 'twisty');
            const qualified = parent && (item.kind === 'method' || item.kind === 'property' || item.kind === 'field') ? `${parent.item.name}.${item.name}` : item.name;
            const m = q ? fuzzyMatch(q, item.name) ?? fuzzyMatch(q, qualified) : null;
            const name = el('span', 'sym-name', ...(m && fuzzyMatch(q, item.name) ? highlightHits(item.name, m.hits) : [item.name]));
            row.append(twisty, kindBadge(item.kind), name);
            if (item.isStatic) row.append(el('span', 'sym-tag', 'static'));
            if (item.detail) row.append(el('span', 'sym-detail', item.detail));
            row.append(el('span', 'sym-line', String(item.range.from.line + 1)));
            row.onclick = e => {
                if ((e.target as HTMLElement).closest('.twisty') && item.children.length) {
                    const r = this.rows.find(x => x.el === row)!;
                    this.setOpen(r, r.li.classList.contains('closed'));
                    return;
                }
                this.cb.onSelect(item);
            };
            li.append(row);
            const r: Row = { item, depth, key, parent, el: row, li };
            this.rows.push(r);
            let visible = !q || !!m;
            if (item.children.length) {
                li.classList.add('has-children');
                row.setAttribute('aria-expanded', String(!this.closed.has(key)));
                if (this.closed.has(key) && !q) li.classList.add('closed');
                const ul = el('ul', 'sym-children');
                ul.setAttribute('role', 'group');
                let any = false;
                for (const c of item.children) {
                    const child = make(c, depth + 1, r, key + '/');
                    ul.append(child.li);
                    any ||= child.visible;
                }
                li.append(ul);
                if (any) visible = true;
            }
            li.hidden = !visible;
            return { li, visible };
        };
        const lis = this.items.map(i => make(i, 0, null, ''));
        if (!this.items.length) {
            this.list.replaceChildren(el('li', 'panel-empty', 'No declarations yet. Classes, functions, hotkeys, hotstrings and global variables show up here.'));
        } else if (!lis.some(l => l.visible)) {
            this.list.replaceChildren(el('li', 'panel-empty', `Nothing matches "${q}".`));
        } else {
            this.list.replaceChildren(...lis.map(l => l.li));
        }
        const order: SymbolKind[] = ['class', 'method', 'property', 'field', 'function', 'hotkey', 'hotstring', 'variable'];
        const plural: Record<SymbolKind, string> = { class: 'classes', method: 'methods', property: 'properties', field: 'fields', function: 'functions', hotkey: 'hotkeys', hotstring: 'hotstrings', variable: 'globals' };
        this.summary.textContent = order.filter(k => counts.get(k)).map(k => `${counts.get(k)} ${counts.get(k) === 1 ? (k === 'variable' ? 'global' : k) : plural[k]}`).join(' · ');
        if (this.rows.length) this.rows[0].el.tabIndex = 0;
        this.markCursor(this.cursor);
    }

    /** Highlight the innermost declaration around the cursor. */
    markCursor(pos: SrcPos | null) {
        this.cursor = pos;
        let best: Row | null = null;
        for (const r of this.rows) {
            r.el.classList.remove('cur');
            if (pos && contains(r.item.full, pos) && (!best || r.depth >= best.depth)) best = r;
        }
        best?.el.classList.add('cur');
    }

    focusFilter() { this.filter.focus(); this.filter.select(); }
}
