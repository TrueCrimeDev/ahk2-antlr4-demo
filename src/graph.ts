import Viz from 'viz.js';
import { Module, render } from 'viz.js/full.render.js';
import { Model, ViewNode } from './model';

export interface GraphCallbacks {
    onSelect(node: ViewNode): void;
    /** A click on empty space. */
    onBackground?(): void;
    /** Pointer entered (node) or left (null) a graph node. */
    onHover?(node: ViewNode | null): void;
    /** Text color for a token, matching the editor's highlighting. */
    tokenColor?(node: ViewNode): string;
}

const MAX_AUTO_NODES = 2500;

// ---------------------------------------------------------------------------
// What a node is called and how it is colored

import { altLabel } from './labels';
import { Tip, el } from './tooltip';
export { altLabel };

export type Category = 'stmt' | 'decl' | 'expr' | 'value' | 'name' | 'directive' | 'struct';

export const CATEGORY_NAMES: Record<Category, string> = {
    stmt: 'Statement',
    decl: 'Declaration',
    expr: 'Expression',
    value: 'Literal',
    name: 'Name',
    directive: 'Directive, hotkey',
    struct: 'Structure',
};

const CATEGORY_RULES: [Category, RegExp][] = [
    ['struct', /^(program|sourceElements?|statementList|block|blockStatement|flowBlock|s|eos)$/],
    ['directive', /^(directive|positionalDirective|generalDirective|remap|hotstring|hotstringExpansion|hotkey)$/],
    ['decl', /^(declaration|variableStatement|variableDeclarationList|variableDeclaration|function(Declaration|Head|HeadPrefix|ExpressionHead|Body)|fatArrowExpressionHead|class\w*|method\w*|property(Definition|GetterDefinition|SetterDefinition)|classPropertyName|fieldDefinition|formalParameter\w*|lastFormalParameterArg|getter|setter)$/],
    ['value', /^(literal|boolean|numericLiteral|arrayLiteral|objectLiteral|propertyAssignment|propertyName)$/],
    ['name', /^(identifier|identifierName|reservedWord|keyword)$/],
    ['expr', /^(singleExpression|primaryExpression|expressionSequence|arguments|argument|accessSuffix|member\w*|dynamicIdentifier|dereference|initializer|assignable|assignmentOperator)$/],
];

export function categoryOf(ruleName: string): Category {
    for (const [cat, re] of CATEGORY_RULES) if (re.test(ruleName)) return cat;
    return 'stmt';
}

/** Wrapper rules that add little when they sit in a merged chain; they stay in the tooltip and breadcrumb. */
const PLUMBING = new Set(['sourceElement', 'statement', 'expressionSequence', 'singleExpression', 'primaryExpression',
    'identifier', 'identifierName', 's', 'eos']);

// ---------------------------------------------------------------------------
// Graph nodes: one per view node, or one per single-child chain when merging

export interface GraphNode {
    id: number;
    /** View nodes drawn as this box, top to bottom. */
    members: ViewNode[];
    /** The member that clicking selects and the label emphasizes. */
    main: ViewNode;
    children: GraphNode[];
    parent: GraphNode | null;
    /** View nodes hidden under this box because it is folded. */
    hidden?: number;
}

/** Fold state is keyed by rule and position, so it survives re-parses and merge toggling. */
export const foldKey = (v: ViewNode) => `${v.name}@${v.range ? `${v.range.from.line}:${v.range.from.col}` : v.id}`;

const isEmptyWrapper = (v: ViewNode) => v.kind === 'rule' && !v.children.length && (v.name === 'eos' || v.name === 's');

