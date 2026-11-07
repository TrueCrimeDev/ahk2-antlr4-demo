import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import { parseSource, Diagnostic, ParseResult, SrcPos, SrcRange, Severity } from './parse';
import { buildModel, Model, nodeAtPos, ViewNode } from './model';
import { lint, LINT_RULES } from './lint';
import { GraphView, altLabel } from './graph';
import { OutlineView } from './outline';
import { TokenView } from './tokens';
import { Highlighter, classesAt, colorForClasses, highlightSnippet } from './highlight';
import { Tip, installSimpleTips, severityIcon, el, kbd } from './tooltip';
import { EXAMPLES, Example, exampleById } from './examples';
import { analyzeScopes, ScopeInfo, Ref, refAt, describeSymbol, cmpPos } from './scope';
import { documentSymbols, callGraph, SymbolItem, CallNode } from './symbols';
import { SymbolsView, kindBadge } from './symbolsview';
import { CallsView } from './callsview';
import { SearchView } from './searchview';
import { StepsView } from './stepsview';
import { Palette, Command } from './palette';
import { expressionAt, evaluationSteps, Step } from './evaluate';
import { exportSvg, exportPng } from './exportsvg';
import type { TextEdit } from './parse';

type Tab = 'graph' | 'outline' | 'tokens' | 'symbols' | 'calls' | 'pattern' | 'steps';
const TABS: Tab[] = ['graph', 'outline', 'tokens', 'symbols', 'calls', 'pattern', 'steps'];
const TAB_NAMES: Record<Tab, string> = {
    graph: 'Graph', outline: 'Outline', tokens: 'Tokens', symbols: 'Symbols', calls: 'Calls', pattern: 'Search', steps: 'Steps',
};

/** Run an analysis without letting a bug in it take the page down. */
function safe<T>(what: string, f: () => T, fallback: T): T {
    try { return f(); } catch (e) { console.error(`${what} failed:`, e); return fallback; }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
    get(key: string): string | null { try { return localStorage.getItem('ahk-ast:' + key); } catch { return null; } },
    set(key: string, value: string) { try { localStorage.setItem('ahk-ast:' + key, value); } catch { /* storage unavailable */ } },
    remove(key: string) { try { localStorage.removeItem('ahk-ast:' + key); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------------------
// Editor

const inputEl = $<HTMLTextAreaElement>('input');
const editor = CodeMirror.fromTextArea(inputEl, {
    lineNumbers: true,
    mode: 'text/plain',
    theme: 'ahk-dark',
    gutters: ['lint-gutter', 'CodeMirror-linenumbers'],
    indentUnit: 4,
    tabSize: 4,
    extraKeys: {
        F12: () => goToDefinition(fromCM(editor.getCursor())),
        F2: () => startRename(),
        F8: () => stepProblem(1),
        'Shift-F8': () => stepProblem(-1),
    },
});

new Highlighter(editor);

/** UTF-16 offset of a source position in `code` (lines split on \n). */
let lineStarts: number[] = [0];
let lineStartsFor = '';
function offsetIn(code: string, p: SrcPos): number {
    if (lineStartsFor !== code) {
        lineStarts = [0];
        for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) lineStarts.push(i + 1);
        lineStartsFor = code;
    }
    const start = lineStarts[p.line] ?? code.length;
    const end = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1] : code.length;
    return start + cpToUnits(code.slice(start, end), p.col);
}

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
let parsedCode = '';
let scopes: ScopeInfo | null = null;
let model: Model = { root: null, nodes: [] };
let diagnostics: Diagnostic[] = [];
let selected: ViewNode | null = null;
let activeTab: Tab = TABS.includes(store.get('tab') as Tab) ? store.get('tab') as Tab : 'graph';
let symbolItems: SymbolItem[] = [];
let callNodes: CallNode[] = [];
let graphDirty = true;
let lastEditAt = 0;
const collapseBox = $<HTMLInputElement>('showAll');
collapseBox.checked = store.get('collapse') === '1';

const graph = new GraphView($('graph'), {
    onSelect: n => select(n, 'graph'),
    onBackground: () => select(null, 'graph'),
    onHover: n => hoverRange(n?.range ?? null),
    tokenColor: n => n.range ? colorForClasses(classesAt(parsedCode, offsetIn(parsedCode, n.range.from))) : '#9cdcfe',
});
const mergeBox = $<HTMLInputElement>('merge-chains');
mergeBox.checked = store.get('merge') !== '0';
graph.merge = mergeBox.checked;
const outline = new OutlineView($('outline'), { onSelect: n => select(n, 'outline') });
const tokens = new TokenView($('tokens'), { onSelect: r => highlightRange(r, true) });

/** Select a range in the editor and scroll to it. */
function goToRange(range: SrcRange, focus = true) {
    const from = toCM(range.from), to = toCM(range.to);
    if (focus) editor.focus();
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, 80);
}

const symbolsView = new SymbolsView($('symbols'), { onSelect: item => goToRange(item.range) });
const callsView = new CallsView($('calls'), { onSelect: r => goToRange(r) });

let ssrMarks: CodeMirror.TextMarker[] = [];
const searchView = new SearchView($('pattern'), {
    source: () => result?.tree && parsedCode === editor.getValue() ? { tree: result.tree, code: parsedCode } : null,
    onSelect: r => { goToRange(r, false); },
    onMatches: (ranges, current) => {
        ssrMarks.forEach(m => m.clear());
        ssrMarks = [];
        editor.operation(() => ranges.forEach((r, i) => {
            ssrMarks.push(editor.markText(toCM(r.from), toCM(r.to), { className: i === current ? 'cm-ssr cm-ssr-current' : 'cm-ssr' }));
        }));
    },
    onReplace: edits => applyEditsToEditor(edits, '+replace'),
});

