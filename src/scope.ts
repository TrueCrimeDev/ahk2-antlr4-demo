import * as Antlr4 from 'antlr4ng';
import * as P from './parser/AutoHotkeyParser';
import { rangeOf } from './model';
import type { SrcPos, SrcRange } from './parse';
import { BUILTIN_VARIABLE_MAP } from './builtins';

/**
 * Variable scopes, following AutoHotkey v2's rules (checked against 2.1-alpha):
 * - Functions, methods, hotkeys and fat arrows are assume-local: a name a function assigns is
 *   local unless declared global; a name it only reads refers to the global.
 * - A nested function or fat arrow inside a function shares the outer function's variables
 *   (and parameters) for both reading and assigning.
 * - Function names, and class names at the top level, are read-only variables of the scope
 *   that declares them, compared without case.
 */

export type ScopeKind = 'global' | 'function' | 'arrow' | 'method' | 'hotkey';

export interface Scope {
    id: number;
    kind: ScopeKind;
    /** Function or method name, hotkey trigger, or "anonymous function". */
    name: string;
    /** Where names this scope does not own are looked up: the outer function, else global. */
    parent: Scope | null;
    node: Antlr4.ParseTree;
    params: Set<string>;
    /** Declared local or static. */
    locals: Set<string>;
    /** Declared global. */
    globals: Set<string>;
    /** Assigned, incremented, passed with &, or set by for/catch. */
    assigned: Set<string>;
    /** Functions (and, globally, classes) declared directly in this scope. */
    functions: Set<string>;
    /** A lone "global" line: names not declared local are global (assume-global mode). */
    assumeGlobal?: boolean;
}

/**
 * read: value used. write: replaced (:=, for, catch, &). update: read and replaced (+=, ++).
 * param: parameter. declare: global/local/static declaration. function/class: a definition's name.
 */
export type RefRole = 'read' | 'write' | 'update' | 'param' | 'declare' | 'function' | 'class';

export interface Ref {
    name: string;
    lname: string;
    range: SrcRange;
    /** The scope the name appears in. */
    scope: Scope;
    role: RefRole;
    /** Operator for writes and updates (:=, +=, ++, &, for, catch). */
    op?: string;
    symbol: Sym;
}

export type SymKind = 'variable' | 'parameter' | 'function' | 'class';

export interface Sym {
    key: string;
    name: string;
    /** The scope that owns it. */
    scope: Scope;
    kind: SymKind;
    /** Declaration, parameter, or first write. */
    def: Ref | null;
    refs: Ref[];
}

export interface ScopeInfo {
    scopes: Scope[];
    /** Every variable, function and class name, in source order. */
    refs: Ref[];
    symbols: Map<string, Sym>;
}

type PendingRef = Omit<Ref, 'symbol'>;

