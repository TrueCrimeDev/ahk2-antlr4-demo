import * as Antlr4 from 'antlr4ng';
import {
    AccessExpressionContext, ArgumentContext, ArgumentsContext, AssignmentExpressionContext, AtomExpressionContext,
    ClassDeclarationContext, FatArrowExpressionContext, FatArrowExpressionHeadContext, FormalParameterListContext,
    FunctionCallAccessContext, FunctionDeclarationContext, FunctionStatementContext, IdentifierExpressionContext,
    LiteralExpressionContext, MemberAccessContext, ParenthesizedExpressionContext, PostIncrementDecrementExpressionContext,
    PreIncrementDecrementExpressionContext, PrimaryExpressionContext, SingleExpressionContext, VarRefExpressionContext,
} from './parser/AutoHotkeyParser';
import { Diagnostic } from './parse';
import { rangeOf } from './model';

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
];

export function lint(tree: Antlr4.ParseTree): Diagnostic[] {
    const out: Diagnostic[] = [];
    const functions = collectFunctions(tree);
    walk(tree, node => {
        if (node instanceof ArgumentsContext) checkArgAlias(node, out);
        if (node instanceof FunctionCallAccessContext) {
            const parent = node.parent;
            if (parent instanceof AccessExpressionContext) checkCallbackArity(parent.primaryExpression(), node.arguments(), functions, out);
        } else if (node instanceof FunctionStatementContext) {
            checkCallbackArity(node.primaryExpression(), node.arguments(), functions, out);
        }
        return true;
    });
    return out;
}

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
    functions: Map<string, Arity>, out: Diagnostic[]) {
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
    const fix = spec.counts[0] === 0 ? 'Remove the required parameters, or make them optional with ?.' : 'Add parameters, or use (*) to accept anything.';
    out.push({
        severity: spec.severity ?? 'error', rule: 'callback-arity', range, docs: DOCS + spec.docs,
        message: `${calleeName} passes ${spec.what}, but this callback ${describeArity(arity)}. `
            + `AutoHotkey throws "Invalid callback function" when it is registered. ${fix}`,
    });
}