let stepMarks: CodeMirror.TextMarker[] = [];
const stepsView = new StepsView($('steps'), {
    onStep: (step: Step | null, expr: SrcRange | null) => {
        stepMarks.forEach(m => m.clear());
        stepMarks = [];
        if (expr) stepMarks.push(editor.markText(toCM(expr.from), toCM(expr.to), { className: 'cm-step-expr' }));
        if (step) {
            const from = toCM(step.range.from), to = toCM(step.range.to);
            stepMarks.push(editor.markText(from, to, { className: step.warn ? 'cm-step-cur cm-step-warn' : 'cm-step-cur' }));
            editor.scrollIntoView({ from, to }, 60);
        }
    },
});

/** The expression at the cursor, for the Steps tab. */
function refreshSteps() {
    if (activeTab !== 'steps') return;
    const fresh = result?.tree && parsedCode === editor.getValue();
    const expr = fresh ? safe('expressionAt', () => expressionAt(result!.tree!, fromCM(editor.getCursor())), null) : null;
    stepsView.setEvaluation(expr ? safe('evaluationSteps', () => evaluationSteps(expr, parsedCode, scopes), null) : null);
}

/** Apply edits in one undoable step, from the end of the document backward. */
function applyEditsToEditor(edits: TextEdit[], origin: string) {
    if (!edits.length) return;
    const sorted = [...edits].sort((a, b) => cmpPos(b.range.from, a.range.from));
    editor.operation(() => {
        for (const e of sorted) editor.replaceRange(e.text, toCM(e.range.from), toCM(e.range.to), origin);
    });
    editor.focus();
    editor.setCursor(toCM(sorted[sorted.length - 1].range.from));
}

// ---------------------------------------------------------------------------
// Parsing and rendering

/** Parse the editor text and refresh everything. `fresh` means new code was loaded, so a
 *  lexing error clears the tree instead of keeping the previous one on screen. */
function update(fresh = false) {
    flushSave();
    const code = editor.getValue();
    parsedCode = code;
    result = parseSource(code);
    diagnostics = [...result.diagnostics];
    const banner = $('stale-banner');
    if (result.tree && result.parser) {
        scopes = analyzeScopes(result.tree);
        diagnostics.push(...lint(result.tree, code, scopes, { syntaxErrors: result.diagnostics.some(d => d.severity === 'error') }));
        model = buildModel(result.tree, result.parser, collapseBox.checked);
        banner.hidden = true;
        const tree = result.tree, sc = scopes;
        symbolItems = safe('documentSymbols', () => documentSymbols(tree, sc, code), []);
        symbolsView.setSymbols(symbolItems);
        const calls = safe('callGraph', () => callGraph(tree, sc), { nodes: [], edges: [] });
        callNodes = calls.nodes;
        callsView.setData(calls);
        if (activeTab === 'calls') void callsView.render();
        refreshViews();
        searchView.refresh();
    } else {
        // Lexing failed: keep the last good tree on screen while editing.
        if (fresh) { model = { root: null, nodes: [] }; refreshViews(); }
        banner.textContent = model.root
            ? 'The code has a lexing error, so this is the last tree that parsed. See Problems.'
            : 'The code has a lexing error, so there is no tree to show. See Problems.';
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

    const byLine = lineDiagnostics;
    byLine.clear();
    for (const d of diagnostics) {
        const from = toCM(d.range.from);
        let to = toCM(d.range.to);
        if (to.line === from.line && to.ch === from.ch) to = { line: to.line, ch: to.ch + 1 };
        lintMarks.push(editor.markText(from, to, { className: `cm-lint cm-lint-${d.severity}` }));
        const list = byLine.get(from.line) ?? [];
        list.push(d);
        byLine.set(from.line, list);
    }
    for (const [line, list] of byLine) {
        const worst = list.reduce((a, b) => SEVERITY_ORDER[b.severity] < SEVERITY_ORDER[a.severity] ? b : a);
        const marker = document.createElement('div');
        marker.className = `lint-marker lint-${worst.severity}`;
        const what = countLabel(list);
        marker.title = `${what}. Click for details.`;
        marker.setAttribute('aria-label', `${what} on line ${line + 1}`);
        editor.setGutterMarker(line, 'lint-gutter', marker);
    }
    refreshHint();

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
    panel.replaceChildren(...diagnostics.map(d => problemElement(d, 'li')));
}

function countLabel(list: Diagnostic[]): string {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const d of list) counts[d.severity]++;
    return (['error', 'warning', 'info'] as Severity[])
        .filter(s => counts[s]).map(s => `${counts[s]} ${s}${counts[s] === 1 ? '' : 's'}`).join(', ');
}

function goToDiagnostic(d: Diagnostic) {
    const from = toCM(d.range.from), to = toCM(d.range.to);
    editor.focus();
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, 80);
}

/** A problem row: severity dot, message, rule and position, docs link. Click or Enter jumps to it. */
/** Apply a fix's edits in one undoable step, from the end of the document backward. */
function applyFix(d: Diagnostic) {
    if (!d.fix) return;
    const edits = [...d.fix.edits].sort((a, b) => b.range.from.line - a.range.from.line || b.range.from.col - a.range.from.col);
    editor.operation(() => {
        for (const e of edits) editor.replaceRange(e.text, toCM(e.range.from), toCM(e.range.to), '+fix');
    });
    editor.focus();
    editor.setCursor(toCM(edits[edits.length - 1].range.from));
}