export function buildGraph(model: Model, merge: boolean, folded: Set<string> = new Set()): { nodes: GraphNode[]; byView: Map<number, GraphNode> } {
    const nodes: GraphNode[] = [];
    const byView = new Map<number, GraphNode>();
    const visible = (v: ViewNode) => merge ? v.children.filter(c => !isEmptyWrapper(c)) : v.children;

    const visit = (v: ViewNode, parent: GraphNode | null) => {
        const members = [v];
        let last = v;
        if (merge) {
            for (let kids = visible(last); last.kind === 'rule' && kids.length === 1 && kids[0].kind === 'rule'; kids = visible(last)) {
                last = kids[0];
                members.push(last);
            }
        }
        // Feature the most specific labeled alternative, else the last rule that isn't plumbing.
        const reversed = [...members].reverse();
        const main = reversed.find(m => altLabel(m)) ?? reversed.find(m => !PLUMBING.has(m.name)) ?? last;
        const g: GraphNode = { id: nodes.length, members, main, children: [], parent };
        nodes.push(g);
        parent?.children.push(g);
        for (const m of members) byView.set(m.id, g);
        // Hidden wrappers (eos) still map to their parent box, so the cursor and search can find it.
        for (const c of last.children) if (merge && isEmptyWrapper(c)) byView.set(c.id, g);
        if (folded.has(foldKey(v)) && visible(last).length) {
            // Folded: everything below maps to this box, so the cursor and search still find it.
            let count = 0;
            const stack = [...last.children];
            while (stack.length) { const d = stack.pop()!; byView.set(d.id, g); count++; stack.push(...d.children); }
            g.hidden = count;
            return;
        }
        for (const c of visible(last)) visit(c, g);
    };
    if (model.root) visit(model.root, null);
    return { nodes, byView };
}

// ---------------------------------------------------------------------------
// DOT

// Graphviz has built-in metrics for Helvetica and Courier, so box widths match the page's
// Arial-compatible sans font and its monospace font (same 0.6em advance as Courier).
const SENTINEL = { caption: '#010101', main: '#020202', tokenType: '#030303' };

