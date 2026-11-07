import * as Antlr4 from 'antlr4ng';
import * as P from './parser/AutoHotkeyParser';
import { rangeOf } from './model';
import type { SrcRange } from './parse';
import type { ScopeInfo, Scope } from './scope';
import { cmpPos, refAt } from './scope';

// ---------------------------------------------------------------------------
// Document symbols: the outline of declarations

export type SymbolKind = 'class' | 'method' | 'property' | 'field' | 'function' | 'hotkey' | 'hotstring' | 'variable';

export interface SymbolItem {
    kind: SymbolKind;
    name: string;
    /** Parameters, base class, accessors or reference count. */
    detail: string;
    /** The name, for selecting. */
    range: SrcRange;
    /** The whole declaration, for "is the cursor inside". */
    full: SrcRange;
    isStatic?: boolean;
    children: SymbolItem[];
}

const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Source text of a range from the original code (columns are code points). */
export function sliceCode(code: string, r: SrcRange): string {
    const lines = code.split('\n');
    const out: string[] = [];
    for (let l = r.from.line; l <= r.to.line; l++) {
        const chars = [...(lines[l] ?? '')];
        out.push(chars.slice(l === r.from.line ? r.from.col : 0, l === r.to.line ? r.to.col : chars.length).join(''));
    }
    return out.join('\n');
}

function params(list: P.FormalParameterListContext | null | undefined, code: string): string {
    const r = list ? rangeOf(list) : null;
    return `(${r ? ws(sliceCode(code, r)) : ''})`;
}

function isStatic(el: Antlr4.ParseTree): boolean {
    for (let i = 0; i < el.getChildCount(); i++) {
        const c = el.getChild(i)!;
        if (c instanceof Antlr4.TerminalNode && c.getText().toLowerCase() === 'static') return true;
    }
    return false;
}

export function documentSymbols(tree: Antlr4.ParseTree, scopes: ScopeInfo, code: string): SymbolItem[] {
    const make = (kind: SymbolKind, nameNode: Antlr4.ParseTree, full: Antlr4.ParseTree, detail: string, name?: string): SymbolItem | null => {
        const range = rangeOf(nameNode), fr = rangeOf(full);
        if (!range || !fr) return null;
        return { kind, name: name ?? nameNode.getText(), detail, range, full: fr, children: [] };
    };

    const classItem = (c: P.ClassDeclarationContext): SymbolItem | null => {
        const ext = c.classExtensionName();
        const item = make('class', c.identifier(), c, ext ? `extends ${ext.getText()}` : '');
        if (!item) return null;
        for (const el of c.classTail().classElement()) {
            let child: SymbolItem | null = null;
            if (el instanceof P.NestedClassDeclarationContext) child = classItem(el.classDeclaration());
            else if (el instanceof P.ClassMethodDeclarationContext) {
                const m = el.methodDefinition();
                const head = m.functionHead();
                child = make('method', head.identifierName(), m, params(head.formalParameterList(), code) + (m.functionBody().getText().startsWith('=>') ? ' =>' : ''));
            } else if (el instanceof P.ClassPropertyDeclarationContext) {
                const p = el.propertyDefinition();
                const cpn = p.classPropertyName();
                const acc = [p.propertyGetterDefinition().length ? 'get' : '', p.propertySetterDefinition().length ? 'set' : '', p.Arrow() ? '=>' : '']
                    .filter(Boolean).join(' ');
                const idx = cpn.formalParameterList() ? `[${ws(sliceCode(code, rangeOf(cpn.formalParameterList()!)!))}] ` : '';
                child = make('property', cpn.propertyName(), p, `${idx}{ ${acc || 'get'} }`);
            } else if (el instanceof P.ClassFieldDeclarationContext) {
                for (const f of el.fieldDefinition()) {
                    const names = f.propertyName();
                    const field = make('field', names[0], f, ':= ' + clip(ws(sliceCode(code, rangeOf(f.singleExpression())!)), 28),
                        names.map(n => n.getText()).join('.'));
                    if (field) { field.isStatic = isStatic(el); item.children.push(field); }
                }
                continue;
            }
            if (child) {
                child.isStatic = isStatic(el);
                item.children.push(child);
            }
        }
        return item;
    };

    const out: SymbolItem[] = [];
    const visit = (n: Antlr4.ParseTree, into: SymbolItem[]) => {
        if (n instanceof Antlr4.TerminalNode) return;
        if (n instanceof P.ClassDeclarationContext) { const c = classItem(n); if (c) into.push(c); return; }
        if (n instanceof P.FunctionDeclarationContext) {
            const head = n.functionHead();
            const f = make('function', head.identifierName(), n, params(head.formalParameterList(), code));
            if (f) { into.push(f); visit(n.block(), f.children); }
            return;
        }
        if (n instanceof P.FatArrowExpressionContext) {
            const named = n.fatArrowExpressionHead().functionExpressionHead()?.functionHead();
            if (named) {
                const f = make('function', named.identifierName(), n, params(named.formalParameterList(), code) + ' =>');
                if (f) into.push(f);
                return;
            }
        }
        if (n instanceof P.HotkeyContext || n instanceof P.HotstringContext) {
            const trig = n.getChild(0)!;
            const kind = n instanceof P.HotkeyContext ? 'hotkey' : 'hotstring';
            const text = trig.getText().replace(/\r?\n$/, '');
            const h = make(kind, trig, n, '', kind === 'hotkey' ? text.replace(/::$/, '') : text);
            if (h) {
                if (n instanceof P.HotstringContext && n.hotstringExpansion()) h.detail = '→ ' + clip(ws(n.hotstringExpansion()!.getText()), 30);
                into.push(h);
                for (let i = 1; i < n.getChildCount(); i++) visit(n.getChild(i)!, h.children);
            }
            return;
        }
        for (let i = 0; i < n.getChildCount(); i++) visit(n.getChild(i)!, into);
    };
    visit(tree, out);

    // Global variables, in order of their first assignment.
    const globals: SymbolItem[] = [];
    for (const sym of scopes.symbols.values()) {
        if (sym.scope.kind !== 'global' || sym.kind !== 'variable' || !sym.def) continue;
        globals.push({
            kind: 'variable', name: sym.name, detail: `${sym.refs.length} reference${sym.refs.length === 1 ? '' : 's'}`,
            range: sym.def.range, full: sym.def.range, children: [],
        });
    }
    globals.sort((a, b) => cmpPos(a.range.from, b.range.from));
    out.push(...globals);
    return out;
}