/** "rule · Ln 3, Col 5 · Docs · [Fix]" under a problem, in the list, the gutter popup and hovers. */
function diagnosticMeta(d: Diagnostic, beforeFix: () => void): HTMLElement {
    const meta = el('div', 'diag-meta', el('code', 'rule', d.rule), ` Ln ${d.range.from.line + 1}, Col ${d.range.from.col + 1}`);
    if (d.docs) {
        const a = el('a', 'docs-link', 'Docs');
        a.href = d.docs;
        a.target = '_blank';
        a.rel = 'noopener';
        a.title = 'Open the AutoHotkey documentation for this';
        a.onclick = e => e.stopPropagation();
        meta.append(' · ', a);
    }
    if (d.fix) {
        const btn = el('button', 'fix-btn', `Fix: ${d.fix.title}`);
        btn.title = 'Apply this change; undo it with (Ctrl+Z)';
        btn.onclick = e => { e.stopPropagation(); beforeFix(); applyFix(d); };
        btn.onkeydown = e => e.stopPropagation();
        meta.append(btn);
    }
    return meta;
}

function problemElement(d: Diagnostic, tag: 'li' | 'div'): HTMLElement {
    const el = document.createElement(tag);
    el.className = `problem sev-${d.severity}`;
    el.tabIndex = 0;
    const icon = severityIcon(d.severity);
    icon.classList.add('icon');
    icon.setAttribute('aria-label', d.severity);
    icon.removeAttribute('aria-hidden');
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = d.message;
    const meta = diagnosticMeta(d, () => hideHint());
    meta.classList.add('meta');
    el.append(icon, msg, meta);
    el.onclick = () => { hideHint(); goToDiagnostic(d); };
    el.onkeydown = e => { if (e.key === 'Enter') { hideHint(); goToDiagnostic(d); } };
    return el;
}

// ---------------------------------------------------------------------------
// Gutter hint: click a lint dot to see that line's problems

const lineDiagnostics = new Map<number, Diagnostic[]>();
let hint: HTMLElement | null = null;
let hintLine = -1;

function showHint(line: number, focus = true) {
    const list = lineDiagnostics.get(line);
    if (!list?.length) { hideHint(); return; }
    hideHint();
    hintLine = line;
    hint = document.createElement('div');
    hint.className = 'lint-hint';
    hint.setAttribute('role', 'dialog');
    hint.setAttribute('aria-label', `Problems on line ${line + 1}`);
    const head = document.createElement('div');
    head.className = 'lint-hint-head';
    const title = el('span', 'lint-hint-title');
    const kinds = [...new Set(list.map(d => d.severity))].sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);
    title.append(...kinds.map(k => severityIcon(k)), el('strong', '', `Line ${line + 1}`), ` ${countLabel(list)}`);
    const close = el('button', 'lint-hint-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.onclick = hideHint;
    head.append(title, close);
    hint.append(head, ...list.map(d => problemElement(d, 'div')));
    document.body.append(hint);
    positionHint();
    if (focus) (hint.querySelector('.problem') as HTMLElement | null)?.focus({ preventScroll: true });
}

function positionHint() {
    if (!hint) return;
    const marker = editor.lineInfo(hintLine)?.gutterMarkers?.['lint-gutter'] as HTMLElement | undefined;
    const anchor = (marker?.isConnected ? marker : editor.getWrapperElement()).getBoundingClientRect();
    const margin = 8;
    const width = Math.min(420, window.innerWidth - 2 * margin);
    hint.style.width = `${width}px`;
    const left = Math.min(Math.max(margin, anchor.left), window.innerWidth - width - margin);
    hint.style.left = `${left}px`;
    const h = hint.offsetHeight;
    const below = anchor.bottom + 6;
    const top = below + h > window.innerHeight - margin && anchor.top - 6 - h > margin ? anchor.top - 6 - h : below;
    hint.style.top = `${Math.max(margin, top)}px`;
}

function hideHint() {
    hint?.remove();
    hint = null;
    hintLine = -1;
}

/** After diagnostics change, keep an open hint in sync with its line. */
function refreshHint() {
    if (hintLine < 0) return;
    if (lineDiagnostics.get(hintLine)?.length) showHint(hintLine, false); else hideHint();
}

editor.on('gutterClick', (_cm: CodeMirror.Editor, line: number, gutter: string) => {
    if (gutter !== 'lint-gutter') return;
    if (hint && hintLine === line) hideHint(); else showHint(line);
});
editor.on('scroll', () => positionHint());
window.addEventListener('resize', () => positionHint());
document.addEventListener('pointerdown', e => {
    const t = e.target as HTMLElement;
    if (hint && !hint.contains(t) && !t.closest('.lint-gutter, .CodeMirror-gutter-elt')) hideHint();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && hint) { hideHint(); editor.focus(); } });

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
let hoverMark: CodeMirror.TextMarker | null = null;

function hoverRange(range: SrcRange | null) {
    hoverMark?.clear();
    hoverMark = range ? editor.markText(toCM(range.from), toCM(range.to), { className: 'cm-node-hover' }) : null;
}

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
        const alt = altLabel(n);
        b.textContent = n.text !== undefined ? `${n.name} ${JSON.stringify(n.text)}` : alt ? `${n.name} (${alt})` : n.name;
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

// ---------------------------------------------------------------------------
// Symbols: references, definitions, rename

let refMarks: CodeMirror.TextMarker[] = [];
let currentRef: Ref | null = null;
const symbolBar = $('symbol-info');
const SYMBOL_HINT = 'Put the cursor on a name to see its references. Ctrl+click or F12 jumps to its definition; F2 renames it.';

function showReferences(pos: SrcPos) {
    const ref = scopes && parsedCode === editor.getValue() ? refAt(scopes, pos) : null;
    if (ref === currentRef && (ref || refMarks.length === 0)) return;
    currentRef = ref;
    for (const m of refMarks) m.clear();
    refMarks = [];
    if (!ref) { renderSymbolBar(null); return; }
    const sym = ref.symbol;
    editor.operation(() => {
        for (const r of sym.refs) {
            const cls = r === sym.def ? 'cm-ref cm-ref-def' : r.role === 'read' ? 'cm-ref' : 'cm-ref cm-ref-write';
            refMarks.push(editor.markText(toCM(r.range.from), toCM(r.range.to), { className: cls }));
        }
    });
    renderSymbolBar(ref);
}