function esc(s: string): string {
    // Graphviz's HTML label parser also rejects a bare ']' (and treats '[' oddly), so those become entities.
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

function clip(s: string, max: number, fromStart = false): string {
    const chars = [...s];
    if (chars.length <= max) return s;
    return fromStart ? '…' + chars.slice(-(max - 1)).join('') : chars.slice(0, max - 1).join('') + '…';
}

function visibleText(s: string): string {
    return s.replace(/\r?\n/g, '⏎').replace(/\t/g, '→');
}

function ruleLabel(g: GraphNode): string {
    const i = g.members.indexOf(g.main);
    const names = (list: ViewNode[]) => list.filter(m => !PLUMBING.has(m.name)).map(m => m.name).join(' › ');
    const before = names(g.members.slice(0, i)), after = names(g.members.slice(i + 1));
    const caption = (s: string) => `<FONT POINT-SIZE="10" COLOR="${SENTINEL.caption}">${esc(clip(s, 34, true))}</FONT>`;
    const parts: string[] = [];
    if (before) parts.push(caption(before));
    parts.push(`<FONT POINT-SIZE="13" COLOR="${SENTINEL.main}">${esc(altLabel(g.main) ?? g.main.name)}</FONT>`);
    if (after) parts.push(caption(after));
    if (g.hidden) parts.push(`<FONT POINT-SIZE="10" COLOR="${SENTINEL.caption}">▸ ${g.hidden} hidden</FONT>`);
    return `<${parts.join('<BR/>')}>`;
}

function tokenLabel(n: ViewNode, color: string): string {
    const text = n.text ? visibleText(n.text) : '∅';
    return `<<FONT POINT-SIZE="9.5" COLOR="${SENTINEL.tokenType}">${esc(n.name)}</FONT><BR/>`
        + `<FONT FACE="Courier" POINT-SIZE="14" COLOR="${color}">${esc(clip(text, 36))}</FONT>>`;
}

export function toDot(nodes: GraphNode[], tokenColor: (n: ViewNode) => string = () => '#9cdcfe'): string {
    const lines: string[] = [];
    lines.push('digraph G {');
    lines.push('  graph [nodesep=0.16, ranksep=0.42, bgcolor="transparent", fontname="Helvetica"];');
    lines.push('  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=13, height=0.4, margin="0.14,0.06", penwidth=1.2, color="#8a8f98", fillcolor="#ffffff"];');
    lines.push('  edge [arrowhead=none, penwidth=1.2, color="#9aa3b2"];');
    for (const g of nodes) {
        const n = g.main;
        if (n.kind === 'rule') {
            lines.push(`  g${g.id} [label=${ruleLabel(g)}${g.hidden ? ', style="rounded,filled,dashed"' : ''}];`);
        } else {
            const color = n.kind === 'error' ? '#f48771' : tokenColor(n);
            lines.push(`  g${g.id} [label=${tokenLabel(n, color)}, margin="0.12,0.05", fillcolor="#1e1e1e", color="#3c3c3c"];`);
        }
        if (g.parent) lines.push(`  g${g.parent.id} -> g${g.id};`);
    }
    lines.push('}');
    return lines.join('\n');
}

function describe(g: GraphNode): string {
    const pos = (n: ViewNode) => n.range ? `${n.range.from.line + 1}:${n.range.from.col + 1}` : '';
    if (g.main.kind !== 'rule') return `${g.main.name} ${JSON.stringify(g.main.text ?? '')}  ${pos(g.main)}`;
    const chain = g.members.map(m => altLabel(m) ? `${m.name} (${altLabel(m)})` : m.name).join(' › ');
    return `${chain}  ${pos(g.main)}`;
}

// ---------------------------------------------------------------------------
// View

/** Graphviz rendering of the model, with pan/zoom, node selection and subtree focus. */
export class GraphView {
    private viz = new Viz({ Module, render });
    private model: Model | null = null;
    private graph: { nodes: GraphNode[]; byView: Map<number, GraphNode> } = { nodes: [], byView: new Map() };
    private svg: SVGSVGElement | null = null;
    private stage: HTMLDivElement;
    private message: HTMLDivElement;
    private elements = new Map<number, SVGGElement>();
    private edges = new Map<number, SVGGElement>(); // by child graph node id
    private scale = 1;
    private tx = 0;
    private ty = 0;
    private hasRendered = false;
    private renderToken = 0;
    private forceLarge = false;
    private classes = new Map<string, Set<number>>(); // CSS class -> view node ids
    private focusNode: ViewNode | null = null;
    private hovered: GraphNode | null = null;
    /** Draw single-child chains as one box. */
    merge = true;
    /** Boxes whose subtrees are folded away (foldKey of the box's top node). */
    readonly folded = new Set<string>();

    constructor(private host: HTMLElement, private cb: GraphCallbacks) {
        this.stage = document.createElement('div');
        this.stage.className = 'graph-stage';
        this.message = document.createElement('div');
        this.message.className = 'graph-message';
        host.append(this.stage, this.message, this.legend());
        // Panning moves the stage with a transform; the container itself must never scroll, or the
        // key slides out of view (scrollIntoView and focus can scroll overflow:hidden boxes).
        host.addEventListener('scroll', () => { host.scrollLeft = 0; host.scrollTop = 0; });
        this.installPanZoom();
        this.installHover();
    }

    async render(model: Model): Promise<void> {
        this.model = model;
        const token = ++this.renderToken;
        this.elements.clear();
        this.edges.clear();
        this.setMessage('');
        this.setHover(null);
        this.graph = buildGraph(model, this.merge, this.folded);
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
        const graph = this.graph;
        let svg: SVGSVGElement;
        try {
            svg = await this.viz.renderSVGElement(toDot(graph.nodes, this.cb.tokenColor)) as SVGSVGElement;
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
        svg.querySelector('g.graph > polygon')?.remove(); // background
        for (const t of Array.from(svg.querySelectorAll('title'))) {
            const g = t.parentElement as unknown as SVGGElement | null;
            const text = t.textContent ?? '';
            if (g?.classList.contains('node')) {
                const gn = graph.nodes[Number(text.slice(1))];
                if (gn) {
                    this.elements.set(gn.id, g);
                    g.setAttribute('data-id', String(gn.id));
                    g.classList.add(`kind-${gn.main.kind}`);
                    if (gn.main.kind === 'rule') g.classList.add(`cat-${categoryOf(gn.main.name)}`);
                    if (gn.members.length > 1) g.classList.add('merged');
                    if (gn.hidden) g.classList.add('folded');
                    g.setAttribute('data-desc', describe(gn)); // Shown in a styled card instead of a browser tooltip.
                }
            } else if (g?.classList.contains('edge')) {
                const to = Number(text.split('->')[1]?.slice(1));
                if (!Number.isNaN(to)) this.edges.set(to, g);
            }
            t.remove();
        }
        // Label roles were drawn in placeholder colors; give them classes so CSS can theme them.
        const roles: [string, string][] = [[SENTINEL.caption, 't-caption'], [SENTINEL.main, 't-main'], [SENTINEL.tokenType, 't-type']];
        for (const [color, cls] of roles) {
            svg.querySelectorAll(`text[fill="${color}"]`).forEach(el => { el.removeAttribute('fill'); el.classList.add(cls); });
        }
        svg.querySelectorAll('text[font-family^="Courier"]').forEach(el => el.classList.add('t-code'));
        this.stage.replaceChildren(svg);
        this.svg = svg;
        for (const [cls, ids] of this.classes) for (const id of ids) this.groupEl(id)?.classList.add(cls);
        this.applyFocus();
        if (!this.hasRendered) { this.initialView(); this.hasRendered = true; } else this.apply();
    }

    get svgElement(): SVGSVGElement | null { return this.svg; }

    /** Fold or unfold the box drawn for a node. Returns false if it has nothing to fold. */
    toggleFold(node: ViewNode): boolean {
        const g = this.graph.byView.get(node.id);
        if (!g) return false;
        const key = foldKey(g.members[0]);
        if (this.folded.has(key)) this.folded.delete(key);
        else if (g.children.length) this.folded.add(key);
        else return false;
        this.card.close();
        if (this.model) void this.render(this.model);
        return true;
    }

    isFolded(node: ViewNode): boolean {
        const g = this.graph.byView.get(node.id);
        return !!g && this.folded.has(foldKey(g.members[0])) && g.members.includes(node);
    }

    unfoldAll() {
        if (!this.folded.size) return;
        this.folded.clear();
        if (this.model) void this.render(this.model);
    }

    /** Fold every box at a depth below the root's children, leaving the top levels open. */
    foldToDepth(depth: number) {
        this.folded.clear();
        const walk = (g: GraphNode, d: number) => {
            if (d >= depth && g.children.length) { this.folded.add(foldKey(g.members[0])); return; }
            g.children.forEach(c => walk(c, d + 1));
        };
        const all = this.model ? buildGraph(this.model, this.merge) : null;
        if (all?.nodes[0]) walk(all.nodes[0], 0);
        if (this.model) void this.render(this.model);
    }

    private groupEl(viewId: number): SVGGElement | undefined {
        const g = this.graph.byView.get(viewId);
        return g ? this.elements.get(g.id) : undefined;
    }

    /** Replace the set of nodes carrying a CSS class (sel, cur, match). 'sel' also focuses its subtree. */
    mark(cls: string, nodes: ViewNode[]) {
        const prev = this.classes.get(cls);
        if (prev) for (const id of prev) this.groupEl(id)?.classList.remove(cls);
        const next = new Set(nodes.map(n => n.id));
        this.classes.set(cls, next);
        for (const id of next) this.groupEl(id)?.classList.add(cls);
        if (cls === 'sel') { this.focusNode = nodes[0] ?? null; this.applyFocus(); }
    }

    /** Fade everything outside the selected node's subtree. */
    private applyFocus() {
        this.svg?.querySelectorAll('.in-focus').forEach(el => el.classList.remove('in-focus'));
        const start = this.focusNode ? this.graph.byView.get(this.focusNode.id) : undefined;
        this.host.classList.toggle('focused', !!start && !!this.svg);
        if (!start) return;
        const stack = [start];
        while (stack.length) {
            const g = stack.pop()!;
            this.elements.get(g.id)?.classList.add('in-focus');
            if (g !== start) this.edges.get(g.id)?.classList.add('in-focus');
            stack.push(...g.children);
        }
    }

    reveal(node: ViewNode) {
        const el = this.groupEl(node.id);
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
        const minReadable = 0.75;
        const root = this.graph.nodes[0];
        if (this.scale >= minReadable || !root) return;
        this.scale = minReadable;
        this.tx = 0;
        this.ty = 16;
        this.apply();
        const el = this.elements.get(root.id);
        if (!el) return;
        const r = el.getBoundingClientRect(), host = this.host.getBoundingClientRect();
        this.tx = host.left + host.width / 2 - (r.left + r.width / 2);
        this.apply();
    }

    /** Start the next render from the default view (used when new code is loaded). */
    resetView() {
        this.hasRendered = false;
    }

    private legend(): HTMLElement {
        const box = document.createElement('details');
        box.className = 'graph-legend';
        box.open = window.innerWidth > 800;
        const summary = document.createElement('summary');
        summary.textContent = 'Key';
        const list = document.createElement('ul');
        for (const [cat, label] of Object.entries(CATEGORY_NAMES)) {
            const li = document.createElement('li');
            const sw = document.createElement('span');
            sw.className = `swatch cat-${cat}`;
            li.append(sw, label);
            list.append(li);
        }
        const tok = document.createElement('li');
        const chip = document.createElement('span');
        chip.className = 'swatch token';
        chip.textContent = 'x';
        tok.append(chip, 'Token (code)');
        list.append(tok);
        const note = document.createElement('p');
        note.textContent = 'Gray text in a box names wrapper rules merged into it. Hover a box for its full chain, click to focus its subtree, double-click to fold it.';
        box.append(summary, list, note);
        return box;
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

    private graphNodeAt(target: EventTarget | null): GraphNode | null {
        const el = (target as Element | null)?.closest?.('g.node');
        const id = el?.getAttribute('data-id');
        return id != null ? this.graph.nodes[Number(id)] ?? null : null;
    }

    private setHover(g: GraphNode | null) {
        if (g === this.hovered) return;
        this.hovered = g;
        this.cb.onHover?.(g?.main ?? null);
        if (!g) { this.card.close(80); return; }
        this.card.open(g, () => this.cardContent(g), () => this.elements.get(g.id)?.getBoundingClientRect() ?? null,
            this.card.visible ? 0 : 320, { placement: 'below' });
    }

    private card = new Tip('tip-card tip-graph');

    private cardContent(g: GraphNode): Node[] {
        const n = g.main;
        const r = n.range;
        const where = !r ? '' : r.from.line === r.to.line
            ? `Line ${r.from.line + 1}, columns ${r.from.col + 1}–${r.to.col}`
            : `Lines ${r.from.line + 1}–${r.to.line + 1}`;
        if (n.kind !== 'rule') {
            const code = el('div', 'tip-code tip-token cm-s-ahk-dark');
            const span = el('span', '', n.text ? (n.text.length > 300 ? n.text.slice(0, 299) + '…' : n.text) : '(empty)');
            span.style.color = n.kind === 'error' ? '#f48771' : this.cb.tokenColor?.(n) ?? '#9cdcfe';
            code.append(span);
            return [
                el('div', 'tip-graph-head', el('strong', '', n.kind === 'error' ? 'Error node' : n.name), el('span', 'tip-muted', n.kind === 'error' ? '' : ' token')),
                code,
                el('div', 'tip-muted tip-small', where),
            ];
        }
        const cat = categoryOf(n.name);
        const alt = altLabel(n);
        const parts: Node[] = [
            el('div', 'tip-graph-head', el('span', `swatch cat-${cat}`), el('strong', '', alt ?? n.name), alt ? el('span', 'tip-muted', `  ${n.name}`) : null),
            el('div', 'tip-muted tip-small', CATEGORY_NAMES[cat]),
        ];
        if (g.members.length > 1) {
            const chain = el('div', 'tip-chain', el('span', 'tip-muted', 'Merged chain: '));
            g.members.forEach((m, i) => {
                if (i) chain.append(' › ');
                const label = altLabel(m);
                chain.append(el('code', m === n ? 'strong' : '', label ? `${m.name} (${label})` : m.name));
            });
            parts.push(chain);
        }
        const kids = g.children.length;
        parts.push(el('div', 'tip-small', where, kids ? el('span', 'tip-muted', ` · ${kids} child${kids === 1 ? '' : 'ren'}`) : null,
            g.hidden ? el('span', 'tip-muted', ` · ${g.hidden} nodes folded inside`) : null));
        parts.push(el('div', 'tip-hint', g.hidden ? 'Click to select it; double-click to unfold' : kids ? 'Click to select its code and focus its subtree; double-click to fold it' : 'Click to select its code'));
        return parts;
    }

    private installHover() {
        this.host.addEventListener('pointerover', e => {
            if (e.pointerType === 'touch' || this.host.classList.contains('panning')) return;
            this.setHover(this.graphNodeAt(e.target));
        });
        this.host.addEventListener('pointerleave', () => this.setHover(null));
        this.host.addEventListener('dblclick', e => {
            const g = this.graphNodeAt(e.target);
            if (!g) return;
            e.preventDefault();
            this.toggleFold(g.main);
        });
    }

    private installPanZoom() {
        const host = this.host;
        const ignore = (e: Event) => !!(e.target as HTMLElement).closest('button, .graph-legend');
        host.addEventListener('wheel', e => {
            if (ignore(e)) return;
            e.preventDefault();
            this.card.close();
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
            if (ignore(e)) return;
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
                this.setHover(null);
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
                const g = this.graphNodeAt(e.target);
                if (g) this.cb.onSelect(g.main);
                else if (!ignore(e)) this.cb.onBackground?.();
            }
        };
        host.addEventListener('pointerup', end);
        host.addEventListener('pointercancel', end);
    }
}
