import Viz from 'viz.js';
import { Module, render } from 'viz.js/full.render.js';
import type { SrcRange } from './parse';
import type { CallEdge } from './symbols';
import { Tip, el } from './tooltip';
import { callsDot, KIND_LABEL, CallGraphData } from './callsdot';
export { callsDot };

export interface CallsCallbacks {
    onSelect(range: SrcRange): void;
}

/** Who calls whom, including callbacks registered with SetTimer, OnEvent, Hotkey and the like. */
export class CallsView {
    private viz = new Viz({ Module, render });
    private stage: HTMLElement;
    private summary: HTMLElement;
    private data: CallGraphData = { nodes: [], edges: [] };
    private nodeEls: SVGGElement[] = [];
    private edgeEls: { el: SVGGElement; from: number; to: number; edge: CallEdge }[] = [];
    private token = 0;
    private dirty = true;
    private card = new Tip('tip-card tip-graph');
    private currentId: string | null = null;
    svg: SVGSVGElement | null = null;

    constructor(private host: HTMLElement, private cb: CallsCallbacks) {
        this.summary = el('div', 'panel-summary calls-summary');
        const legend = el('div', 'calls-legend',
            el('span', 'lg', el('span', 'lg-box lg-function'), 'function'),
            el('span', 'lg', el('span', 'lg-box lg-method'), 'method'),
            el('span', 'lg', el('span', 'lg-box lg-hotkey'), 'hotkey'),
            el('span', 'lg', el('span', 'lg-line'), 'calls'),
            el('span', 'lg', el('span', 'lg-line lg-dashed'), 'registers a callback'),
            el('span', 'lg', el('span', 'lg-line lg-dotted'), 'method matched by name'),
        );
        this.stage = el('div', 'calls-graph');
        host.append(el('div', 'panel-head calls-head', this.summary, legend), this.stage);
        this.stage.addEventListener('click', e => {
            const i = this.nodeIndex(e.target);
            const n = i >= 0 ? this.data.nodes[i] : null;
            if (n?.range) this.cb.onSelect(n.range);
        });
        this.stage.addEventListener('pointerover', e => this.hover(this.nodeIndex(e.target)));
        this.stage.addEventListener('pointerleave', () => this.hover(-1));
    }

    setData(data: CallGraphData) {
        this.data = data;
        this.dirty = true;
    }

    /** Draw if the data changed since the last draw. */
    async render(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        const data = this.data;
        const token = ++this.token;
        this.card.close();
        const fns = data.nodes.filter(n => n.kind !== 'auto' && n.kind !== 'class').length;
        const calls = data.edges.reduce((s, e) => s + (e.via === 'call' ? e.count : 0), 0);
        const cbs = data.edges.reduce((s, e) => s + (e.via !== 'call' ? e.count : 0), 0);
        this.summary.textContent = data.nodes.length
            ? `${fns} function${fns === 1 ? '' : 's'}, methods and hotkeys · ${calls} call${calls === 1 ? '' : 's'} · ${cbs} callback${cbs === 1 ? '' : 's'}`
            : '';
        if (!data.nodes.length || !data.edges.length) {
            this.svg = null;
            this.stage.replaceChildren(el('p', 'panel-empty', data.nodes.length
                ? 'None of these functions call each other yet.'
                : 'No functions, methods or hotkeys to connect. Calls between them, and callbacks you register with SetTimer, OnEvent, Hotkey and the like, show up here.'));
            return;
        }
        let svg: SVGSVGElement;
        try {
            svg = await this.viz.renderSVGElement(callsDot(data)) as SVGSVGElement;
        } catch (e) {
            this.viz = new Viz({ Module, render });
            if (token === this.token) this.stage.replaceChildren(el('p', 'panel-empty', `Drawing the call graph failed (${e}).`));
            return;
        }
        if (token !== this.token) return;
        const pt = (v: string | null) => parseFloat(v ?? '0') * (v?.endsWith('pt') ? 4 / 3 : 1);
        svg.setAttribute('width', String(pt(svg.getAttribute('width'))));
        svg.setAttribute('height', String(pt(svg.getAttribute('height'))));
        svg.querySelector('g.graph > polygon')?.remove();
        this.nodeEls = [];
        this.edgeEls = [];
        const edgeByKey = new Map<string, CallEdge[]>();
        const index = new Map(data.nodes.map((n, i) => [n.id, i]));
        for (const e of data.edges) {
            const key = `n${index.get(e.from)}->n${index.get(e.to)}`;
            edgeByKey.set(key, [...(edgeByKey.get(key) ?? []), e]);
        }
        const seen = new Map<string, number>();
        for (const t of Array.from(svg.querySelectorAll('title'))) {
            const g = t.parentElement as unknown as SVGGElement;
            const text = t.textContent ?? '';
            if (g.classList.contains('node')) {
                const i = Number(text.slice(1));
                this.nodeEls[i] = g;
                g.dataset.i = String(i);
                g.classList.add(`kind-${data.nodes[i]?.kind}`);
            } else if (g.classList.contains('edge')) {
                const [a, b] = text.split('->').map(s => Number(s.slice(1)));
                const k = seen.get(text) ?? 0;
                seen.set(text, k + 1);
                const edge = edgeByKey.get(text)?.[k];
                if (edge) this.edgeEls.push({ el: g, from: a, to: b, edge });
            }
            t.remove();
        }
        this.stage.replaceChildren(svg);
        this.svg = svg;
        this.markCurrent(this.currentId);
    }