const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// ---------------------------------------------------------------------------
// Call graph

export type CallNodeKind = 'auto' | 'function' | 'method' | 'property' | 'hotkey' | 'class';

export interface CallNode {
    id: string;
    kind: CallNodeKind;
    label: string;
    range: SrcRange | null;
    /** The whole declaration, for "is the cursor inside". */
    full?: SrcRange | null;
}

export interface CallEdge {
    from: string;
    to: string;
    /** call, or the registering function for callbacks (SetTimer, OnEvent, ...). */
    via: string;
    /** Resolved by method name only (receiver unknown). */
    guess?: boolean;
    count: number;
}

const CALLBACK_FUNCS = new Set(['settimer', 'hotkey', 'onmessage', 'onexit', 'onerror', 'onclipboardchange', 'hotif', 'callbackcreate']);
const CALLBACK_METHODS = new Set(['onevent', 'onnotify', 'oncommand', 'add', 'insert', 'bind']);

export function callGraph(tree: Antlr4.ParseTree, scopes: ScopeInfo): { nodes: CallNode[]; edges: CallEdge[] } {
    const nodes = new Map<string, CallNode>();
    const edges = new Map<string, CallEdge>();
    const methodsByName = new Map<string, string[]>(); // lower method name -> node ids
    const classMethods = new Map<string, Map<string, string>>(); // lower class -> lower method -> id

    const addNode = (n: CallNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
    addNode({ id: 'auto', kind: 'auto', label: 'Auto-execute', range: null });

    // Pass 1: declarations.
    const fnId = new Map<Antlr4.ParseTree, string>(); // declaration node -> id
    const collect = (n: Antlr4.ParseTree, cls: string | null) => {
        if (n instanceof Antlr4.TerminalNode) return;
        if (n instanceof P.ClassDeclarationContext) {
            const name = n.identifier().getText();
            const full = cls ? `${cls}.${name}` : name;
            addNode({ id: `class:${full.toLowerCase()}`, kind: 'class', label: full, range: rangeOf(n.identifier()) });
            for (let i = 0; i < n.getChildCount(); i++) collect(n.getChild(i)!, full);
            return;
        }
        if (n instanceof P.MethodDefinitionContext && cls) {
            const name = n.functionHead().identifierName().getText();
            const id = addNode({ id: `m:${cls.toLowerCase()}.${name.toLowerCase()}`, kind: 'method', label: `${cls}.${name}`, range: rangeOf(n.functionHead().identifierName()), full: rangeOf(n) });
            fnId.set(n, id);
            methodsByName.set(name.toLowerCase(), [...(methodsByName.get(name.toLowerCase()) ?? []), id]);
            if (!classMethods.has(cls.toLowerCase())) classMethods.set(cls.toLowerCase(), new Map());
            classMethods.get(cls.toLowerCase())!.set(name.toLowerCase(), id);
        } else if (n instanceof P.PropertyDefinitionContext && cls) {
            const name = n.classPropertyName().propertyName().getText();
            const id = addNode({ id: `m:${cls.toLowerCase()}.${name.toLowerCase()}`, kind: 'property', label: `${cls}.${name}`, range: rangeOf(n.classPropertyName()), full: rangeOf(n) });
            fnId.set(n, id);
        } else if (n instanceof P.FunctionDeclarationContext) {
            const name = n.functionHead().identifierName().getText();
            fnId.set(n, addNode({ id: `f:${name.toLowerCase()}@${rangeOf(n)?.from.line}`, kind: 'function', label: `${name}()`, range: rangeOf(n.functionHead().identifierName()), full: rangeOf(n) }));
        } else if (n instanceof P.FatArrowExpressionContext) {
            const named = n.fatArrowExpressionHead().functionExpressionHead()?.functionHead();
            if (named) fnId.set(n, addNode({ id: `f:${named.identifierName().getText().toLowerCase()}@${rangeOf(n)?.from.line}`, kind: 'function', label: `${named.identifierName().getText()}()`, range: rangeOf(named.identifierName()), full: rangeOf(n) }));
        } else if (n instanceof P.HotkeyContext || n instanceof P.HotstringContext) {
            const trig = n.getChild(0)!.getText().replace(/\r?\n$/, '');
            fnId.set(n, addNode({ id: `h:${rangeOf(n)?.from.line}`, kind: 'hotkey', label: n instanceof P.HotkeyContext ? trig.replace(/::$/, '') : trig, range: rangeOf(n.getChild(0)!), full: rangeOf(n) }));
        }
        for (let i = 0; i < n.getChildCount(); i++) collect(n.getChild(i)!, cls);
    };
    collect(tree, null);

    // Symbols for function names, so calls resolve through scopes (nested functions, shadowing).
    const idForSymbolDef = new Map<string, string>(); // def position -> node id
    for (const [decl, id] of fnId) {
        const node = nodes.get(id)!;
        if (node.range && (node.kind === 'function')) idForSymbolDef.set(`${node.range.from.line}:${node.range.from.col}`, id);
        void decl;
    }
    const classIdByName = (name: string) => nodes.has(`class:${name.toLowerCase()}`) ? `class:${name.toLowerCase()}` : null;
    const resolveName = (id: P.IdentifierExpressionContext): string | null => {
        const r = rangeOf(id);
        if (!r) return null;
        const ref = refAt(scopes, r.from);
        const def = ref?.symbol.def;
        if (!ref || !def) return null;
        if (ref.symbol.kind === 'function') return idForSymbolDef.get(`${def.range.from.line}:${def.range.from.col}`) ?? null;
        if (ref.symbol.kind === 'class') {
            const ctor = classMethods.get(ref.symbol.name.toLowerCase())?.get('__new');
            return ctor ?? classIdByName(ref.symbol.name);
        }
        return null;
    };

    const addEdge = (from: string, to: string, via: string, guess = false) => {
        const key = `${from}->${to}|${via}`;
        const e = edges.get(key);
        if (e) e.count++; else edges.set(key, { from, to, via, guess, count: 1 });
    };

    // Pass 2: calls, attributed to the innermost named function, method or hotkey.
    const callerOf = (n: Antlr4.ParseTree | null): { id: string; cls: string | null } => {
        let cls: string | null = null;
        let id: string | null = null;
        for (let p = n; p; p = p.parent) {
            if (!id && fnId.has(p)) id = fnId.get(p)!;
            if (p instanceof P.ClassDeclarationContext) cls = cls ? `${p.identifier().getText()}.${cls}` : p.identifier().getText();
        }
        return { id: id ?? 'auto', cls };
    };
    const targetOf = (callee: P.PrimaryExpressionContext, cls: string | null): { id: string; guess: boolean } | null => {
        if (callee instanceof P.IdentifierExpressionContext) {
            const id = resolveName(callee);
            return id ? { id, guess: false } : null;
        }
        if (callee instanceof P.AccessExpressionContext && callee.accessSuffix() instanceof P.MemberAccessContext) {
            const m = (callee.accessSuffix() as P.MemberAccessContext).memberIdentifier().getText().toLowerCase();
            const recv = callee.primaryExpression().getText();
            const rl = recv.toLowerCase();
            if ((rl === 'this' || rl === 'super') && cls) {
                const id = classMethods.get(cls.toLowerCase())?.get(m);
                if (id) return { id, guess: false };
            }
            const direct = classMethods.get(rl)?.get(m);
            if (direct) return { id: direct, guess: false };
            const byName = methodsByName.get(m);
            if (byName?.length === 1) return { id: byName[0], guess: true };
        }
        return null;
    };
    const callbackTarget = (arg: P.SingleExpressionContext | null): string | null => {
        if (!arg) return null;
        let e: Antlr4.ParseTree | null = arg;
        // Fn.Bind(...) and ObjBindMethod(obj, "M") register Fn / M.
        if (e instanceof P.AtomExpressionContext) e = e.primaryExpression();
        if (e instanceof P.AccessExpressionContext && e.accessSuffix() instanceof P.FunctionCallAccessContext) {
            const inner = e.primaryExpression();
            if (inner instanceof P.AccessExpressionContext && inner.accessSuffix() instanceof P.MemberAccessContext
                && (inner.accessSuffix() as P.MemberAccessContext).memberIdentifier().getText().toLowerCase() === 'bind') e = inner.primaryExpression();
        }
        if (e instanceof P.IdentifierExpressionContext) return resolveName(e);
        return null;
    };

    const visitCalls = (n: Antlr4.ParseTree) => {
        if (n instanceof Antlr4.TerminalNode) return;
        let callee: P.PrimaryExpressionContext | null = null;
        let args: P.ArgumentsContext | null = null;
        if (n instanceof P.FunctionCallAccessContext && n.parent instanceof P.AccessExpressionContext) { callee = n.parent.primaryExpression(); args = n.arguments(); }
        else if (n instanceof P.FunctionStatementContext) { callee = n.primaryExpression(); args = n.arguments(); }
        if (callee) {
            const { id: from, cls } = callerOf(n);
            const t = targetOf(callee, cls);
            if (t) addEdge(from, t.id, 'call', t.guess);
            // Callbacks registered here.
            const name = (callee instanceof P.IdentifierExpressionContext ? callee.getText()
                : callee instanceof P.AccessExpressionContext && callee.accessSuffix() instanceof P.MemberAccessContext
                    ? (callee.accessSuffix() as P.MemberAccessContext).memberIdentifier().getText() : '').toLowerCase();
            if (args && (CALLBACK_FUNCS.has(name) || CALLBACK_METHODS.has(name) && name !== 'bind')) {
                for (const a of args.argument()) {
                    const target = callbackTarget(a.singleExpression());
                    if (target) addEdge(from, target, callee.getText().replace(/^.*\./, '').replace(/^\w/, c => c.toUpperCase()));
                }
            }
        }
        for (let i = 0; i < n.getChildCount(); i++) visitCalls(n.getChild(i)!);
    };
    visitCalls(tree);

    // Drop classes nothing points at and that have no constructor edge; keep the graph about code.
    const used = new Set<string>();
    for (const e of edges.values()) { used.add(e.from); used.add(e.to); }
    for (const [id, n] of nodes) if ((n.kind === 'class' || n.kind === 'property') && !used.has(id)) nodes.delete(id);
    if (!used.has('auto')) nodes.delete('auto');
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export type { Scope };
