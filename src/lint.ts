import * as Antlr4 from 'antlr4ng';
import {
    AccessExpressionContext, ArgumentContext, ArgumentsContext, AssignmentExpressionContext, AtomExpressionContext,
    ClassDeclarationContext, FatArrowExpressionContext, FatArrowExpressionHeadContext, FormalParameterListContext,
    FunctionCallAccessContext, FunctionDeclarationContext, FunctionStatementContext, IdentifierExpressionContext,
    LiteralExpressionContext, MemberAccessContext, ParenthesizedExpressionContext, PostIncrementDecrementExpressionContext,
    PreIncrementDecrementExpressionContext, PrimaryExpressionContext, SingleExpressionContext, VarRefExpressionContext,
    ConcatenateExpressionContext, RelationalExpressionContext, PropertyAssignmentContext, MethodDefinitionContext,
    PropertyDefinitionContext, BlockContext, HotkeyContext, HotstringContext, FunctionBodyContext, StatementContext,
} from './parser/AutoHotkeyParser';
import { Diagnostic, Fix, SrcPos, SrcRange } from './parse';
import { rangeOf } from './model';
import { analyzeScopes, ScopeInfo, Scope, Ref } from './scope';

const DOCS = 'https://www.autohotkey.com/docs/alpha/';

export interface LintRuleInfo { id: string; title: string; description: string }

export const LINT_RULES: LintRuleInfo[] = [
    {
        id: 'arg-alias',
        title: 'Argument changed before the call',
        description: 'A plain variable passed as an argument is not read until the call runs, so another argument that assigns or increments it changes what the function receives.',
    },
    {
        id: 'callback-arity',
        title: 'Callback parameter count',
        description: 'Built-ins such as Hotkey, SetTimer, OnMessage and Gui OnEvent check the callback\'s parameters when it is registered and throw "Invalid callback function" if it cannot accept what they pass.',
    },
    {
        id: 'global-shadow',
        title: 'Global changed without a global declaration',
        description: 'Functions and hotkeys are assume-local: assigning a global\'s name without "global name" makes a new local. count++ or total += x on it then throws "This local variable has not been assigned a value."',
    },
    {
        id: 'name-conflict',
        title: 'Variable named like a function or class',
        description: 'Names ignore case, and a function or class name cannot be assigned in the scope that defines it, so t := 1 next to a function T() stops the script from loading.',
    },
    {
        id: 'property-call',
        title: 'Calling a function stored in a property',
        description: 'obj.f() passes obj as a hidden first argument. A function stored with obj.f := () => ... or {f: () => ...} that does not expect it throws "Too many parameters passed to function." Use obj.f.Call() or (obj.f)().',
    },
    {
        id: 'string-compare',
        title: '< or > with a string',
        description: 'AutoHotkey v2.1 throws TypeError ("Expected a Number but got a String") when < > <= >= get a non-numeric string. Use StrCompare(a, b) < 0.',
    },
    {
        id: 'space-index',
        title: 'Space before [ indexes',
        description: 'AutoHotkey reads value [1] as value[1], even with the space, so "Total: " [1, 2].Length indexes the string instead of joining. This grammar shows a concatenation there.',
    },
];

/** Lint a parse tree. `code` is the source it came from, used to build fixes. */
export function lint(tree: Antlr4.ParseTree, code = '', scopes: ScopeInfo = analyzeScopes(tree)): Diagnostic[] {
    const out: Diagnostic[] = [];
    const src = new Source(code);
    const functions = collectFunctions(tree);
    const stored = collectStoredFunctions(tree, functions);
    walk(tree, node => {
        if (node instanceof ArgumentsContext) checkArgAlias(node, out);
        if (node instanceof FunctionCallAccessContext) {
            const parent = node.parent;
            if (parent instanceof AccessExpressionContext) {
                checkCallbackArity(parent.primaryExpression(), node.arguments(), functions, out, src);
                checkPropertyCall(parent.primaryExpression(), node.arguments(), stored, out);
            }
        } else if (node instanceof FunctionStatementContext) {
            checkCallbackArity(node.primaryExpression(), node.arguments(), functions, out, src);
            checkPropertyCall(node.primaryExpression(), node.arguments(), stored, out);
        } else if (node instanceof RelationalExpressionContext) {
            checkStringCompare(node, out, src);
        } else if (node instanceof ConcatenateExpressionContext) {
            checkSpaceIndex(node, out, src);
        }
        return true;
    });
    checkScopes(scopes, out, src);
    return out;
}

