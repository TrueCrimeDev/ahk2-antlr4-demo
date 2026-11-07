import * as Antlr4 from 'antlr4ng';
import {
    AccessExpressionContext, ArgumentContext, ArgumentsContext, AssignmentExpressionContext, AtomExpressionContext,
    ClassDeclarationContext, FatArrowExpressionContext, FatArrowExpressionHeadContext, FormalParameterListContext,
    FunctionCallAccessContext, FunctionDeclarationContext, FunctionStatementContext, IdentifierExpressionContext,
    LiteralExpressionContext, MemberAccessContext, ParenthesizedExpressionContext, PostIncrementDecrementExpressionContext,
    PreIncrementDecrementExpressionContext, PrimaryExpressionContext, SingleExpressionContext, VarRefExpressionContext,
    ConcatenateExpressionContext, RelationalExpressionContext, PropertyAssignmentContext, MethodDefinitionContext,
    PropertyDefinitionContext, BlockContext, HotkeyContext, HotstringContext, FunctionBodyContext, StatementContext,
    LogicalAndExpressionContext, LogicalOrExpressionContext, TernaryExpressionContext, CoalesceExpressionContext, ArrayLiteralContext, ObjectLiteralContext,
} from './parser/AutoHotkeyParser';
import { Diagnostic, Fix, SrcPos, SrcRange } from './parse';
import { rangeOf } from './model';
import { analyzeScopes, ScopeInfo, Scope, Ref } from './scope';
import { BUILTIN_CLASS_MAP, BUILTIN_FUNCTION_MAP, BUILTIN_VARIABLE_MAP, isBuiltin } from './builtins';
import {
    SourceElementsContext, StatementListContext, SourceElementContext, ReturnStatementContext,
    ThrowStatementContext, BreakStatementContext, ContinueStatementContext, GotoStatementContext, LabelledStatementContext,
    DirectiveContext, RemapContext, HotstringDirectiveContext, ExpressionStatementContext,
} from './parser/AutoHotkeyParser';

const DOCS = 'https://www.autohotkey.com/docs/alpha/';

export interface LintRuleInfo { id: string; title: string; description: string }

export const LINT_RULES: LintRuleInfo[] = [
    {
        id: 'arg-alias',
        title: 'Variable read after it changes',
        description: 'A plain variable passed as an argument, used as an operand, or put in an array or object literal is not read until the call, operator or literal runs, so a later part that assigns or increments it changes the value used. With x = 1, Pair(x, x := 2) passes 2 and x + (x := 5) gives 10.',
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
        id: 'undefined-name',
        title: 'Name that is never defined',
        description: 'A name that is read or called but never assigned, defined or built in. AutoHotkey warns at load ("This global variable appears to never be assigned a value") and throws UnsetError when the line runs. Usually a typo; the fix offers the closest name.',
    },
    {
        id: 'unused-variable',
        title: 'Local assigned but never used',
        description: 'A local variable that a function, method or hotkey assigns but never reads.',
    },
    {
        id: 'unreachable',
        title: 'Code that never runs',
        description: 'Lines after return, throw, break, continue, goto, Exit or ExitApp in the same block, with no label in between.',
    },
    {
        id: 'space-index',
        title: 'Space before [ indexes',
        description: 'AutoHotkey reads value [1] as value[1], even with the space, so "Total: " [1, 2].Length indexes the string instead of joining. This grammar shows a concatenation there.',
    },
];