function renderSymbolBar(ref: Ref | null) {
    if (!ref) { symbolBar.replaceChildren(SYMBOL_HINT); symbolBar.classList.remove('active'); return; }
    const sym = ref.symbol;
    symbolBar.classList.add('active');
    const name = document.createElement('code');
    name.textContent = sym.name;
    const writes = sym.refs.filter(r => r.role === 'write' || r.role === 'update').length;
    const parts: (string | Node)[] = [name, ` ${describeSymbol(sym, ref.scope)} · ${sym.refs.length} reference${sym.refs.length === 1 ? '' : 's'}`];
    if (writes) parts.push(`, ${writes} write${writes === 1 ? '' : 's'}`);
    if (sym.def && sym.def !== ref) {
        const go = document.createElement('button');
        go.textContent = `Definition (line ${sym.def.range.from.line + 1})`;
        go.onclick = () => goToDefinition(ref.range.from);
        parts.push(' ', go);
    }
    if (sym.def) {
        const rename = document.createElement('button');
        rename.textContent = 'Rename';
        rename.onclick = () => startRename();
        parts.push(' ', rename);
    }
    symbolBar.replaceChildren(...parts);
}

function goToDefinition(pos: SrcPos) {
    const ref = scopes ? refAt(scopes, pos) : null;
    const def = ref?.symbol.def;
    if (!def) return;
    editor.focus();
    editor.setSelection(toCM(def.range.from), toCM(def.range.to));
    editor.scrollIntoView({ from: toCM(def.range.from), to: toCM(def.range.to) }, 60);
}