// ---------------------------------------------------------------------------
// Source text, for fixes

class Source {
    private lines: string[];
    constructor(code: string) { this.lines = code.split('\n'); }
    get available() { return this.lines.length > 1 || this.lines[0] !== ''; }
    line(n: number): string { return this.lines[n] ?? ''; }
    /** Text of a range (columns are code points). */
    text(r: SrcRange): string {
        const out: string[] = [];
        for (let l = r.from.line; l <= r.to.line; l++) {
            const chars = [...this.line(l)];
            const a = l === r.from.line ? r.from.col : 0;
            const b = l === r.to.line ? r.to.col : chars.length;
            out.push(chars.slice(a, b).join(''));
        }
        return out.join('\n');
    }
    indentOf(line: number): string { return /^[ \t]*/.exec(this.line(line))![0]; }
}

const at = (p: SrcPos): SrcRange => ({ from: p, to: p });
const lineNo = (r: Ref | SrcRange) => ('range' in r ? r.range : r).from.line + 1;

// ---------------------------------------------------------------------------
// Tree helpers

function walk(node: Antlr4.ParseTree, visit: (n: Antlr4.ParseTree) => boolean) {
    if (!visit(node)) return;
    for (let i = 0; i < node.getChildCount(); i++) walk(node.getChild(i)!, visit);
}

interface ArgSlot { index: number; arg: ArgumentContext }

/** Arguments with their positions; empty slots like f(a,,b) still advance the index. */
function argSlots(args: ArgumentsContext | null): ArgSlot[] {
    const slots: ArgSlot[] = [];
    if (!args) return slots;
    let index = 0;
    for (let i = 0; i < args.getChildCount(); i++) {
        const c = args.getChild(i)!;
        if (c instanceof ArgumentContext) slots.push({ index, arg: c });
        else if (c instanceof Antlr4.TerminalNode && c.getText() === ',') index++;
    }
    return slots;
}

function identName(p: PrimaryExpressionContext | null | undefined): string | null {
    return p instanceof IdentifierExpressionContext ? p.identifier().getText() : null;
}

/** The variable an expression evaluates to without being dereferenced, if any. */
function deferredVar(e: SingleExpressionContext | null | undefined): string | null {
    if (!e) return null;
    if (e instanceof AtomExpressionContext) {
        const p = e.primaryExpression();
        if (p instanceof ParenthesizedExpressionContext) {
            const seq = p.expressionSequence().singleExpression();
            return deferredVar(seq[seq.length - 1]);
        }
        return identName(p);
    }
    if (e instanceof AssignmentExpressionContext) return identName(e.primaryExpression());
    if (e instanceof PreIncrementDecrementExpressionContext) return operandName(e.singleExpression());
    return null;
}

function operandName(e: SingleExpressionContext | null | undefined): string | null {
    if (e instanceof AtomExpressionContext) return identName(e.primaryExpression());
    return null;
}

interface Write { kind: 'assign' | 'increment' | 'ref'; op: string }

/** Writes to `name` that happen while an argument is evaluated. Fat-arrow bodies are skipped: they run later. */
function writesTo(root: Antlr4.ParseTree, name: string): Write[] {
    const writes: Write[] = [];
    const lname = name.toLowerCase();
    walk(root, n => {
        if (n instanceof FatArrowExpressionContext) return false;
        if (n instanceof AssignmentExpressionContext && identName(n.primaryExpression())?.toLowerCase() === lname)
            writes.push({ kind: 'assign', op: n.assignmentOperator().getText() });
        else if ((n instanceof PreIncrementDecrementExpressionContext || n instanceof PostIncrementDecrementExpressionContext)
            && operandName(n.singleExpression())?.toLowerCase() === lname)
            writes.push({ kind: 'increment', op: n.getText().replace(/[^+-]/g, '') });
        else if (n instanceof VarRefExpressionContext && identName(n.primaryExpression())?.toLowerCase() === lname)
            writes.push({ kind: 'ref', op: '&' });
        return true;
    });
    return writes;
}