    /** Outline the function, method or hotkey the cursor is in. */
    markCurrent(id: string | null) {
        this.currentId = id;
        this.nodeEls.forEach((g, i) => g?.classList.toggle('cur', this.data.nodes[i]?.id === id));
    }

    private nodeIndex(target: EventTarget | null): number {
        const g = (target as Element | null)?.closest?.('g.node') as SVGGElement | null;
        return g?.dataset.i !== undefined ? Number(g.dataset.i) : -1;
    }

    private hover(i: number) {
        const svg = this.svg;
        if (!svg) return;
        this.stage.classList.toggle('hovering', i >= 0);
        const near = new Set<number>(i >= 0 ? [i] : []);
        for (const e of this.edgeEls) {
            const hot = i >= 0 && (e.from === i || e.to === i);
            e.el.classList.toggle('hot', hot);
            if (hot) { near.add(e.from); near.add(e.to); }
        }
        this.nodeEls.forEach((g, k) => g?.classList.toggle('near', near.has(k)));
        if (i < 0) { this.card.close(80); return; }
        const n = this.data.nodes[i];
        this.card.open(n, () => this.cardContent(i), () => this.nodeEls[i]?.getBoundingClientRect() ?? null, this.card.visible ? 0 : 300, { placement: 'below' });
    }

    private cardContent(i: number): Node[] {
        const n = this.data.nodes[i];
        const name = (k: number) => this.data.nodes[k]?.label ?? '?';
        const out = this.edgeEls.filter(e => e.from === i), inc = this.edgeEls.filter(e => e.to === i);
        const desc = (e: { edge: CallEdge }, other: string) => `${other}${e.edge.via !== 'call' ? ` (${e.edge.via})` : ''}${e.edge.count > 1 ? ` ×${e.edge.count}` : ''}${e.edge.guess ? ' (matched by name)' : ''}`;
        const parts: Node[] = [
            el('div', 'tip-graph-head', el('span', `lg-box lg-${n.kind}`), el('strong', '', n.label), el('span', 'tip-muted', ` ${KIND_LABEL[n.kind]}`)),
        ];
        if (inc.length) parts.push(el('div', 'tip-small', el('span', 'tip-muted', 'Called by '), inc.map(e => desc(e, name(e.from))).join(', ')));
        else if (/\.__\w+$/.test(n.label)) parts.push(el('div', 'tip-small tip-muted', 'AutoHotkey calls this meta-function itself (for example __Enum in a for loop, __Item for obj[i]).'));
        else if (n.kind === 'function' || n.kind === 'method') parts.push(el('div', 'tip-small tip-muted', 'Nothing in this script calls it directly. It may be called by name, through a variable, or from another file.'));
        if (out.length) parts.push(el('div', 'tip-small', el('span', 'tip-muted', 'Calls '), out.map(e => desc(e, name(e.to))).join(', ')));
        if (n.range) parts.push(el('div', 'tip-hint', `Line ${n.range.from.line + 1}. Click to go to it.`));
        return parts;
    }
}
