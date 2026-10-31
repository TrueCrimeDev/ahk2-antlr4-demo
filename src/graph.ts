import Viz from 'viz.js';
import { Module, render } from 'viz.js/full.render.js';
import { Model, ViewNode } from './model';

export interface GraphCallbacks {
    onSelect(node: ViewNode): void;
}

const MAX_AUTO_NODES = 2500;

/** Graphviz rendering of the model, with pan/zoom and node selection. */
export class GraphView {
    private viz = new Viz({ Module, render });
    private model: Model | null = null;
    private svg: SVGSVGElement | null = null;
    private stage: HTMLDivElement;
    private message: HTMLDivElement;
    private elements = new Map<number, SVGGElement>();
    private scale = 1;
    private tx = 0;
    private ty = 0;
    private hasRendered = false;
    private renderToken = 0;
    private forceLarge = false;
    private classes = new Map<string, Set<number>>();

    constructor(private host: HTMLElement, private cb: GraphCallbacks) {
        this.stage = document.createElement('div');
        this.stage.className = 'graph-stage';
        this.message = document.createElement('div');
        this.message.className = 'graph-message';
        host.append(this.stage, this.message);
        this.installPanZoom();
    }

    async render(model: Model): Promise<void> {
        this.model = model;
        const token = ++this.renderToken;
        this.elements.clear();
        this.setMessage('');
        if (!model.root) {
            this.stage.replaceChildren();
            this.setMessage('Nothing to show.');
            return;
        }
        if (model.nodes.length > MAX_AUTO_NODES && !this.forceLarge) {
            this.stage.replaceChildren();
            const btn = document.createElement('button');
            btn.textContent = 'Render anyway';
            btn.onclick = () => { this.forceLarge = true; this.render(model); };
            this.setMessage(`This tree has ${model.nodes.length} nodes, which can be slow to draw. The Outline tab shows it instantly. `, btn);
            return;
        }
        let svg: SVGSVGElement;
        try {
            svg = await this.viz.renderSVGElement(toDot(model)) as SVGSVGElement;
        } catch (e: any) {
            this.viz = new Viz({ Module, render }); // Viz.js instances are unusable after an error.
            if (token !== this.renderToken) return;
            this.stage.replaceChildren();
            this.setMessage(`Drawing the tree failed, usually because it is too large. Use the Outline tab instead. (${e})`);
            return;
        }
        if (token !== this.renderToken) return;

        // Size the SVG in CSS pixels; Graphviz reports points.
        const pt = (v: string | null) => parseFloat(v ?? '0') * (v?.endsWith('pt') ? 4 / 3 : 1);
        const w = pt(svg.getAttribute('width')), h = pt(svg.getAttribute('height'));
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        svg.querySelectorAll('title').forEach(t => {
            const g = t.parentElement;
            if (g?.classList.contains('node')) {
                const id = Number(t.textContent?.slice(1));
                this.elements.set(id, g as unknown as SVGGElement);
                g.setAttribute('data-id', String(id));
                const n = model.nodes[id];
                if (n) g.classList.add(`kind-${n.kind}`);
            }
            t.remove(); // Native tooltips would duplicate the labels.
        });
        this.stage.replaceChildren(svg);
        this.svg = svg;
        for (const [cls, ids] of this.classes) for (const id of ids) this.elements.get(id)?.classList.add(cls);
        if (!this.hasRendered) { this.initialView(); this.hasRendered = true; } else this.apply();
    }

    /** Replace the set of nodes carrying a CSS class (sel, cur, match). */
    mark(cls: string, nodes: ViewNode[]) {
        const prev = this.classes.get(cls);
        if (prev) for (const id of prev) this.elements.get(id)?.classList.remove(cls);
        const next = new Set(nodes.map(n => n.id));
        this.classes.set(cls, next);
        for (const id of next) this.elements.get(id)?.classList.add(cls);
    }

    reveal(node: ViewNode) {
        const el = this.elements.get(node.id);
        if (!el) return;
        const r = el.getBoundingClientRect(), host = this.host.getBoundingClientRect();
        const pad = 40;
        let dx = 0, dy = 0;
        if (r.left < host.left + pad) dx = host.left + pad - r.left;
        else if (r.right > host.right - pad) dx = host.right - pad - r.right;
        if (r.top < host.top + pad) dy = host.top + pad - r.top;
        else if (r.bottom > host.bottom - pad) dy = host.bottom - pad - r.bottom;
        if (dx || dy) { this.tx += dx; this.ty += dy; this.apply(); }
    }

    zoomBy(factor: number) {
        const host = this.host.getBoundingClientRect();
        this.zoomAt(factor, host.width / 2, host.height / 2);
    }

    actualSize() {
        this.scale = 1; this.tx = 16; this.ty = 16; this.apply();
    }