/** Inline rename: the bar becomes a text field; Enter renames every reference of the symbol. */
function startRename() {
    const ref = currentRef ?? (scopes ? refAt(scopes, fromCM(editor.getCursor())) : null);
    if (!ref?.symbol.def) return;
    const sym = ref.symbol;
    const input = document.createElement('input');
    input.value = sym.name;
    input.setAttribute('aria-label', `New name for ${sym.name}`);
    const note = document.createElement('span');
    note.textContent = ` Rename ${sym.refs.length} reference${sym.refs.length === 1 ? '' : 's'} (Enter to apply, Esc to cancel)`;
    symbolBar.replaceChildren('Rename ', input, note);
    input.focus();
    input.select();
    const finish = (apply: boolean) => {
        const value = input.value.trim();
        if (apply && /^[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*$/.test(value) && value !== sym.name) {
            const refs = [...sym.refs].sort((a, b) => b.range.from.line - a.range.from.line || b.range.from.col - a.range.from.col);
            editor.operation(() => {
                for (const r of refs) editor.replaceRange(value, toCM(r.range.from), toCM(r.range.to), '+rename');
            });
        } else if (apply && value !== sym.name) {
            note.textContent = ' That is not a valid name.';
            return;
        }
        currentRef = null;
        editor.focus();
        renderSymbolBar(null);
    };
    input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    input.onblur = () => { if (symbolBar.contains(input)) finish(false); };
}

// ---------------------------------------------------------------------------
// Hover cards over code: what a name is, the problems there, and how the parser read it

const hoverTip = new Tip('tip-card tip-hover');
const editorWrap = editor.getWrapperElement();

const containsPos = (r: SrcRange, p: SrcPos) =>
    (r.from.line < p.line || r.from.line === p.line && r.from.col <= p.col) && (p.line < r.to.line || p.line === r.to.line && p.col <= r.to.col);

/** Screen box of a range's part on one line. */
function lineRect(r: SrcRange, line: number): DOMRect {
    const from = line === r.from.line ? toCM(r.from) : { line, ch: 0 };
    const to = line === r.to.line ? toCM(r.to) : { line, ch: editor.getLine(line)?.length ?? 0 };
    const a = editor.charCoords(from, 'window'), b = editor.charCoords(to, 'window');
    return new DOMRect(a.left, a.top, Math.max(b.left - a.left, 4), a.bottom - a.top);
}

const KIND_LABEL = (ref: Ref) => {
    const s = ref.symbol;
    if (s.kind === 'function') return 'function';
    if (s.kind === 'class') return 'class';
    if (s.kind === 'parameter') return 'parameter';
    return s.scope.kind === 'global' ? 'global variable' : 'local variable';
};

function symbolSection(ref: Ref): HTMLElement {
    const sym = ref.symbol;
    const code = el('div', 'tip-code cm-s-ahk-dark');
    const head = el('div', 'tip-code-line', el('span', 'tip-kind', `(${KIND_LABEL(ref)}) `));
    const name = el('span', '', sym.name);
    name.style.color = sym.kind === 'function' ? '#dcdcaa' : sym.kind === 'class' ? '#4ec9b0' : '#9cdcfe';
    head.append(name);
    code.append(head);
    if (sym.def) {
        let line = (parsedCode.split('\n')[sym.def.range.from.line] ?? '').replace(/(^|\s+);.*$/, '').trim();
        if (sym.kind === 'function' || sym.kind === 'class') line = line.replace(/\s*\{\s*$/, '');
        if (line.length > 90) line = line.slice(0, 89) + '…';
        const snippet = el('div', 'tip-code-line tip-def');
        snippet.innerHTML = highlightSnippet(line);
        snippet.prepend(el('span', 'tip-lineno', String(sym.def.range.from.line + 1)));
        code.append(snippet);
    }
    const writes = sym.refs.filter(r => r.role === 'write' || r.role === 'update').length;
    const desc = describeSymbol(sym, ref.scope);
    const text = el('div', 'tip-text', desc[0].toUpperCase() + desc.slice(1),
        el('span', 'tip-muted', ` · ${sym.refs.length} reference${sym.refs.length === 1 ? '' : 's'}${writes ? `, ${writes} write${writes === 1 ? '' : 's'}` : ''}`));
    const actions = el('div', 'tip-actions');
    if (sym.def && sym.def !== ref) {
        const go = el('button', 'tip-link', 'Go to definition ', kbd('F12'));
        go.onclick = () => { hoverTip.close(); goToDefinition(ref.range.from); };
        actions.append(go);
    }
    if (sym.def) {
        const ren = el('button', 'tip-link', 'Rename ', kbd('F2'));
        ren.onclick = () => {
            hoverTip.close();
            editor.focus();
            editor.setCursor(toCM(ref.range.from));
            currentRef = ref;
            startRename();
        };
        actions.append(ren);
    }
    return el('section', 'tip-section tip-symbol', code, text, actions.childElementCount ? actions : null);
}

function diagnosticSection(d: Diagnostic): HTMLElement {
    return el('section', `tip-section tip-diag sev-${d.severity}`, severityIcon(d.severity),
        el('div', 'tip-diag-body', el('div', 'tip-diag-msg', d.message), diagnosticMeta(d, () => hoverTip.close())));
}

/** Rules that only wrap a name; the hover footer names the rules above them instead. */
const NAME_WRAPPERS = new Set(['identifier', 'identifierName', 'memberIdentifier', 'propertyName', 'reservedWord', 'keyword']);

function treeFooter(pos: SrcPos): HTMLElement | null {
    const node = model.root ? nodeAtPos(model, pos) : null;
    const chain: ViewNode[] = [];
    for (let n = node; n && chain.length < 3; n = n.parent) {
        if (n.kind === 'rule' && (altLabel(n) || !NAME_WRAPPERS.has(n.name))) chain.unshift(n);
    }
    if (!chain.length) return null;
    const footer = el('footer', 'tip-footer', 'Parsed as ');
    chain.forEach((n, i) => {
        if (i) footer.append(' › ');
        footer.append(el('code', i === chain.length - 1 ? 'strong' : '', altLabel(n) ?? n.name));
    });
    const show = el('button', 'tip-link', 'Show in tree');
    show.onclick = () => { hoverTip.close(); select(chain[chain.length - 1], 'crumb'); };
    footer.append(' ', show);
    return footer;
}

function onEditorHover(e: MouseEvent) {
    if (e.buttons || hint || (e.target as Element).closest('.CodeMirror-gutters')) { hoverTip.close(150); return; }
    const pos = fromCM(editor.coordsChar({ left: e.clientX, top: e.clientY }, 'window'));
    const fresh = parsedCode === editor.getValue();
    const diags = fresh ? diagnostics.filter(d => containsPos(d.range, pos)) : [];
    const ref = fresh && scopes ? refAt(scopes, pos) : null;
    const anchorRange = ref?.range ?? diags[0]?.range;
    const rect = anchorRange ? lineRect(anchorRange, pos.line) : null;
    const inside = rect && e.clientX >= rect.left - 2 && e.clientX <= rect.right + 2 && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) { if (!hoverTip.contains(e.relatedTarget as Node | null)) hoverTip.close(180); return; }
    const key = `${ref?.symbol.key ?? ''}|${diags.map(d => `${d.rule}@${d.range.from.line}:${d.range.from.col}`).join(',')}|${pos.line}`;
    if (hoverTip.visible && hoverTip.owner === key) { hoverTip.keep(); return; }
    hoverTip.open(key, () => {
        const parts: Node[] = [];
        if (ref) parts.push(symbolSection(ref));
        for (const d of diags) parts.push(diagnosticSection(d));
        const footer = treeFooter(pos);
        if (footer) parts.push(footer);
        return parts;
    }, () => rect, hoverTip.visible ? 0 : 380, { placement: 'above', interactive: true });
}

editorWrap.addEventListener('mousemove', onEditorHover);
editorWrap.addEventListener('mouseleave', e => { if (!hoverTip.contains(e.relatedTarget as Node | null)) hoverTip.close(180); });
hoverTip.el.addEventListener('pointerleave', e => { if (!editorWrap.contains(e.relatedTarget as Node | null)) hoverTip.close(180); });
editor.on('scroll', () => hoverTip.close());
editor.on('change', () => hoverTip.close());
editor.on('keydown', (_cm: CodeMirror.Editor, e: KeyboardEvent) => { if (e.key === 'Escape') hoverTip.close(); });
window.addEventListener('resize', () => hoverTip.close());

installSimpleTips();

editor.on('mousedown', (_cm: CodeMirror.Editor, e: MouseEvent) => {
    hoverTip.close();
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    const pos = fromCM(editor.coordsChar({ left: e.clientX, top: e.clientY }, 'window'));
    if (!scopes || !refAt(scopes, pos)?.symbol.def) return;
    e.preventDefault();
    goToDefinition(pos);
});

/** The call graph node whose declaration holds the cursor. */
function callNodeAt(pos: SrcPos): string | null {
    let best: CallNode | null = null;
    for (const n of callNodes) {
        const f = n.full;
        if (f && cmpPos(f.from, pos) <= 0 && cmpPos(pos, f.to) <= 0 && (!best || cmpPos(f.from, best.full!.from) >= 0)) best = n;
    }
    return best?.id ?? null;
}

function syncCursor(reveal: boolean) {
    const pos = fromCM(editor.getCursor());
    showReferences(pos);
    symbolsView.markCursor(pos);
    callsView.markCurrent(callNodeAt(pos));
    refreshSteps();
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
    for (const t of TABS) {
        $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
        $(t).hidden = t !== tab;
    }
    document.body.dataset.tab = tab;
    if (tab === 'graph') renderGraph();
    if (tab === 'calls') void callsView.render();
    searchView.setActive(tab === 'pattern');
    stepsView.setActive(tab === 'steps');
    if (selected) { if (tab === 'graph') graph.reveal(selected); if (tab === 'outline') outline.reveal(selected); }
    syncCursor(false);
}
for (const t of TABS) $(`tab-${t}`).onclick = () => setTab(t);
// Arrow keys move between tabs, as in other tab lists.
$('tab-graph').parentElement!.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(activeTab) + (e.key === 'ArrowRight' ? 1 : -1);
    const next = TABS[(i + TABS.length) % TABS.length];
    setTab(next);
    $(`tab-${next}`).focus();
});