/** Lint a parse tree. `code` is the source it came from, used to build fixes. */
export function lint(tree: Antlr4.ParseTree, code = '', scopes: ScopeInfo = analyzeScopes(tree), opts: { syntaxErrors?: boolean } = {}): Diagnostic[] {
    const out: Diagnostic[] = [];
    const src = new Source(code);
    const functions = collectFunctions(tree);
    const stored = collectStoredFunctions(tree, functions);
    walk(tree, node => {
        if (node instanceof ArgumentsContext) checkArgAlias(node, out);
        checkOperandAlias(node, out);
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
    checkUndefinedAndUnused(tree, scopes, out, !!opts.syntaxErrors);
    checkUnreachable(tree, out);
    return out;
}

// ---------------------------------------------------------------------------
// Rules: undefined-name, unused-variable

/** Optimal string alignment distance (Levenshtein plus adjacent swaps), case-insensitive. */
export function editDistance(a: string, b: string): number {
    a = a.toLowerCase(); b = b.toLowerCase();
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

/** The closest known name, if it is close enough to be a likely typo. */
export function closestName(name: string, candidates: Iterable<string>): string | null {
    let best: string | null = null, bestD = Infinity;
    const limit = Math.min(2, Math.max(1, Math.floor(name.length / 3)));
    for (const c of candidates) {
        if (c.toLowerCase() === name.toLowerCase()) continue;
        if (Math.abs(c.length - name.length) > limit) continue;
        const dist = editDistance(name, c);
        if (dist <= limit && dist < bestD) { best = c; bestD = dist; }
    }
    return best;
}

function checkUndefinedAndUnused(tree: Antlr4.ParseTree, info: ScopeInfo, out: Diagnostic[], syntaxErrors: boolean) {
    // Where names are called, and whether other files can add definitions. After a syntax error the
    // parser's recovery can drop definitions, so undefined names are only reported for clean parses.
    const calls = new Set<string>();
    let includes = false;
    let broken = syntaxErrors;
    const key = (p: SrcPos) => `${p.line}:${p.col}`;
    walk(tree, n => {
        if (n instanceof DirectiveContext && /^#include/i.test(n.getText())) includes = true;
        if (n instanceof Antlr4.ErrorNode) broken = true;
        let callee: PrimaryExpressionContext | null = null;
        if (n instanceof FunctionStatementContext) callee = n.primaryExpression();
        else if (n instanceof FunctionCallAccessContext && n.parent instanceof AccessExpressionContext) callee = n.parent.primaryExpression();
        if (callee instanceof IdentifierExpressionContext) {
            const r = rangeOf(callee);
            if (r) calls.add(key(r.from));
        }
        return true;
    });

    const scriptNames = (scope: Scope, wantCallable: boolean) => {
        const names: string[] = [];
        for (const sym of info.symbols.values()) {
            if (!sym.def) continue;
            if (wantCallable && sym.kind !== 'function' && sym.kind !== 'class') continue;
            // Visible from here: the global scope, or this scope and the functions around it.
            let visible = sym.scope.kind === 'global';
            for (let s: Scope | null = scope; s && !visible; s = s.parent) visible = s === sym.scope;
            if (visible) names.push(sym.name);
        }
        return names;
    };

    for (const sym of info.symbols.values()) {
        const name = sym.refs[0]?.name ?? sym.name;
        if (!broken && sym.scope.kind === 'global' && sym.kind === 'variable' && !sym.def && !isBuiltin(name)) {
            for (const ref of sym.refs) {
                const isCall = calls.has(key(ref.range.from));
                const candidates = isCall
                    ? [...scriptNames(ref.scope, true), ...BUILTIN_FUNCTION_MAP.values(), ...BUILTIN_CLASS_MAP.values()]
                    : [...scriptNames(ref.scope, false), ...BUILTIN_VARIABLE_MAP.values()];
                const guess = closestName(ref.name, candidates);
                const elsewhere = includes ? ' It may come from an #Include file, which this page can\'t see.' : '';
                out.push({
                    severity: includes ? 'info' : isCall ? 'error' : 'warning', rule: 'undefined-name', range: ref.range,
                    message: (isCall
                        ? `${ref.name} isn't a function, class or variable defined anywhere. AutoHotkey warns at load ("This global variable appears to never be assigned a value") and throws UnsetError when this line runs.`
                        : `${ref.name} is never assigned anywhere, so reading it throws UnsetError ("This global variable has not been assigned a value").`)
                        + (guess ? ` Did you mean ${guess}?` : '') + elsewhere,
                    fix: guess ? { title: `Change to ${guess}`, edits: [{ range: ref.range, text: guess }] } : undefined,
                });
            }
        }
        // Locals that are set but never read.
        if (sym.scope.kind !== 'global' && sym.kind === 'variable' && sym.refs.length
            && sym.refs.every(r => r.role === 'write' && r.op === ':=' || r.role === 'declare')
            && sym.refs.some(r => r.role === 'write') && !sym.scope.globals.has(sym.refs[0].lname)) {
            const first = sym.refs.find(r => r.role === 'write')!;
            const owner = scopeLabel(sym.scope);
            out.push({
                severity: 'info', rule: 'unused-variable', range: first.range,
                message: `${first.name} is assigned in ${owner} but never used${sym.refs.length > 1 ? ` (${sym.refs.length} assignments)` : ''}.`,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Rule: unreachable

/** The statement or declaration inside sourceElement/statement wrappers. */
function innerStatement(n: Antlr4.ParseTree): Antlr4.ParseTree {
    while ((n instanceof SourceElementContext || n instanceof StatementContext) && n.getChildCount() >= 1) {
        const inner = Array.from({ length: n.getChildCount() }, (_, i) => n.getChild(i)!).find(c => !(c instanceof Antlr4.TerminalNode));
        if (!inner) break;
        n = inner;
    }
    return n;
}

const isDeclaration = (n: Antlr4.ParseTree) => n instanceof FunctionDeclarationContext || n instanceof ClassDeclarationContext
    || n instanceof HotkeyContext || n instanceof HotstringContext || n instanceof DirectiveContext || n instanceof RemapContext
    || n instanceof HotstringDirectiveContext || (n instanceof ExpressionStatementContext && /^\w+\([^)]*\)=>/.test(n.getText()) && isNamedArrow(n));

function isNamedArrow(n: ExpressionStatementContext): boolean {
    const e = n.expressionSequence()?.singleExpression(0);
    return e instanceof FatArrowExpressionContext && !!e.fatArrowExpressionHead().functionExpressionHead()?.functionHead();
}

function exitKind(n: Antlr4.ParseTree): string | null {
    if (n instanceof ReturnStatementContext) return 'return';
    if (n instanceof ThrowStatementContext) return 'throw';
    if (n instanceof BreakStatementContext) return 'break';
    if (n instanceof ContinueStatementContext) return 'continue';
    if (n instanceof GotoStatementContext) return 'goto';
    if (n instanceof FunctionStatementContext || n instanceof ExpressionStatementContext) {
        const first = (n as Antlr4.ParserRuleContext).start?.text?.toLowerCase();
        const text = n.getText().toLowerCase();
        if ((first === 'exitapp' || first === 'exit') && /^(exitapp|exit)(\(|$|[^\w.:=])/.test(text)) return first === 'exit' ? 'Exit' : 'ExitApp';
    }
    return null;
}

function checkUnreachable(tree: Antlr4.ParseTree, out: Diagnostic[]) {
    walk(tree, n => {
        if (!(n instanceof SourceElementsContext || n instanceof StatementListContext)) return true;
        let exit: { kind: string; line: number } | null = null;
        let run: SrcRange | null = null;
        const flush = () => {
            if (run && exit) out.push({
                severity: 'warning', rule: 'unreachable', range: run,
                message: `This never runs: it comes after ${exit.kind} on line ${exit.line} with no label in between.`,
            });
            run = null;
        };
        for (let i = 0; i < n.getChildCount(); i++) {
            const child = n.getChild(i)!;
            if (!(child instanceof SourceElementContext || child instanceof StatementContext)) continue; // eos markers hold comments
            const inner = innerStatement(child);
            if (inner instanceof Antlr4.TerminalNode) continue;
            if (inner instanceof LabelledStatementContext) { flush(); exit = null; continue; }
            const r = rangeOf(inner);
            if (!r || !inner.getText().trim()) continue;
            if (exit && !isDeclaration(inner)) run = run ? { from: run.from, to: r.to } : r;
            if (!exit) {
                const k = exitKind(inner);
                if (k) exit = { kind: k, line: r.from.line + 1 };
            }
        }
        flush();
        return true;
    });
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
            const inArray = args.parent instanceof ArrayLiteralContext;
            out.push({
                severity: 'warning', rule: 'arg-alias', range,
                docs: DOCS + (inArray ? 'lib/Array.htm' : 'Functions.htm#param'),
                message: inArray
                    ? `Item ${victim.index + 1} is the variable ${name}, which isn't read until the array is built. `
                        + `Item ${other.index + 1} ${how} so the array gets the changed value. In AutoHotkey, x := 1, a := [x, x := 2] gives [2, 2].`
                    : `Argument ${victim.index + 1} passes the variable ${name}, which isn't read until the call runs. `
                        + `Argument ${other.index + 1} ${how} so the function receives the changed value. `
                        + `To pass the current value, copy it first or wrap it, e.g. Val(${name}) with Val(v) => v.`,
            });
            break;
        }
    }
}

/**
 * The same late read applies to operators, compound assignment and object literals: a plain
 * variable operand is read when the operator runs, after everything to its right has run.
 * Checked on AutoHotkey 2.1-alpha.32 and .37: with x = 1, x + (x := 5) gives 10 and
 * x += (x := 5) gives 10, while x * 10 + (x := 3) gives 13 (the * runs before x changes).
 */
function checkOperandAlias(node: Antlr4.ParseTree, out: Diagnostic[]) {
    const describe = (w: Write, name: string) => w.kind === 'ref' ? `passes &${name}` : w.kind === 'increment' ? `changes it with ${w.op}` : `assigns it with ${w.op}`;
    if (node instanceof AssignmentExpressionContext) {
        const op = node.assignmentOperator().getText();
        const target = node.primaryExpression();
        if (op === ':=' || !(target instanceof IdentifierExpressionContext)) return;
        const name = target.getText();
        const writes = writesTo(node.singleExpression(), name);
        const range = rangeOf(node);
        if (!writes.length || !range) return;
        out.push({
            severity: 'warning', rule: 'arg-alias', range,
            message: `${name} ${op} reads ${name} after the right side runs, and the right side ${describe(writes[0], name)}, `
                + `so the result is built from the new value. In AutoHotkey, x := 1, x += (x := 5) leaves x = 10.`,
        });
        return;
    }
    if (node instanceof ObjectLiteralContext) {
        const values = [...node.propertyAssignment()].map(p => p.singleExpression());
        values.forEach((v, i) => {
            const name = deferredVar(v);
            if (!name) return;
            const later = values.slice(i + 1).flatMap(o => o ? writesTo(o, name) : []);
            const range = rangeOf(v!);
            if (!later.length || !range) return;
            out.push({
                severity: 'warning', rule: 'arg-alias', range,
                message: `This value is the variable ${name}, which isn't read until the object is built. A later property ${describe(later[0], name)}, `
                    + `so the object gets the changed value. In AutoHotkey, x := 1, o := {p: x, q: x := 2} sets p to 2.`,
            });
        });
        return;
    }
    // Binary operators: two operand expressions with an operator token between them.
    if (!(node instanceof SingleExpressionContext) || node instanceof LogicalAndExpressionContext || node instanceof LogicalOrExpressionContext
        || node instanceof CoalesceExpressionContext || node instanceof TernaryExpressionContext || node instanceof FatArrowExpressionContext) return;
    const operands = [] as SingleExpressionContext[];
    let opText = '';
    for (let i = 0; i < node.getChildCount(); i++) {
        const c = node.getChild(i)!;
        if (c instanceof SingleExpressionContext) operands.push(c);
        else if (c instanceof Antlr4.TerminalNode && c.getText().trim() && !opText) opText = c.getText();
    }
    if (operands.length !== 2) return;
    const name = deferredVar(operands[0]);
    if (!name) return;
    const writes = writesTo(operands[1], name);
    const range = rangeOf(operands[0]);
    if (!writes.length || !range) return;
    const op = opText || 'the concatenation';
    out.push({
        severity: 'warning', rule: 'arg-alias', range,
        message: `${name} isn't read until ${op === 'the concatenation' ? op : op + ' runs'}, and the right side ${describe(writes[0], name)} first, `
            + `so this uses the new value. In AutoHotkey, x := 1, y := x + (x := 5) gives 10, not 6. Copy it first if you need the old value.`,
    });
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
