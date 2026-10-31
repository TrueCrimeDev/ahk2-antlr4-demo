import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import { parseSource, Diagnostic, ParseResult, SrcPos, SrcRange, Severity } from './parse';
import { buildModel, Model, nodeAtPos, ViewNode } from './model';
import { lint, LINT_RULES } from './lint';
import { GraphView } from './graph';
import { OutlineView } from './outline';
import { TokenView } from './tokens';
import { Highlighter } from './highlight';

type Tab = 'graph' | 'outline' | 'tokens';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
    get(key: string): string | null { try { return localStorage.getItem('ahk-ast:' + key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem('ahk-ast:' + key, value); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------------------
// Editor

const inputEl = $<HTMLTextAreaElement>('input');
const saved = store.get('code');
if (saved !== null) inputEl.value = saved;
const editor = CodeMirror.fromTextArea(inputEl, {
    lineNumbers: true,
    mode: 'text/plain',
    theme: 'ahk-dark',
    gutters: ['lint-gutter', 'CodeMirror-linenumbers'],
    indentUnit: 4,
    tabSize: 4,
});

new Highlighter(editor);

function cpToUnits(text: string, cp: number): number {
    let units = 0, n = 0;
    for (const ch of text) { if (n++ >= cp) break; units += ch.length; }
    return units;
}
function unitsToCp(text: string, units: number): number {
    let u = 0, n = 0;
    for (const ch of text) { if (u >= units) break; u += ch.length; n++; }
    return n;
}
function toCM(p: SrcPos): CodeMirror.Position {
    const last = editor.lastLine();
    if (p.line > last) return { line: last, ch: editor.getLine(last).length };
    return { line: p.line, ch: cpToUnits(editor.getLine(p.line) ?? '', p.col) };
}
function fromCM(p: CodeMirror.Position): SrcPos {
    return { line: p.line, col: unitsToCp(editor.getLine(p.line) ?? '', p.ch) };
}

// ---------------------------------------------------------------------------
// State

let result: ParseResult | null = null;
let model: Model = { root: null, nodes: [] };
let diagnostics: Diagnostic[] = [];
let selected: ViewNode | null = null;
let activeTab: Tab = (store.get('tab') as Tab) || 'graph';
let graphDirty = true;
let lastEditAt = 0;
const collapseBox = $<HTMLInputElement>('showAll');
collapseBox.checked = store.get('collapse') === '1';

const graph = new GraphView($('graph'), { onSelect: n => select(n, 'graph') });
const outline = new OutlineView($('outline'), { onSelect: n => select(n, 'outline') });
const tokens = new TokenView($('tokens'), { onSelect: r => highlightRange(r, true) });

// ---------------------------------------------------------------------------
// Parsing and rendering

function update() {
    const code = editor.getValue();
    store.set('code', code);
    result = parseSource(code);
    diagnostics = [...result.diagnostics];
    const banner = $('stale-banner');
    if (result.tree && result.parser) {
        diagnostics.push(...lint(result.tree));
        model = buildModel(result.tree, result.parser, collapseBox.checked);
        banner.hidden = true;
        refreshViews();
    } else {
        // Lexing failed: keep the last good tree on screen.
        banner.hidden = false;
    }
    tokens.setTokens(result.codeTokens, result.allTokens);
    renderDiagnostics();
    renderStatus();
}

function refreshViews() {
    selected = null;
    renderBreadcrumb();
    highlightRange(null, false);
    outline.mark('sel', []);
    graph.mark('sel', []);
    outline.render(model);
    graphDirty = true;
    if (activeTab === 'graph') renderGraph();
    runSearch(false);
    syncCursor(false);
}

function renderGraph() {
    if (!graphDirty) return;
    graphDirty = false;
    graph.render(model);
}

function renderStatus() {
    if (!result) return;
    const errs = diagnostics.filter(d => d.severity === 'error').length;
    $('status').textContent = `${model.nodes.length} nodes · ${result.codeTokens.length} tokens · `
        + `lex ${result.lexMs.toFixed(1)} ms · parse ${result.parseMs.toFixed(1)} ms`
        + (errs ? ` · ${errs} error${errs === 1 ? '' : 's'}` : '');
}

// ---------------------------------------------------------------------------
// Diagnostics

let lintMarks: CodeMirror.TextMarker[] = [];
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function renderDiagnostics() {
    lintMarks.forEach(m => m.clear());
    lintMarks = [];
    editor.clearGutter('lint-gutter');
    diagnostics.sort((a, b) => a.range.from.line - b.range.from.line || a.range.from.col - b.range.from.col
        || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const byLine = new Map<number, Diagnostic[]>();
    for (const d of diagnostics) {
        const from = toCM(d.range.from);
        let to = toCM(d.range.to);
        if (to.line === from.line && to.ch === from.ch) to = { line: to.line, ch: to.ch + 1 };
        lintMarks.push(editor.markText(from, to, { className: `cm-lint cm-lint-${d.severity}`, attributes: { title: d.message } }));
        const list = byLine.get(from.line) ?? [];
        list.push(d);
        byLine.set(from.line, list);
    }
    for (const [line, list] of byLine) {
        const worst = list.reduce((a, b) => SEVERITY_ORDER[b.severity] < SEVERITY_ORDER[a.severity] ? b : a);
        const marker = document.createElement('div');
        marker.className = `lint-marker lint-${worst.severity}`;
        marker.title = list.map(d => d.message).join('\n\n');
        editor.setGutterMarker(line, 'lint-gutter', marker);
    }

    const panel = $('problems-list');
    const counts = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) counts[d.severity]++;
    const summary = (['error', 'warning', 'info'] as Severity[])
        .filter(s => counts[s]).map(s => `${counts[s]} ${s}${counts[s] === 1 ? '' : 's'}`).join(', ');
    $('problems-count').textContent = summary || 'none';
    if (!diagnostics.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No problems found.';
        panel.replaceChildren(li);
        return;
    }
    panel.replaceChildren(...diagnostics.map(d => {
        const li = document.createElement('li');
        li.className = `problem sev-${d.severity}`;
        li.tabIndex = 0;
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.setAttribute('aria-label', d.severity);
        const msg = document.createElement('span');
        msg.className = 'msg';
        msg.textContent = d.message;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = `${d.rule} · ${d.range.from.line + 1}:${d.range.from.col + 1}`;
        li.append(icon, msg, meta);
        if (d.docs) {
            const a = document.createElement('a');
            a.href = d.docs;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'docs';
            a.onclick = e => e.stopPropagation();
            meta.append(' · ', a);
        }
        const go = () => {
            editor.focus();
            editor.setSelection(toCM(d.range.from), toCM(d.range.to));
            editor.scrollIntoView({ from: toCM(d.range.from), to: toCM(d.range.to) }, 80);
        };
        li.onclick = go;
        li.onkeydown = e => { if (e.key === 'Enter') go(); };
        return li;
    }));
}

$('rules-list').replaceChildren(...LINT_RULES.map(r => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = r.id;
    li.append(b, ` ${r.title}. ${r.description}`);
    return li;
}));

// ---------------------------------------------------------------------------
// Selection, cursor sync, breadcrumb

let selMark: CodeMirror.TextMarker | null = null;

function highlightRange(range: SrcRange | null, scroll: boolean) {
    selMark?.clear();
    selMark = null;
    if (!range) return;
    const from = toCM(range.from), to = toCM(range.to);
    selMark = editor.markText(from, to, { className: 'cm-node-sel' });
    if (scroll) editor.scrollIntoView({ from, to }, 60);
}

function select(node: ViewNode | null, source: 'graph' | 'outline' | 'search' | 'crumb') {
    selected = node;
    const list = node ? [node] : [];
    graph.mark('sel', list);
    outline.mark('sel', list);
    highlightRange(node?.range ?? null, true);
    renderBreadcrumb();
    if (!node) return;
    if (activeTab === 'graph' && source !== 'graph') graph.reveal(node);
    if (activeTab === 'outline' && source !== 'outline') outline.reveal(node);
}

function renderBreadcrumb() {
    const bar = $('breadcrumb');
    if (!selected) {
        bar.textContent = 'Click a node to highlight its code. Move the cursor in the editor to find its node.';
        bar.classList.add('hint');
        return;
    }
    bar.classList.remove('hint');
    const chain: ViewNode[] = [];
    for (let n: ViewNode | null = selected; n; n = n.parent) chain.unshift(n);
    const parts: (string | HTMLElement)[] = [];
    chain.forEach((n, i) => {
        if (i) parts.push(' › ');
        const b = document.createElement('button');
        b.className = 'crumb' + (n === selected ? ' current' : '');
        b.textContent = n.text !== undefined ? `${n.name} ${JSON.stringify(n.text)}` : n.name;
        b.onclick = () => select(n, 'crumb');
        parts.push(b);
    });
    if (selected.range) {
        const r = selected.range;
        const pos = document.createElement('span');
        pos.className = 'crumb-pos';
        pos.textContent = `  ${r.from.line + 1}:${r.from.col + 1}–${r.to.line + 1}:${r.to.col + 1}`;
        parts.push(pos);
    }
    bar.replaceChildren(...parts);
    bar.scrollLeft = bar.scrollWidth;
}

function syncCursor(reveal: boolean) {
    const pos = fromCM(editor.getCursor());
    const node = model.root ? nodeAtPos(model, pos) : null;
    const list = node ? [node] : [];
    graph.mark('cur', list);
    outline.mark('cur', list);
    tokens.markAt(pos.line, pos.col, reveal && activeTab === 'tokens');
    if (!node || !reveal) return;
    if (activeTab === 'graph') graph.reveal(node);
    else if (activeTab === 'outline') outline.reveal(node);
}

// ---------------------------------------------------------------------------
// Search

let matches: ViewNode[] = [];
let matchIndex = -1;
const searchBox = $<HTMLInputElement>('search');

function runSearch(jump: boolean) {
    const q = searchBox.value.trim().toLowerCase();
    matches = q ? model.nodes.filter(n => n.label.toLowerCase().includes(q)) : [];
    matchIndex = -1;
    graph.mark('match', matches);
    outline.mark('match', matches);
    $('search-count').textContent = q ? (matches.length ? `${matches.length} found` : 'no match') : '';
    if (jump && matches.length) step(1);
}

function step(dir: number) {
    if (!matches.length) return;
    matchIndex = (matchIndex + dir + matches.length) % matches.length;
    $('search-count').textContent = `${matchIndex + 1} of ${matches.length}`;
    select(matches[matchIndex], 'search');
}

let searchTimer: number | undefined;
searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => runSearch(false), 150);
});
searchBox.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (matchIndex < 0 && !matches.length) runSearch(true); else step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { searchBox.value = ''; runSearch(false); }
});
$('search-prev').onclick = () => step(-1);
$('search-next').onclick = () => step(1);

