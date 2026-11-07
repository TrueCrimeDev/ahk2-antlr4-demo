import type { CallEdge, CallNode, CallNodeKind } from './symbols';

const KIND_COLOR: Record<CallNodeKind, string> = {
    auto: '#A0A0A0',
    function: '#3B82F6',
    method: '#8B5CF6',
    property: '#14B8A6',
    hotkey: '#EC4899',
    class: '#F97316',
};
export const KIND_LABEL: Record<CallNodeKind, string> = {
    auto: 'top of the script', function: 'function', method: 'method', property: 'property', hotkey: 'hotkey', class: 'class',
};

function mix(hex: string, base: string, t: number): string {
    const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const a = p(hex), b = p(base);
    return '#' + a.map((v, i) => Math.round(v * t + b[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');

export interface CallGraphData { nodes: CallNode[]; edges: CallEdge[] }

export function callsDot(g: CallGraphData): string {
    const index = new Map(g.nodes.map((n, i) => [n.id, i]));
    const called = new Set(g.edges.filter(e => e.from !== e.to).map(e => e.to));
    const lines = [
        'digraph Calls {',
        '  graph [rankdir=LR, nodesep=0.22, ranksep=0.6, bgcolor="transparent", pad=0.25, fontname="Helvetica"];',
        '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=12, height=0.38, margin="0.16,0.06", penwidth=1.4];',
        '  edge [color="#666666", penwidth=1.3, arrowsize=0.7, fontname="Helvetica", fontsize=10, fontcolor="#A0A0A0"];',
    ];
    g.nodes.forEach((n, i) => {
        const c = KIND_COLOR[n.kind];
        const meta = n.kind === 'method' && /\.__\w+$/.test(n.label);
        const orphan = (n.kind === 'function' || n.kind === 'method') && !called.has(n.id) && !meta;
        const caption = orphan ? `${KIND_LABEL[n.kind]} · not called here` : meta && !called.has(n.id) ? 'meta-function · called by AutoHotkey' : KIND_LABEL[n.kind];
        const label = `<<FONT POINT-SIZE="9" COLOR="${orphan ? '#666666' : '#A0A0A0'}">${esc(caption)}</FONT><BR/>`
            + `<FONT FACE="Courier" POINT-SIZE="12.5" COLOR="${orphan ? '#A0A0A0' : '#E0E0E0'}">${esc(n.label)}</FONT>>`;
        const style = orphan ? 'rounded,filled,dashed' : n.kind === 'auto' ? 'rounded,filled,bold' : 'rounded,filled';
        lines.push(`  n${i} [label=${label}, style="${style}", fillcolor="${mix(c, '#262626', orphan ? 0.05 : 0.16)}", color="${orphan ? '#555555' : mix(c, '#262626', 0.8)}"];`);
    });
    for (const e of g.edges) {
        const a = index.get(e.from), b = index.get(e.to);
        if (a === undefined || b === undefined) continue;
        const attrs: string[] = [];
        const label = [e.via !== 'call' ? e.via : '', e.count > 1 ? `×${e.count}` : '', e.guess ? 'by name' : ''].filter(Boolean).join(' ');
        if (label) attrs.push(`label=" ${esc(label)} "`);
        if (e.via !== 'call') attrs.push('style=dashed', `color="${mix('#14B8A6', '#262626', 0.85)}"`, 'fontcolor="#14B8A6"');
        else if (e.guess) attrs.push('style=dotted');
        lines.push(`  n${a} -> n${b}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`);
    }
    lines.push('}');
    return lines.join('\n');
}

