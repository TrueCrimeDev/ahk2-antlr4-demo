import type { SrcRange } from './parse';
import type { Evaluation, Step, StepKind } from './evaluate';
import { highlightSnippet } from './highlight';
import { el, severityIcon } from './tooltip';

const KIND_ICON: Record<StepKind, string> = {
    read: 'R', write: '=', compute: '∑', call: 'ƒ', get: '.', set: '.=', test: '?', build: '[ ]', create: '+',
};
const KIND_NAME: Record<StepKind, string> = {
    read: 'Read a variable', write: 'Change a variable', compute: 'Compute', call: 'Call', get: 'Get a property or item',
    set: 'Set a property or item', test: 'Test', build: 'Build a value', create: 'Create',
};

export interface StepsCallbacks {
    /** Show a step in the editor (null clears). */
    onStep(step: Step | null, expr: SrcRange | null): void;
}

/** Steps through an expression in the order AutoHotkey runs it. */
export class StepsView {
    private head: HTMLElement;
    private exprBox: HTMLElement;
    private pos: HTMLElement;
    private prev: HTMLButtonElement;
    private next: HTMLButtonElement;
    private list: HTMLOListElement;
    private result: HTMLElement;
    private ev: Evaluation | null = null;
    private index = 0;
    private key = '';
    active = false;

    constructor(private host: HTMLElement, private cb: StepsCallbacks) {
        this.exprBox = el('div', 'steps-expr tip-code cm-s-ahk-dark');
        this.prev = el('button', '', '‹ Back');
        this.prev.title = 'Previous step (←)';
        this.next = el('button', 'primary', 'Next ›');
        this.next.title = 'Next step (→)';
        this.pos = el('span', 'steps-pos');
        const restart = el('button', '', 'Start over');
        restart.onclick = () => this.go(0);
        this.prev.onclick = () => this.go(this.index - 1);
        this.next.onclick = () => this.go(this.index + 1);
        this.head = el('div', 'panel-head steps-head', this.exprBox, el('div', 'steps-nav', this.prev, this.pos, this.next, restart));
        this.list = el('ol', 'steps-list');
        this.result = el('p', 'steps-result');
        const note = el('details', 'steps-note',
            el('summary', '', 'How AutoHotkey orders an expression'),
            el('ul', '',
                el('li', '', 'Operators, calls, indexing and property gets run left to right, as soon as their operands are ready.'),
                el('li', '', 'A plain variable is not read where it appears. It is read when the operator, call or literal that uses it runs, so ', el('code', '', 'x + (x := 5)'), ' adds 5 + 5.'),
                el('li', '', 'An assignment, ', el('code', '', '++x'), ' and ', el('code', '', '(a, b)'), ' give the variable itself, read later the same way: ', el('code', '', '(x := 1) + (x := 2)'), ' is 4. ', el('code', '', 'x++'), ' gives the old value.'),
                el('li', '', 'Steps marked with a warning read a variable that changed after it appeared, which is usually a bug.'),
            ));
        host.append(this.head, this.list, this.result, note);
        host.tabIndex = -1;
        host.addEventListener('keydown', e => {
            if ((e.target as HTMLElement).closest('input, textarea, summary')) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); this.go(this.index + 1); }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this.go(this.index - 1); }
            if (e.key === 'Home') { e.preventDefault(); this.go(0); }
            if (e.key === 'End' && this.ev) { e.preventDefault(); this.go(this.ev.steps.length - 1); }
        });
        this.render();
    }

    /** Show an expression. The same expression text keeps its place. */
    setEvaluation(ev: Evaluation | null) {
        const key = ev ? `${ev.range.from.line}:${ev.range.from.col}|${ev.code}` : '';
        if (key !== this.key) this.index = 0;
        this.key = key;
        this.ev = ev;
        if (ev) this.index = Math.min(this.index, Math.max(0, ev.steps.length - 1));
        this.render();
    }

    setActive(active: boolean) {
        this.active = active;
        this.emit();
    }

    go(i: number) {
        if (!this.ev?.steps.length) return;
        this.index = Math.max(0, Math.min(this.ev.steps.length - 1, i));
        this.list.querySelectorAll('.step').forEach((r, k) => {
            r.classList.toggle('current', k === this.index);
            r.classList.toggle('done', k < this.index);
            r.setAttribute('aria-current', String(k === this.index));
        });
        (this.list.children[this.index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
        this.renderNav();
        this.emit();
    }

    private emit() {
        const s = this.ev?.steps[this.index] ?? null;
        this.cb.onStep(this.active ? s : null, this.active && this.ev ? this.ev.range : null);
    }

    private renderNav() {
        const n = this.ev?.steps.length ?? 0;
        this.pos.textContent = n ? `Step ${this.index + 1} of ${n}` : '';
        this.prev.disabled = !n || this.index === 0;
        this.next.disabled = !n || this.index >= n - 1;
    }

    private render() {
        const ev = this.ev;
        this.head.hidden = !ev;
        if (!ev) {
            this.list.replaceChildren(el('li', 'panel-empty', 'Put the cursor in an expression, such as Pair(x, x := 2), to see the order AutoHotkey runs it in.'));
            this.result.hidden = true;
            this.renderNav();
            this.emit();
            return;
        }
        const code = ev.code.split('\n');
        this.exprBox.innerHTML = highlightSnippet(code.length > 1 ? code[0] + ' …' : code[0]);
        if (!ev.steps.length) {
            this.list.replaceChildren(el('li', 'panel-empty', 'This is a single value, so there is nothing to step through.'));
        } else {
            this.list.replaceChildren(...ev.steps.map((s, i) => {
                const li = el('li', `step kind-${s.kind}${s.warn ? ' warn' : ''}`);
                li.style.setProperty('--depth', String(s.depth));
                const icon = el('span', `step-icon kind-${s.kind}`, KIND_ICON[s.kind]);
                icon.title = KIND_NAME[s.kind];
                const snippet = el('code', 'step-code');
                snippet.innerHTML = highlightSnippet(s.code);
                const body = el('div', 'step-body', el('div', 'step-title', el('span', 'step-num', `${i + 1}.`), s.title, s.when ? el('span', 'step-when', s.when) : null), snippet);
                if (s.detail) body.append(el('div', 'step-detail', s.detail));
                if (s.warn) body.append(el('div', 'step-warn', severityIcon('warning'), s.warn));
                li.append(icon, body);
                li.onclick = () => this.go(i);
                return li;
            }));
        }
        this.result.textContent = ev.result;
        this.result.hidden = !ev.result;
        this.go(this.index);
        this.renderNav();
    }
}