    fit() {
        if (!this.svg) return;
        const host = this.host.getBoundingClientRect();
        const w = Number(this.svg.getAttribute('width')), h = Number(this.svg.getAttribute('height'));
        if (!w || !h || !host.width || !host.height) { this.actualSize(); return; }
        this.scale = Math.min(1.5, (host.width - 32) / w, (host.height - 32) / h);
        this.tx = (host.width - w * this.scale) / 2;
        this.ty = Math.max(16, (host.height - h * this.scale) / 2);
        this.apply();
    }

    /** Fit small trees; for wide trees start at a readable scale with the root at the top center. */
    private initialView() {
        this.fit();
        const minReadable = 0.6;
        if (this.scale >= minReadable || !this.model?.root) return;
        this.scale = minReadable;
        this.tx = 0;
        this.ty = 16;
        this.apply();
        const root = this.elements.get(this.model.root.id);
        if (!root) return;
        const r = root.getBoundingClientRect(), host = this.host.getBoundingClientRect();
        this.tx = host.left + host.width / 2 - (r.left + r.width / 2);
        this.apply();
    }

    private setMessage(text: string, extra?: HTMLElement) {
        this.message.replaceChildren(text, ...(extra ? [extra] : []));
        this.message.hidden = !text;
    }

    private apply() {
        this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }

    private zoomAt(factor: number, px: number, py: number) {
        const next = Math.min(4, Math.max(0.05, this.scale * factor));
        const k = next / this.scale;
        this.tx = px - (px - this.tx) * k;
        this.ty = py - (py - this.ty) * k;
        this.scale = next;
        this.apply();
    }

    private installPanZoom() {
        const host = this.host;
        host.addEventListener('wheel', e => {
            e.preventDefault();
            const r = host.getBoundingClientRect();
            if (e.ctrlKey || e.metaKey || !e.shiftKey && Math.abs(e.deltaX) < 1 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 50) {
                // Mouse wheel and pinch zoom; trackpad two-finger scrolling pans instead.
                this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
            } else {
                this.tx -= e.shiftKey ? e.deltaY : e.deltaX;
                this.ty -= e.shiftKey ? 0 : e.deltaY;
                this.apply();
            }
        }, { passive: false });

        let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null = null;
        const pinch = new Map<number, { x: number; y: number }>();
        let pinchDist = 0;
        host.addEventListener('pointerdown', e => {
            if ((e.target as HTMLElement).closest('button')) return;
            pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch.size === 2) {
                const [a, b] = [...pinch.values()];
                pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
                drag = null;
                return;
            }
            drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false, id: e.pointerId };
        });
        host.addEventListener('pointermove', e => {
            if (pinch.has(e.pointerId)) pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch.size === 2) {
                const [a, b] = [...pinch.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                const r = host.getBoundingClientRect();
                if (pinchDist) this.zoomAt(d / pinchDist, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
                pinchDist = d;
                return;
            }
            if (!drag || drag.id !== e.pointerId) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) > 4) {
                drag.moved = true;
                host.setPointerCapture(e.pointerId);
                host.classList.add('panning');
            }
            if (drag.moved) { this.tx = drag.tx + dx; this.ty = drag.ty + dy; this.apply(); }
        });
        const end = (e: PointerEvent) => {
            pinch.delete(e.pointerId);
            if (pinch.size < 2) pinchDist = 0;
            if (!drag || drag.id !== e.pointerId) return;
            const wasClick = !drag.moved;
            drag = null;
            host.classList.remove('panning');
            if (e.type === 'pointerup' && wasClick) {
                const g = (e.target as Element).closest?.('g.node');
                const id = g?.getAttribute('data-id');
                if (id != null && this.model) {
                    const node = this.model.nodes[Number(id)];
                    if (node) this.cb.onSelect(node);
                }
            }
        };
        host.addEventListener('pointerup', end);
        host.addEventListener('pointercancel', end);
    }
}

function dotString(s: string): string {
    return JSON.stringify(s);
}

export function toDot(model: Model): string {
    const lines: string[] = [];
    lines.push('digraph G {');
    // Courier has built-in metrics in Graphviz, so node widths match a real monospace font
    // (the page swaps in the system monospace font, which has the same 0.6em advance).
    lines.push('  graph [nodesep=0.2, ranksep=0.25, fontsize=10, fontname="Courier", bgcolor="transparent"];');
    lines.push('  node [fontsize=8, fontname="Courier", height=0.3, margin="0.1,0.03"];');
    lines.push('  edge [arrowsize=0.5];');
    for (const n of model.nodes) {
        const shape = n.kind === 'rule' ? '' : ', shape=box, style=rounded';
        lines.push(`  n${n.id} [label=${dotString(n.label)}${shape}];`);
        if (n.parent) lines.push(`  n${n.parent.id} -> n${n.id};`);
    }
    lines.push('}');
    return lines.join('\n');
}