$('fold-sel').onclick = () => {
    if (!selected || !graph.toggleFold(selected)) {
        exNote.textContent = selected ? 'That box has nothing below it to fold.' : 'Select a box in the graph first, or double-click one to fold it.';
    }
};
$('unfold-all').onclick = () => graph.unfoldAll();

function exportImage(which: 'graph' | 'calls', format: 'svg' | 'png') {
    const svg = which === 'graph' ? graph.svgElement : callsView.svg;
    if (!svg) { exNote.textContent = 'There is no graph to export yet.'; return; }
    const base = which === 'graph' ? 'ahk-syntax-tree' : 'ahk-call-graph';
    const host = which === 'graph' ? 'view graph' : 'calls-graph';
    if (format === 'svg') exportSvg(svg, host, `${base}.svg`);
    else exportPng(svg, host, `${base}.png`).catch(e => { exNote.textContent = `The PNG could not be made: ${e?.message ?? e}. Try SVG instead.`; });
}
for (const which of ['graph', 'calls'] as const) {
    const menu = $<HTMLDetailsElement>(`${which}-export`);
    menu.querySelectorAll<HTMLButtonElement>('button[data-format]').forEach(b => {
        b.onclick = () => { menu.open = false; exportImage(which, b.dataset.format as 'svg' | 'png'); };
    });
}
document.addEventListener('pointerdown', e => {
    document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach(d => { if (!d.contains(e.target as Node)) d.open = false; });
});

$('zoom-in').onclick = () => graph.zoomBy(1.25);
$('zoom-out').onclick = () => graph.zoomBy(0.8);
$('zoom-fit').onclick = () => graph.fit();
$('zoom-100').onclick = () => graph.actualSize();
mergeBox.addEventListener('change', () => {
    store.set('merge', mergeBox.checked ? '1' : '0');
    graph.merge = mergeBox.checked;
    graph.resetView();
    graphDirty = true;
    if (activeTab === 'graph') renderGraph();
    if (selected) graph.mark('sel', [selected]);
});
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
// Examples picker. "Your code" and each edited example keep their own text in
// localStorage, so switching never loses anything. #ex=<id> links open an example.

const MINE = 'mine';
/** Code from a shared link or an opened file. Kept apart from "Your code". */
const SCRATCH = 'scratch';
const DEFAULT_EXAMPLE = 'arg-alias';
const MINE_STARTER = '; Your code. Type or paste AutoHotkey v2 code here.\n';
const exSelect = $<HTMLSelectElement>('examples');
const exNote = $('ex-note');
const exReset = $('ex-reset');
const exOptions = new Map<string, HTMLOptionElement>();
let current = MINE;
let loading = false;
let unsaved = false;

// Earlier versions kept a single 'code' slot. Keep it as "Your code" unless it is just the default.
const legacy = store.get('code');
if (legacy !== null) {
    if (store.get(MINE) === null && legacy.trim() !== exampleById(DEFAULT_EXAMPLE)!.code.trim()) {
        store.set(MINE, legacy);
        if (store.get('current') === null) store.set('current', MINE);
    }
    store.remove('code');
}

const editedKey = (ex: Example) => 'ex:' + ex.id;
const isEdited = (ex: Example) => store.get(editedKey(ex)) !== null;

const isSlot = (id: string | null) => id === MINE || id === SCRATCH && store.get(SCRATCH) !== null || !!(id && exampleById(id));

function textFor(id: string): string {
    if (id === SCRATCH) return store.get(SCRATCH) ?? '';
    const ex = exampleById(id);
    if (!ex) return store.get(MINE) ?? MINE_STARTER;
    return store.get(editedKey(ex)) ?? ex.code;
}

function buildPicker() {
    const mine = new Option('Your code', MINE);
    exOptions.set(MINE, mine);
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const ex of EXAMPLES) {
        let group = groups.get(ex.group);
        if (!group) {
            group = document.createElement('optgroup');
            group.label = ex.group;
            groups.set(ex.group, group);
        }
        const opt = new Option(ex.title, ex.id);
        exOptions.set(ex.id, opt);
        group.append(opt);
        renderOptionLabel(ex);
    }
    const scratch = new Option('', SCRATCH);
    exOptions.set(SCRATCH, scratch);
    exSelect.replaceChildren(mine, scratch, ...groups.values());
    renderScratchOption();
}

function renderScratchOption() {
    const opt = exOptions.get(SCRATCH)!;
    opt.textContent = store.get('scratch-label') ?? 'Shared or opened code';
    opt.hidden = opt.disabled = store.get(SCRATCH) === null;
}

function renderOptionLabel(ex: Example) {
    exOptions.get(ex.id)!.textContent = ex.title + (isEdited(ex) ? ' (edited)' : '');
}

function renderExampleInfo() {
    const ex = exampleById(current);
    exNote.textContent = ex ? ex.note
        : current === SCRATCH ? `${store.get('scratch-label') ?? 'Shared code'}. It's kept in this browser apart from Your code.`
        : 'Your own code, saved in this browser. Switching to an example keeps it.';
    exReset.hidden = !(ex && isEdited(ex));
}

/** Store the editor text in the current slot. An example edited back to its original is no longer "edited". */
function flushSave() {
    if (!unsaved) return;
    unsaved = false;
    const code = editor.getValue();
    if (current === SCRATCH) { store.set(SCRATCH, code); return; }
    const ex = exampleById(current);
    if (!ex) { store.set(MINE, code); return; }
    const was = isEdited(ex);
    if (code === ex.code) store.remove(editedKey(ex)); else store.set(editedKey(ex), code);
    if (isEdited(ex) !== was) { renderOptionLabel(ex); renderExampleInfo(); }
}