export function analyzeScopes(tree: Antlr4.ParseTree): ScopeInfo {
    const scopes: Scope[] = [];
    const pending: PendingRef[] = [];
    const newScope = (kind: ScopeKind, name: string, parent: Scope | null, node: Antlr4.ParseTree): Scope => {
        const s: Scope = { id: scopes.length, kind, name, parent, node, params: new Set(), locals: new Set(), globals: new Set(), assigned: new Set(), functions: new Set() };
        scopes.push(s);
        return s;
    };
    const global = newScope('global', 'global', null, tree);
    // Nested functions see the enclosing function's variables; everything else looks up globals.
    const outerFor = (scope: Scope) => scope.kind === 'global' ? global : scope;

    const addRef = (id: Antlr4.ParseTree | null | undefined, scope: Scope, role: RefRole, op?: string) => {
        if (!id) return;
        const range = rangeOf(id);
        if (!range) return;
        const name = id.getText();
        const lname = name.toLowerCase();
        pending.push({ name, lname, range, scope, role, op });
        if (role === 'param') scope.params.add(lname);
        else if (role === 'write' || role === 'update') scope.assigned.add(lname);
        else if (role === 'function' || role === 'class') scope.functions.add(lname);
    };

    const addParams = (list: P.FormalParameterListContext | null | undefined, scope: Scope) => {
        if (!list) return;
        const args = [...list.formalParameterArg()];
        const last = list.lastFormalParameterArg();
        if (last?.formalParameterArg()) args.push(last.formalParameterArg()!);
        for (const a of args) {
            addRef(a.identifier(), scope, 'param');
            const dflt = a.singleExpression();
            if (dflt) visit(dflt, scope);
        }
        if (last?.identifier()) addRef(last.identifier(), scope, 'param'); // Variadic: name*
    };

    const visitChildren = (n: Antlr4.ParseTree, scope: Scope, skip?: Antlr4.ParseTree | null) => {
        for (let i = 0; i < n.getChildCount(); i++) {
            const c = n.getChild(i)!;
            if (c !== skip) visit(c, scope);
        }
    };

    function visit(n: Antlr4.ParseTree, scope: Scope): void {
        if (n instanceof Antlr4.TerminalNode) return;

        if (n instanceof P.ClassDeclarationContext) {
            addRef(n.identifier(), scope, 'class');
            visitChildren(n, global); // Members get their own scopes; the class name itself is skipped below.
            return;
        }
        if (n instanceof P.ClassExtensionNameContext) {
            addRef(n.identifier(0), global, 'read'); // Base class; the rest are member names.
            return;
        }
        if (n instanceof P.FunctionDeclarationContext) {
            const head = n.functionHead();
            addRef(head.identifierName(), scope, 'function');
            const s = newScope('function', head.identifierName().getText(), outerFor(scope), n);
            addParams(head.formalParameterList(), s);
            visit(n.block(), s);
            return;
        }
        if (n instanceof P.MethodDefinitionContext) {
            const head = n.functionHead();
            const s = newScope('method', head.identifierName().getText(), global, n);
            s.params.add('this');
            addParams(head.formalParameterList(), s);
            visit(n.functionBody(), s);
            return;
        }
        if (n instanceof P.PropertyDefinitionContext) {
            const cpn = n.classPropertyName();
            const s = newScope('method', cpn.propertyName().getText(), global, n);
            s.params.add('this');
            s.params.add('value');
            addParams(cpn.formalParameterList(), s);
            visitChildren(n, s, cpn);
            return;
        }
        if (n instanceof P.FieldDefinitionContext) {
            const s = newScope('method', n.propertyName(0)?.getText() ?? 'field', global, n);
            s.params.add('this');
            visit(n.singleExpression(), s);
            return;
        }
        if (n instanceof P.FatArrowExpressionContext) {
            const head = n.fatArrowExpressionHead();
            const feh = head.functionExpressionHead();
            const named = feh?.functionHead();
            if (named) addRef(named.identifierName(), scope, 'function');
            const s = newScope(named ? 'function' : 'arrow', named ? named.identifierName().getText() : 'anonymous function', outerFor(scope), n);
            if (feh) addParams(named ? named.formalParameterList() : feh.formalParameterList(), s);
            else if (head.identifierName()) addRef(head.identifierName(), s, 'param');
            const body = n.singleExpression();
            if (body) visit(body, s);
            return;
        }
        if (n instanceof P.HotkeyContext || n instanceof P.HotstringContext) {
            const trigger = n.getChild(0)?.getText().replace(/::$/, '') ?? 'hotkey';
            const s = newScope('hotkey', trigger, global, n);
            s.params.add('thishotkey');
            visitChildren(n, s);
            return;
        }
        if (n instanceof P.VariableStatementContext) {
            const kw = n.getChild(0)?.getText().toLowerCase();
            if (kw === 'global' && !n.variableDeclarationList()?.variableDeclaration().length) scope.assumeGlobal = true;
            for (const decl of n.variableDeclarationList()?.variableDeclaration() ?? []) {
                const id = decl.assignable()?.identifier();
                if (!id) continue;
                const lname = id.getText().toLowerCase();
                if (kw === 'global') scope.globals.add(lname);
                else scope.locals.add(lname);
                const init = decl.singleExpression();
                addRef(id, scope, init ? 'write' : 'declare', init ? ':=' : kw);
                if (init) visit(init, scope);
            }
            return;
        }
        if (n instanceof P.IdentifierContext) {
            classifyIdentifier(n, scope);
            return;
        }
        visitChildren(n, scope);
    }

    function classifyIdentifier(id: P.IdentifierContext, scope: Scope) {
        const parent = id.parent;
        if (parent instanceof P.IdentifierExpressionContext) {
            const up = parent.parent;
            if (up instanceof P.AssignmentExpressionContext && up.primaryExpression() === parent) {
                const op = up.assignmentOperator().getText();
                addRef(id, scope, op === ':=' ? 'write' : 'update', op);
            } else if (up instanceof P.VarRefExpressionContext) {
                addRef(id, scope, 'write', '&');
            } else if (up instanceof P.AtomExpressionContext && (up.parent instanceof P.PreIncrementDecrementExpressionContext
                || up.parent instanceof P.PostIncrementDecrementExpressionContext)) {
                addRef(id, scope, 'update', up.parent.getText().replace(/[^+-]/g, '').slice(0, 2));
            } else {
                addRef(id, scope, 'read');
            }
        } else if (parent instanceof P.AssignableContext) {
            addRef(id, scope, 'write', parent.parent instanceof P.ForInParametersContext ? 'for' : ':=');
        } else if (parent instanceof P.CatchAssignableContext) {
            addRef(id, scope, 'write', 'catch');
        } else if (parent instanceof P.CatchClassesContext) {
            // "catch as e" parses "as" as a class name; it is the keyword.
            if (id.getText().toLowerCase() !== 'as') addRef(id, scope, 'read');
        }
        // Member names, property names and labels are not variables.
    }

    visit(tree, global);

    // Resolve each name to the scope that owns it.
    const owns = (s: Scope, lname: string) => s.params.has(lname) || s.locals.has(lname) || s.assigned.has(lname) || s.functions.has(lname);
    const resolve = (ref: PendingRef): Scope => {
        const s = ref.scope;
        const lname = ref.lname;
        if (ref.role === 'param' || ref.role === 'function' || ref.role === 'class') return s;
        if (s.kind === 'global' || s.globals.has(lname)) return global;
        if (s.params.has(lname) || s.locals.has(lname) || s.functions.has(lname)) return s;
        // Built-in variables (A_Clipboard, A_Index, ...) are never local, even when assigned.
        if (BUILTIN_VARIABLE_MAP.has(lname) && !s.params.has(lname)) return global;
        for (let p = s.parent; p && p.kind !== 'global'; p = p.parent) {
            if (p.globals.has(lname)) return global;
            if (owns(p, lname)) return p;
        }
        if (s.assigned.has(lname) && !s.assumeGlobal) return s;
        return global;
    };

    const symbols = new Map<string, Sym>();
    const refs: Ref[] = [];
    for (const pr of pending) {
        const owner = resolve(pr);
        const key = `${owner.id}:${pr.lname}`;
        let sym = symbols.get(key);
        if (!sym) {
            sym = { key, name: pr.name, scope: owner, kind: 'variable', def: null, refs: [] };
            symbols.set(key, sym);
        }
        const ref = pr as Ref;
        ref.symbol = sym;
        sym.refs.push(ref);
        refs.push(ref);
    }
    for (const sym of symbols.values()) {
        sym.refs.sort((a, b) => cmpPos(a.range.from, b.range.from));
        const def = sym.refs.find(r => r.role === 'function' || r.role === 'class')
            ?? sym.refs.find(r => r.role === 'param')
            ?? sym.refs.find(r => r.role === 'declare' || r.role === 'write' || r.role === 'update')
            ?? null;
        sym.def = def;
        sym.kind = def?.role === 'function' ? 'function' : def?.role === 'class' ? 'class'
            : def?.role === 'param' || (!def && sym.scope.params.has(sym.refs[0].lname)) ? 'parameter' : 'variable';
        if (def) sym.name = def.name;
    }
    refs.sort((a, b) => cmpPos(a.range.from, b.range.from));
    return { scopes, refs, symbols };
}