// ---------------------------------------------------------------------------
// Rule: arg-alias

function checkArgAlias(args: ArgumentsContext, out: Diagnostic[]) {
    const slots = argSlots(args);
    if (slots.length < 2) return;
    for (const victim of slots) {
        if (victim.arg.Multiply()) continue; // Spread argument.
        const name = deferredVar(victim.arg.singleExpression());
        if (!name) continue;
        // Arguments run left to right, so only a change made by a later argument
        // differs from reading the variable where it appears.
        for (const other of slots) {
            if (other.index <= victim.index) continue;
            const writes = writesTo(other.arg, name);
            if (!writes.length) continue;
            const w = writes.find(w => w.kind !== 'ref') ?? writes[0];
            const how = w.kind === 'ref'
                ? `passes &${name}, which may change it,`
                : w.kind === 'increment' ? `changes it with ${w.op},` : `assigns it with ${w.op},`;
            const range = rangeOf(victim.arg);
            if (!range) continue;
            out.push({
                severity: 'warning', rule: 'arg-alias', range,
                docs: DOCS + 'Functions.htm#param',
                message: `Argument ${victim.index + 1} passes the variable ${name}, which isn't read until the call runs. `
                    + `Argument ${other.index + 1} ${how} so the function receives the changed value. `
                    + `To pass the current value, copy it first or wrap it, e.g. Val(${name}) with Val(v) => v.`,
            });
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Rule: callback-arity

interface Arity { min: number; max: number; variadic: boolean }

function arityOfList(list: FormalParameterListContext | null): Arity {
    if (!list) return { min: 0, max: 0, variadic: false };
    const params = [...list.formalParameterArg()];
    const last = list.lastFormalParameterArg();
    let variadic = false;
    if (last.Multiply()) variadic = true;
    else if (last.formalParameterArg()) params.push(last.formalParameterArg()!);
    let min = 0;
    params.forEach((p, i) => { if (!p.Assign() && !p.QuestionMark()) min = i + 1; });
    return { min, max: params.length, variadic };
}

function arityOfHead(head: FatArrowExpressionHeadContext): Arity {
    const feh = head.functionExpressionHead();
    if (feh) return arityOfList(feh.functionHead()?.formalParameterList() ?? feh.formalParameterList());
    if (head.Multiply()) return { min: 0, max: 0, variadic: true };
    return { min: head.QuestionMark() ? 0 : 1, max: 1, variadic: false };
}

/** Named functions declared in the script (class methods excluded). */
function collectFunctions(tree: Antlr4.ParseTree): Map<string, Arity> {
    const map = new Map<string, Arity>();
    walk(tree, n => {
        if (n instanceof ClassDeclarationContext) return false;
        if (n instanceof FunctionDeclarationContext) {
            const h = n.functionHead();
            map.set(h.identifierName().getText().toLowerCase(), arityOfList(h.formalParameterList()));
        } else if (n instanceof FatArrowExpressionContext) {
            const h = n.fatArrowExpressionHead().functionExpressionHead()?.functionHead();
            if (h) map.set(h.identifierName().getText().toLowerCase(), arityOfHead(n.fatArrowExpressionHead()));
        }
        return true;
    });
    return map;
}

function arityOfExpr(e: SingleExpressionContext | null, functions: Map<string, Arity>): Arity | null {
    if (e instanceof FatArrowExpressionContext) return arityOfHead(e.fatArrowExpressionHead());
    if (e instanceof AtomExpressionContext) {
        const name = identName(e.primaryExpression());
        if (name) return functions.get(name.toLowerCase()) ?? null;
    }
    return null;
}

function describeArity(a: Arity): string {
    if (a.variadic) return a.min ? `requires at least ${a.min}` : 'accepts any number';
    if (a.max === 0) return 'accepts none';
    if (a.min === a.max) return `accepts exactly ${a.max}`;
    if (a.min === 0) return `accepts at most ${a.max}`;
    return `accepts ${a.min} to ${a.max}`;
}

const accepts = (a: Arity, n: number) => a.min <= n && (n <= a.max || a.variadic);

interface CallbackSpec { arg: number; counts: number[]; what: string; docs: string; severity?: 'error' | 'warning' }

const FUNCTION_SPECS: Record<string, CallbackSpec> = {
    settimer: { arg: 0, counts: [0], what: 'no arguments', docs: 'lib/SetTimer.htm' },
    hotkey: { arg: 1, counts: [1], what: '1 argument (the hotkey name)', docs: 'lib/Hotkey.htm' },
    hotif: { arg: 0, counts: [1], what: '1 argument (the hotkey name)', docs: 'lib/HotIf.htm' },
    onmessage: { arg: 1, counts: [4], what: '4 arguments (wParam, lParam, msg, hwnd)', docs: 'lib/OnMessage.htm' },
    onclipboardchange: { arg: 0, counts: [1], what: '1 argument (the data type)', docs: 'lib/OnClipboardChange.htm' },
    onerror: { arg: 0, counts: [2], what: '2 arguments (the thrown value and mode)', docs: 'lib/OnError.htm' },
    onexit: { arg: 0, counts: [2], what: '2 arguments (the exit reason and code)', docs: 'lib/OnExit.htm' },
};

const METHOD_SPECS: Record<string, CallbackSpec> = {
    onnotify: { arg: 1, counts: [2], what: '2 arguments (the control and lParam)', docs: 'lib/GuiOnNotify.htm' },
    oncommand: { arg: 1, counts: [1], what: '1 argument (the control)', docs: 'lib/GuiOnCommand.htm' },
    add: { arg: 1, counts: [3], what: '3 arguments (item name, position, menu) when the object is a Menu', docs: 'lib/Menu.htm#Add', severity: 'warning' },
};

// Parameter counts Gui and GuiControl pass for each event, from AutoHotkey's script_gui.cpp.
const GUI_EVENT_COUNTS: Record<string, number[]> = {
    close: [1], escape: [1], size: [4], dropfiles: [5], contextmenu: [5, 6],
    click: [2, 3], itemselect: [2, 3], itemcheck: [3], itemexpand: [3],
    change: [2], doubleclick: [2], colclick: [2], focus: [2], losefocus: [2], itemfocus: [2], itemedit: [2],
};

function stringLiteral(e: SingleExpressionContext | null): string | null {
    if (e instanceof AtomExpressionContext) {
        const p = e.primaryExpression();
        if (p instanceof LiteralExpressionContext) {
            const t = p.getText();
            if (/^(".*"|'.*')$/s.test(t)) return t.slice(1, -1);
        }
    }
    return null;
}

function checkCallbackArity(callee: PrimaryExpressionContext, args: ArgumentsContext | null,
    functions: Map<string, Arity>, out: Diagnostic[], src: Source) {
    if (!args) return;
    const slots = argSlots(args);
    let calleeName: string;
    let spec: CallbackSpec | undefined;

    const fname = identName(callee);
    if (fname) {
        calleeName = fname;
        spec = FUNCTION_SPECS[fname.toLowerCase()];
    } else if (callee instanceof AccessExpressionContext && callee.accessSuffix() instanceof MemberAccessContext) {
        const member = callee.accessSuffix() as MemberAccessContext;
        if (member.memberIndexArguments()) return;
        calleeName = member.memberIdentifier().getText();
        const lname = calleeName.toLowerCase();
        if (lname === 'onevent') {
            const event = stringLiteral(slots.find(s => s.index === 0)?.arg.singleExpression() ?? null);
            const counts = event ? GUI_EVENT_COUNTS[event.toLowerCase()] : undefined;
            if (!counts) return;
            const what = counts.length === 1 ? `${counts[0]} argument${counts[0] === 1 ? '' : 's'}` : `${counts.join(' or ')} arguments`;
            spec = { arg: 1, counts, what: `${what} for "${event}"`, docs: 'lib/GuiOnEvent.htm' };
        } else spec = METHOD_SPECS[lname];
    } else return;
    if (!spec) return;

    const slot = slots.find(s => s.index === spec!.arg);
    if (!slot) return;
    const arity = arityOfExpr(slot.arg.singleExpression(), functions);
    if (!arity || spec.counts.some(n => accepts(arity, n))) return;
    const range = rangeOf(slot.arg);
    if (!range) return;
    const advice = spec.counts[0] === 0 ? 'Remove the required parameters, or make them optional with ?.' : 'Add parameters, or use (*) to accept anything.';
    out.push({
        severity: spec.severity ?? 'error', rule: 'callback-arity', range, docs: DOCS + spec.docs,
        message: `${calleeName} passes ${spec.what}, but this callback ${describeArity(arity)}. `
            + `AutoHotkey throws "Invalid callback function" when it is registered. ${advice}`,
        fix: acceptExtraFix(slot.arg.singleExpression(), arity, Math.max(...spec.counts), src),
    });
}

/** For an inline fat arrow that takes too few parameters: add * so it accepts the rest. */
function acceptExtraFix(e: SingleExpressionContext | null, arity: Arity, needed: number, src: Source): Fix | undefined {
    if (!(e instanceof FatArrowExpressionContext) || arity.variadic || arity.min > needed || !src.available) return undefined;
    const head = e.fatArrowExpressionHead();
    const feh = head.functionExpressionHead();
    if (feh && !feh.functionHead()) {
        const list = feh.formalParameterList();
        const close = rangeOf(feh.getChild(feh.getChildCount() - 1)!);
        if (!close) return undefined;
        return { title: list ? 'Add , * to accept the rest' : 'Use (*) to accept anything', edits: [{ range: at(close.from), text: list ? ', *' : '*' }] };
    }
    const name = head.identifierName();
    const r = rangeOf(head);
    if (name && r && !head.BitAnd() && !head.QuestionMark()) return { title: `Use (${name.getText()}, *)`, edits: [{ range: r, text: `(${name.getText()}, *)` }] };
    return undefined;
}

// ---------------------------------------------------------------------------
// Rules from scope analysis: global-shadow, name-conflict

function checkScopes(info: ScopeInfo, out: Diagnostic[], src: Source) {
    for (const ref of info.refs) {
        const sym = ref.symbol;
        if ((ref.role === 'write' || ref.role === 'update') && (sym.kind === 'function' || sym.kind === 'class') && sym.def) {
            const kind = sym.kind;
            const load = kind === 'function' && ref.op === ':=' ? ' AutoHotkey won\'t load the script: "This Func cannot be assigned a value."' : ' AutoHotkey won\'t load the script.';
            out.push({
                severity: 'error', rule: 'name-conflict', range: ref.range,
                message: `${ref.name} is the name of the ${kind} ${sym.def.name} (line ${lineNo(sym.def)}). Names ignore case, and a ${kind} name `
                    + `can't be ${ref.op === 'for' || ref.op === 'catch' ? `used as a ${ref.op} variable` : ref.op === '&' ? 'passed with &' : 'assigned'} in the scope that defines it.${load} Rename the variable.`,
            });
        }
    }
    const globals = new Map<string, Ref>();
    for (const sym of info.symbols.values()) {
        if (sym.scope.kind === 'global' && sym.kind === 'variable' && sym.def) globals.set(sym.refs[0].lname, sym.def);
    }
    for (const sym of info.symbols.values()) {
        const scope = sym.scope;
        if (scope.kind === 'global' || sym.kind !== 'variable' || !sym.refs.length) continue;
        const first = sym.refs[0];
        if (scope.locals.has(first.lname) || (first.role !== 'update' && first.role !== 'read')) continue;
        const g = globals.get(first.lname);
        if (!g) continue;
        const owner = scopeLabel(scope);
        const what = first.role === 'update' ? `${first.name}${first.op === '++' || first.op === '--' ? first.op : ` ${first.op}`}` : `reading ${first.name}`;
        out.push({
            severity: 'warning', rule: 'global-shadow', range: first.range,
            docs: DOCS + 'Functions.htm#Global',
            message: `${first.name} is a global variable (line ${lineNo(g)}), but ${owner} assigns it without "global ${g.name}", `
                + `so every ${first.name} in ${owner} is a new local variable. ${what} runs before that local has a value, so AutoHotkey throws `
                + `"This local variable has not been assigned a value." Add "global ${g.name}" to ${owner}.`,
            fix: globalDeclFix(scope, g.name, src),
        });
    }
}

function scopeLabel(s: Scope): string {
    if (s.kind === 'hotkey') return `the ${s.name} hotkey`;
    if (s.kind === 'arrow') return 'this function';
    if (s.kind === 'method') return `the method ${s.name}`;
    return `${s.name}()`;
}

/** Insert "global name" as the first line of a function or hotkey body. */
function globalDeclFix(scope: Scope, name: string, src: Source): Fix | undefined {
    if (!src.available) return undefined;
    const title = `Add "global ${name}"`;
    const n = scope.node;
    let block: BlockContext | null = null;
    if (n instanceof FunctionDeclarationContext) block = n.block();
    else if (n instanceof MethodDefinitionContext) block = n.functionBody().block();
    else if (n instanceof HotkeyContext || n instanceof HotstringContext) {
        const stmt = n.statement();
        block = stmt ? firstOf(stmt, BlockContext) : null;
        if (stmt && !block) {
            // One-line hotkey: wrap the statement in a block.
            const r = rangeOf(stmt);
            if (!r || r.from.line !== r.to.line) return undefined;
            const indent = src.indentOf(r.from.line) + '    ';
            const body = src.text(r).replace(/\s+$/, '');
            return { title, edits: [{ range: r, text: `{\n${indent}global ${name}\n${indent}${body}\n${src.indentOf(r.from.line)}}` }] };
        }
    }
    if (!block) return undefined;
    const open = rangeOf(block.getChild(0)!);
    if (!open) return undefined;
    const rest = [...src.line(open.to.line)].slice(open.to.col).join('').trim();
    const next = block.getChildCount() > 2 ? rangeOf(block.getChild(1)!) : null;
    let indent = src.indentOf(open.from.line) + '    ';
    for (let l = open.to.line + 1; next && l <= next.to.line + 1; l++) {
        if (src.line(l).trim()) { indent = src.indentOf(l); break; }
    }
    return { title, edits: [{ range: at(open.to), text: `\n${indent}global ${name}${rest ? `\n${indent}` : ''}` }] };
}

function firstOf<T>(n: Antlr4.ParseTree, type: new (...a: any[]) => T): T | null {
    let found: T | null = null;
    walk(n, c => {
        if (found) return false;
        if (c instanceof type) { found = c; return false; }
        return true;
    });
    return found;
}

// ---------------------------------------------------------------------------
// Rule: property-call

interface StoredFunction { arity: Arity; range: SrcRange }

/** Functions stored in properties: obj.name := (...) => ... or {name: (...) => ...}. Names that are class methods or properties are left out. */
function collectStoredFunctions(tree: Antlr4.ParseTree, functions: Map<string, Arity>): Map<string, StoredFunction[]> {
    const map = new Map<string, StoredFunction[]>();
    const members = new Set<string>();
    const add = (name: string, value: SingleExpressionContext | null, at: Antlr4.ParseTree) => {
        const arity = arityOfExpr(value, functions);
        const range = rangeOf(at);
        if (!arity || !range) return;
        const key = name.toLowerCase();
        map.set(key, [...(map.get(key) ?? []), { arity, range }]);
    };
    walk(tree, n => {
        if (n instanceof MethodDefinitionContext) members.add(n.functionHead().identifierName().getText().toLowerCase());
        else if (n instanceof PropertyDefinitionContext) members.add(n.classPropertyName().propertyName().getText().toLowerCase());
        else if (n instanceof AssignmentExpressionContext && n.assignmentOperator().getText() === ':=') {
            const target = n.primaryExpression();
            if (target instanceof AccessExpressionContext && target.accessSuffix() instanceof MemberAccessContext) {
                const m = target.accessSuffix() as MemberAccessContext;
                if (!m.memberIndexArguments()) add(m.memberIdentifier().getText(), n.singleExpression(), n);
            }
        } else if (n instanceof PropertyAssignmentContext) {
            add(n.memberIdentifier().getText(), n.singleExpression(), n);
        }
        return true;
    });
    for (const m of members) map.delete(m);
    return map;
}

function checkPropertyCall(callee: PrimaryExpressionContext, args: ArgumentsContext | null,
    stored: Map<string, StoredFunction[]>, out: Diagnostic[]) {
    if (!(callee instanceof AccessExpressionContext) || !(callee.accessSuffix() instanceof MemberAccessContext)) return;
    const member = callee.accessSuffix() as MemberAccessContext;
    if (member.memberIndexArguments()) return;
    const name = member.memberIdentifier().getText();
    const candidates = stored.get(name.toLowerCase());
    if (!candidates) return;
    const slots = argSlots(args);
    if (slots.some(s => s.arg.Multiply())) return;
    const argc = slots.length ? slots[slots.length - 1].index + 1 : 0;
    // Only when the hidden first argument is what breaks the call.
    if (candidates.some(c => accepts(c.arity, argc + 1)) || !candidates.some(c => accepts(c.arity, argc))) return;
    const c = candidates.find(c => accepts(c.arity, argc))!;
    const obj = callee.primaryExpression().getText();
    const range = rangeOf(callee.parent ?? callee);
    const nameRange = rangeOf(member.memberIdentifier());
    if (!range || !nameRange) return;
    out.push({
        severity: 'error', rule: 'property-call', range,
        docs: DOCS + 'Objects.htm',
        message: `${obj}.${name}(...) passes ${obj} as a hidden first argument, so the function stored in ${name} (line ${lineNo(c.range)}) `
            + `gets ${argc + 1} argument${argc ? 's' : ''} but ${describeArity(c.arity)}. AutoHotkey throws "Too many parameters passed to function." `
            + `Call it as ${obj}.${name}.Call(...) or (${obj}.${name})(...), or give the function a first parameter for the object.`,
        fix: { title: `Use ${name}.Call(...)`, edits: [{ range: at(nameRange.to), text: '.Call' }] },
    });
}

// ---------------------------------------------------------------------------
// Rule: string-compare

const NUMERIC = /^\s*[+-]?(0x[0-9a-f]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)\s*$/i;

function checkStringCompare(node: RelationalExpressionContext, out: Diagnostic[], src: Source) {
    const [left, right] = node.singleExpression();
    const opNode = node.LessThan() ?? node.MoreThan() ?? node.LessThanEquals() ?? node.GreaterThanEquals();
    if (!left || !right || !opNode) return;
    const op = opNode.getText();
    const bad = [left, right].map(stringLiteral).find(s => s !== null && !NUMERIC.test(s));
    if (bad === undefined) return;
    const range = rangeOf(node);
    const lr = rangeOf(left), rr = rangeOf(right);
    if (!range || !lr || !rr) return;
    out.push({
        severity: 'warning', rule: 'string-compare', range,
        docs: DOCS + 'lib/StrCompare.htm',
        message: `${op} needs numbers. AutoHotkey v2.1 throws TypeError ("Expected a Number but got a String") for the string "${bad}" `
            + `(tested on 2.1-alpha.32 and .37). Compare strings with StrCompare(a, b) ${op} 0.`,
        fix: src.available ? { title: `Use StrCompare(...) ${op} 0`, edits: [{ range, text: `StrCompare(${src.text(lr)}, ${src.text(rr)}) ${op} 0` }] } : undefined,
    });
}

// ---------------------------------------------------------------------------
// Rule: space-index

function checkSpaceIndex(node: ConcatenateExpressionContext, out: Diagnostic[], src: Source) {
    if (node.ConcatDot()) return;
    const [left, right] = node.singleExpression();
    if (!left || !right || right.start?.text !== '[') return;
    const lr = rangeOf(left), rr = rangeOf(right);
    if (!lr || !rr) return;
    const gap: SrcRange = { from: lr.to, to: rr.from };
    const text = (r: SrcRange) => src.available ? src.text(r) : '';
    const str = stringLiteral(left) !== null;
    out.push({
        severity: str ? 'warning' : 'info', rule: 'space-index', range: { from: lr.from, to: rr.to },
        message: str
            ? `AutoHotkey reads this as indexing the string with [...], not as joining it with what follows, and throws PropertyError (a String has no __Item). `
                + `This grammar shows a concatenation here. To join, put . between them.`
            : `AutoHotkey reads ${text(lr) || 'this'} [...] as indexing ${text(lr) || 'the value'}, even with the space. This grammar shows a concatenation here. `
                + `Remove the space to make the indexing clear, or put . between them to join.`,
        fix: gap.from.line === gap.to.line && src.available
            ? str ? { title: 'Join with .', edits: [{ range: gap, text: ' . ' }] } : { title: 'Remove the space', edits: [{ range: gap, text: '' }] }
            : undefined,
    });
}