// ---------------------------------------------------------------------------
// Tabs and toolbar

function setTab(tab: Tab) {
    activeTab = tab;
    store.set('tab', tab);
    for (const t of ['graph', 'outline', 'tokens'] as Tab[]) {
        $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
        $(t).hidden = t !== tab;
    }
    document.body.dataset.tab = tab;
    if (tab === 'graph') renderGraph();
    if (selected) { if (tab === 'graph') graph.reveal(selected); if (tab === 'outline') outline.reveal(selected); }
    syncCursor(false);
}
for (const t of ['graph', 'outline', 'tokens'] as Tab[]) $(`tab-${t}`).onclick = () => setTab(t);

$('zoom-in').onclick = () => graph.zoomBy(1.25);
$('zoom-out').onclick = () => graph.zoomBy(0.8);
$('zoom-fit').onclick = () => graph.fit();
$('zoom-100').onclick = () => graph.actualSize();
$('expand-all').onclick = () => outline.setAll(true);
$('collapse-all').onclick = () => outline.setAll(false);
const allTokensBox = $<HTMLInputElement>('all-tokens');
allTokensBox.onchange = () => { tokens.showAll = allTokensBox.checked; tokens.render(); syncCursor(false); };

collapseBox.addEventListener('change', () => {
    store.set('collapse', collapseBox.checked ? '1' : '0');
    if (result?.tree && result.parser) {
        model = buildModel(result.tree, result.parser, collapseBox.checked);
        refreshViews();
        renderStatus();
    }
});

// ---------------------------------------------------------------------------
// Wiring

let debounceTimer: number | undefined;
editor.on('change', () => {
    lastEditAt = performance.now();
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(update, 350);
});
let cursorTimer: number | undefined;
editor.on('cursorActivity', () => {
    clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(() => syncCursor(performance.now() - lastEditAt > 400), 60);
});

setTab(activeTab);
update();