export function cmpPos(a: SrcPos, b: SrcPos): number {
    return a.line - b.line || a.col - b.col;
}

/** The name at a position (inside or right after it), if any. */
export function refAt(info: ScopeInfo, pos: SrcPos): Ref | null {
    for (const r of info.refs) {
        const { from, to } = r.range;
        if (from.line === pos.line && from.col <= pos.col && pos.col <= to.col && to.line === pos.line) return r;
        if (from.line > pos.line) break;
    }
    return null;
}

/** "local in Bump", "global", "parameter of Add", ... */
export function describeSymbol(sym: Sym, from: Scope): string {
    const where = (s: Scope) => s.kind === 'global' ? 'global'
        : s.kind === 'hotkey' ? `the ${s.name} hotkey`
        : s.kind === 'arrow' ? 'an anonymous function' : s.name;
    let text: string;
    if (sym.kind === 'function') text = sym.scope.kind === 'global' ? 'function' : `function nested in ${where(sym.scope)}`;
    else if (sym.kind === 'class') text = 'class';
    else if (sym.kind === 'parameter') text = `${sym.def ? '' : 'implicit '}parameter of ${where(sym.scope)}`;
    else text = sym.scope.kind === 'global' ? 'global variable' : `local variable of ${where(sym.scope)}`;
    if (sym.scope !== from && sym.scope.kind !== 'global' && sym.kind !== 'function') text += ', captured by this closure';
    if (!sym.def && sym.scope.kind === 'global' && sym.kind === 'variable') text = /^a_/i.test(sym.name) ? 'built-in variable' : 'global, not assigned in this script (a built-in, or defined elsewhere)';
    return text;
}