function setHash(id: string) {
    const want = id === MINE || id === SCRATCH ? '' : `#ex=${id}`;
    if (location.hash === want) return;
    try { history.replaceState(null, '', want || location.pathname + location.search); } catch { location.hash = want; }
}

function hashExample(): string | null {
    const m = /^#ex=([\w-]+)$/.exec(location.hash);
    return m && exampleById(m[1]) ? m[1] : null;
}

function showExample(id: string, opts: { updateHash?: boolean; keepHistory?: boolean } = {}) {
    flushSave();
    if (!isSlot(id)) id = MINE;
    current = id;
    store.set('current', id);
    exSelect.value = id;
    renderExampleInfo();
    if (opts.updateHash) setHash(id);
    hideHint();
    hoverRange(null);
    graph.resetView();
    clearTimeout(debounceTimer);
    loading = true;
    try { editor.setValue(textFor(id)); } finally { loading = false; }
    if (!opts.keepHistory) editor.clearHistory();
    editor.setCursor({ line: 0, ch: 0 });
    editor.scrollTo(0, 0);
    update(true);
}

function stepExample(dir: number) {
    const n = EXAMPLES.length;
    const i = EXAMPLES.findIndex(e => e.id === current);
    const next = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    showExample(EXAMPLES[next].id, { updateHash: true });
}

buildPicker();
exSelect.onchange = () => showExample(exSelect.value, { updateHash: true });
$('ex-prev').onclick = () => stepExample(-1);
$('ex-next').onclick = () => stepExample(1);
exReset.onclick = () => {
    const ex = exampleById(current);
    if (!ex) return;
    store.remove(editedKey(ex));
    unsaved = false;
    renderOptionLabel(ex);
    showExample(ex.id, { keepHistory: true });
};
window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#code=')) { void openSharedLink(); return; }
    const id = hashExample();
    if (id && id !== current) showExample(id);
});

// ---------------------------------------------------------------------------
// Share links and opening files

/** Put code in the scratch slot and show it. */
function openScratch(code: string, label: string) {
    flushSave();
    store.set(SCRATCH, code);
    store.set('scratch-label', label);
    renderScratchOption();
    showExample(SCRATCH);
}

function b64url(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
}

/** #code=z:<deflated, base64url> when the browser can compress, else #code=u:<UTF-8, base64url>. */
async function encodeCode(code: string): Promise<string> {
    const raw = new TextEncoder().encode(code);
    if (typeof CompressionStream === 'function') {
        try { return 'z:' + b64url(await pipe(raw, new CompressionStream('deflate-raw'))); } catch { /* fall back */ }
    }
    return 'u:' + b64url(raw);
}

async function decodeCode(data: string): Promise<string> {
    const [kind, body] = [data.slice(0, 2), data.slice(2)];
    const bytes = unb64url(body);
    if (kind === 'z:') return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')));
    if (kind === 'u:') return new TextDecoder().decode(bytes);
    throw new Error('unknown link format');
}

async function openSharedLink(): Promise<boolean> {
    const m = /^#code=(.+)$/.exec(location.hash);
    if (!m) return false;
    try {
        const code = await decodeCode(decodeURIComponent(m[1]));
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep the hash */ }
        openScratch(code, 'Shared link');
        return true;
    } catch {
        exNote.textContent = 'That share link could not be read. It may have been cut off when it was copied.';
        return false;
    }
}

const shareBtn = $('share');
shareBtn.onclick = async () => {
    flushSave();
    const code = editor.getValue();
    const ex = exampleById(current);
    // An unedited example has a short link already.
    const hash = ex && code === ex.code ? `#ex=${ex.id}` : `#code=${await encodeCode(code)}`;
    const url = location.origin + location.pathname + location.search + hash;
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch { /* clipboard blocked */ }
    if (!copied) { try { history.replaceState(null, '', hash); } catch { location.hash = hash; } }
    exNote.textContent = copied
        ? `Link copied (${url.length.toLocaleString()} characters). Anyone who opens it sees this code.`
        : 'Copying was blocked, so the link is in the address bar now. Copy it from there.';
};

async function readFileText(file: File): Promise<string> {
    const buf = new Uint8Array(await file.arrayBuffer());
    // AutoHotkey scripts are often UTF-8 with a BOM, sometimes UTF-16.
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    const text = new TextDecoder().decode(buf);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function openFile(file: File) {
    if (file.size > 5_000_000) { exNote.textContent = `${file.name} is over 5 MB, which is too large to explore here.`; return; }
    openScratch((await readFileText(file)).replace(/\r\n?/g, '\n'), `Opened: ${file.name}`);
}

const fileInput = $<HTMLInputElement>('file-input');
$('open-file').onclick = () => fileInput.click();
fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) void openFile(f);
    fileInput.value = '';
};
editor.on('drop', (_cm: CodeMirror.Editor, e: DragEvent) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    void openFile(f);
});
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

// ---------------------------------------------------------------------------
// Problems: F8 / Shift+F8 and fix all

function stepProblem(dir: number) {
    if (!diagnostics.length) return;
    const pos = fromCM(editor.getCursor());
    const list = dir > 0 ? diagnostics : [...diagnostics].reverse();
    const next = list.find(d => dir > 0 ? cmpPos(d.range.from, pos) > 0 : cmpPos(d.range.from, pos) < 0) ?? list[0];
    goToDiagnostic(next);
    showHint(next.range.from.line, false);
}

