import type * as Antlr4 from 'antlr4ng';
import type { SrcRange, TextEdit } from './parse';
import { compilePattern, findMatches, fillTemplate, Match } from './search';
import { highlightSnippet } from './highlight';
import { el } from './tooltip';

export interface SearchCallbacks {
    /** The current tree and the code it was parsed from, or null while the code doesn't parse. */
    source(): { tree: Antlr4.ParseTree; code: string } | null;
    onSelect(range: SrcRange): void;
    onMatches(ranges: SrcRange[], current: number): void;
    onReplace(edits: TextEdit[]): void;
}

const EXAMPLES: [string, string, string][] = [
    ['SetTimer($fn, $ms)', 'SetTimer($fn, -$ms)', 'Timers, in call or command form'],
    ['$x := $x + 1', '$x += 1', 'Increments written the long way'],
    ['MsgBox($$args)', 'ToolTip($$args)', 'Every MsgBox, with any arguments'],
    ['$obj.OnEvent($event, $handler)', '', 'GUI event handlers'],
    ['$f($a, $a := $b)', '', 'A call that changes an argument it already passed'],
    ['$a ? $b : $c', '', 'Every ternary'],
];

const store = {
    get(k: string) { try { return localStorage.getItem('ahk-ast:ssr-' + k) ?? ''; } catch { return ''; } },
    set(k: string, v: string) { try { localStorage.setItem('ahk-ast:ssr-' + k, v); } catch { /* storage unavailable */ } },
};

const firstLine = (s: string) => {
    const lines = s.split('\n');
    const line = lines[0].length > 90 ? lines[0].slice(0, 89) + '…' : lines[0];
    return lines.length > 1 ? `${line} …` : line;
};

/** Structural search and replace: patterns are code with $placeholders, matched against the tree. */
export class SearchView {
    private pattern: HTMLInputElement;
    private replace: HTMLInputElement;
    private count: HTMLElement;
    private error: HTMLElement;
    private results: HTMLOListElement;
    private replaceAll: HTMLButtonElement;
    private matches: Match[] = [];
    private current = -1;
    private timer: number | undefined;
    active = false;

    constructor(host: HTMLElement, private cb: SearchCallbacks) {
        this.pattern = el('input', 'ssr-input');
        this.pattern.placeholder = 'Find code, such as SetTimer($fn, $ms)';
        this.pattern.setAttribute('aria-label', 'Search pattern');
        this.pattern.spellcheck = false;
        this.replace = el('input', 'ssr-input');
        this.replace.placeholder = 'Replace with (optional), such as SetTimer($fn, -$ms)';
        this.replace.setAttribute('aria-label', 'Replacement');
        this.replace.spellcheck = false;
        this.pattern.value = store.get('pattern');
        this.replace.value = store.get('replace');
        this.count = el('span', 'ssr-count');
        this.replaceAll = el('button', 'primary', 'Replace all');
        this.replaceAll.title = 'Replace every match; undo it with (Ctrl+Z)';
        this.replaceAll.onclick = () => this.doReplace(this.matches);
        this.error = el('p', 'ssr-error');
        this.error.hidden = true;
        this.results = el('ol', 'ssr-results');
        const chips = el('div', 'ssr-chips', el('span', 'ssr-chips-label', 'Try'));
        for (const [p, r, why] of EXAMPLES) {
            const chip = el('button', 'chip', p);
            chip.title = why + (r ? `, replaced with ${r}` : '');
            chip.onclick = () => { this.pattern.value = p; this.replace.value = r; this.changed(true); this.pattern.focus(); };
            chips.append(chip);
        }
        const help = el('details', 'ssr-help',
            el('summary', '', 'How patterns work'),
            el('ul', '',
                el('li', '', el('code', '', '$name'), ' matches any one expression. Using the same name twice means both places must hold the same code.'),
                el('li', '', el('code', '', '$$name'), ' at the end of an argument list matches the rest of the arguments, even none.'),
                el('li', '', 'Matching follows the parse tree, so spacing, line breaks, comments and the letter case of names don\'t matter. A call pattern also matches command syntax: ', el('code', '', 'MsgBox($m)'), ' finds ', el('code', '', 'MsgBox "hi"'), '.'),
                el('li', '', 'In the replacement, ', el('code', '', '$name'), ' puts back the code it matched.'),
            ));
        const form = el('div', 'ssr-form',
            el('label', 'ssr-label', 'Find'), this.pattern,
            el('label', 'ssr-label', 'Replace'), this.replace,
            el('div', 'ssr-actions', this.count, this.replaceAll));
        host.append(el('div', 'panel-head ssr-head', form, chips), this.error, this.results, help);
        for (const input of [this.pattern, this.replace]) {
            input.addEventListener('input', () => this.changed(false));
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
                if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; this.changed(true); }
            });
        }
    }

    private changed(now: boolean) {
        store.set('pattern', this.pattern.value);
        store.set('replace', this.replace.value);
        clearTimeout(this.timer);
        if (now) this.refresh(); else this.timer = window.setTimeout(() => this.refresh(), 160);
    }

    focus() { this.pattern.focus(); this.pattern.select(); }

    setPattern(p: string) { this.pattern.value = p; this.changed(true); }

    /** Run the search again (after the code changed or was parsed). */
    refresh() {
        const text = this.pattern.value.trim();
        this.matches = [];
        this.current = -1;
        this.error.hidden = true;
        if (!text) {
            this.render();
            return;
        }
        const pat = compilePattern(text);
        const src = this.cb.source();
        if (typeof pat === 'string') {
            this.error.textContent = pat;
            this.error.hidden = false;
        } else if (src) {
            this.matches = findMatches(src.tree, pat, src.code);
        }
        this.render();
    }

    private render() {
        const n = this.matches.length;
        const hasPattern = !!this.pattern.value.trim();
        this.count.textContent = !hasPattern ? '' : n ? `${n} match${n === 1 ? '' : 'es'}` : 'no matches';
        const template = this.replace.value;
        this.replaceAll.disabled = !n || !template.length;
        const showReplace = template.length > 0;
        if (!hasPattern) {
            this.results.replaceChildren(el('li', 'panel-empty', 'Search by code shape instead of text. Pick an example above, or type a pattern with $ placeholders.'));
        } else if (!n) {
            this.results.replaceChildren(this.error.hidden ? el('li', 'panel-empty', 'No code has that shape.') : '');
        } else {
            this.results.replaceChildren(...this.matches.map((m, i) => {
                const li = el('li', 'ssr-result');
                li.tabIndex = 0;
                const line = el('span', 'ssr-line', String(m.range.from.line + 1));
                const code = el('code', 'ssr-code');
                code.innerHTML = highlightSnippet(firstLine(this.textOf(m)));
                const body = el('div', 'ssr-body', code);
                if (m.bindings.size) {
                    body.append(el('div', 'ssr-bindings', ...[...m.bindings].map(([k, v]) =>
                        el('span', 'ssr-binding', el('b', '', k), ' ', v.text ? firstLine(v.text) : el('i', '', 'nothing')))));
                }
                if (showReplace) {
                    const after = el('code', 'ssr-code ssr-after');
                    after.innerHTML = highlightSnippet(firstLine(fillTemplate(template, m)));
                    body.append(el('div', 'ssr-preview', el('span', 'ssr-arrow', '→'), after));
                }
                li.append(line, body);
                if (showReplace) {
                    const one = el('button', 'fix-btn', 'Replace');
                    one.onclick = e => { e.stopPropagation(); this.doReplace([m]); };
                    li.append(one);
                }
                li.onclick = () => this.pick(i);
                li.onkeydown = e => { if (e.key === 'Enter') this.pick(i); };
                return li;
            }));
        }
        this.emit();
    }

    private textOf(m: Match): string {
        const src = this.cb.source();
        if (!src) return '';
        const lines = src.code.split('\n');
        const out: string[] = [];
        for (let l = m.range.from.line; l <= m.range.to.line; l++) {
            const chars = [...(lines[l] ?? '')];
            out.push(chars.slice(l === m.range.from.line ? m.range.from.col : 0, l === m.range.to.line ? m.range.to.col : chars.length).join(''));
        }
        return out.join('\n');
    }

    private pick(i: number) {
        this.current = i;
        this.results.querySelectorAll('.ssr-result').forEach((r, k) => r.classList.toggle('current', k === i));
        this.cb.onSelect(this.matches[i].range);
        this.emit();
    }

    private step(dir: number) {
        if (!this.matches.length) { this.refresh(); return; }
        this.pick((this.current + dir + this.matches.length) % this.matches.length);
        (this.results.children[this.current] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    }

    private emit() {
        this.cb.onMatches(this.active ? this.matches.map(m => m.range) : [], this.current);
    }

    setActive(active: boolean) {
        this.active = active;
        this.emit();
    }

    private doReplace(list: Match[]) {
        const template = this.replace.value;
        if (!list.length) return;
        this.cb.onReplace(list.map(m => ({ range: m.range, text: fillTemplate(template, m) })));
    }
}