/** Apply every one-click fix that doesn't overlap another. */
function fixAll(): number {
    const taken: SrcRange[] = [];
    const overlaps = (a: SrcRange, b: SrcRange) => !(cmpPos(a.to, b.from) < 0 || cmpPos(b.to, a.from) < 0);
    const edits = diagnostics.filter(d => d.fix).flatMap(d => {
        const rs = d.fix!.edits.map(e => e.range);
        if (rs.some(r => taken.some(t => overlaps(r, t)))) return [];
        taken.push(...rs);
        return d.fix!.edits;
    });
    hideHint();
    applyEditsToEditor(edits, '+fix');
    return edits.length;
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl+K)

function paletteCommands(): Command[] {
    const actions: Command[] = [];
    const action = (id: string, title: string, run: () => void, extra: Partial<Command> = {}) =>
        actions.push({ id: 'a:' + id, group: 'action', title, run, ...extra });
    for (const t of TABS) action(`tab-${t}`, `Show the ${TAB_NAMES[t]} tab`, () => setTab(t), { keywords: `view panel ${t}` });
    const fixable = diagnostics.filter(d => d.fix).length;
    if (fixable) action('fix-all', `Fix all problems that have a fix (${fixable})`, () => fixAll(), { keywords: 'lint quick fix' });
    if (diagnostics.length) {
        action('next-problem', 'Go to the next problem', () => stepProblem(1), { keys: 'F8' });
        action('prev-problem', 'Go to the previous problem', () => stepProblem(-1), { keys: 'Shift+F8' });
    }
    action('definition', 'Go to definition', () => goToDefinition(fromCM(editor.getCursor())), { keys: 'F12' });
    action('rename', 'Rename the symbol at the cursor', () => { editor.focus(); startRename(); }, { keys: 'F2' });
    action('ssr', 'Search and replace by code shape', () => { setTab('pattern'); searchView.focus(); }, { keywords: 'structural find pattern' });
    action('steps', 'Step through the expression at the cursor', () => { setTab('steps'); editor.focus(); }, { keywords: 'evaluation order debug' });
    action('filter-symbols', 'Filter symbols', () => { setTab('symbols'); symbolsView.focusFilter(); });
    action('share', 'Copy a share link for this code', () => shareBtn.click(), { keywords: 'url' });
    action('open', 'Open a file…', () => fileInput.click(), { keywords: 'load ahk' });
    action('fit', 'Fit the graph to the view', () => { setTab('graph'); graph.fit(); }, { keywords: 'zoom' });
    action('fold', 'Fold or unfold the selected box in the graph', () => { setTab('graph'); $('fold-sel').click(); }, { keywords: 'collapse subtree' });
    action('fold-2', 'Fold the graph below the top levels', () => { setTab('graph'); graph.foldToDepth(3); }, { keywords: 'collapse overview' });
    action('unfold', 'Unfold the whole graph', () => { setTab('graph'); graph.unfoldAll(); }, { keywords: 'expand' });
    action('merge', `${mergeBox.checked ? 'Stop merging' : 'Merge'} single-child chains in the graph`, () => { mergeBox.checked = !mergeBox.checked; mergeBox.dispatchEvent(new Event('change')); });
    action('collapse', `${collapseBox.checked ? 'Show' : 'Hide'} rule nodes with one child`, () => { collapseBox.checked = !collapseBox.checked; collapseBox.dispatchEvent(new Event('change')); }, { keywords: 'collapse terminal' });
    for (const fmt of ['svg', 'png'] as const) {
        action(`export-graph-${fmt}`, `Export the syntax tree as ${fmt.toUpperCase()}`, () => { setTab('graph'); renderGraph(); exportImage('graph', fmt); }, { keywords: 'save image download' });
        action(`export-calls-${fmt}`, `Export the call graph as ${fmt.toUpperCase()}`, () => { setTab('calls'); void callsView.render().then(() => exportImage('calls', fmt)); }, { keywords: 'save image download' });
    }
    if (exampleById(current) && isEdited(exampleById(current)!)) action('reset', 'Reset this example', () => exReset.click());

    const symbols: Command[] = [];
    const walk = (items: SymbolItem[], parent: SymbolItem | null) => {
        for (const it of items) {
            const name = parent && parent.kind === 'class' && it.kind !== 'class' ? `${parent.name}.${it.name}` : it.name;
            symbols.push({
                id: `s:${it.kind}:${name}:${it.range.from.line}`, group: 'symbol', title: name,
                detail: `${it.detail ? it.detail + '  ' : ''}line ${it.range.from.line + 1}`, badge: kindBadge(it.kind),
                run: () => goToRange(it.range),
            });
            walk(it.children, it);
        }
    };
    walk(symbolItems, null);

    const examples: Command[] = EXAMPLES.map(ex => ({
        id: 'e:' + ex.id, group: 'example', title: ex.title, detail: ex.group, keywords: ex.note,
        run: () => showExample(ex.id, { updateHash: true }),
    }));
    return [...actions, ...symbols, ...examples];
}

const palette = new Palette(paletteCommands);
const paletteBtn = $('open-palette');
// Built here: the HTML minifier drops elements that follow an inline SVG in a button.
paletteBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.6"></circle><path d="M10.4 10.4L14 14"></path></svg>';
paletteBtn.append(el('span', 'palette-btn-label', 'Go to anything'), kbd('Ctrl+K'));
paletteBtn.onclick = () => palette.open();
document.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'k' && !e.shiftKey || key === 'p' && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (palette.isOpen) palette.close(); else palette.open(key === 'p' ? '>' : '');
    }
}, true);

// ---------------------------------------------------------------------------
// Wiring

let debounceTimer: number | undefined;
editor.on('change', () => {
    if (loading) return;
    unsaved = true;
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
renderSymbolBar(null);
const storedCurrent = store.get('current');
showExample(hashExample() ?? (isSlot(storedCurrent) ? storedCurrent! : DEFAULT_EXAMPLE));
void openSharedLink();
