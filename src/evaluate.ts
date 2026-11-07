import * as Antlr4 from 'antlr4ng';
import * as P from './parser/AutoHotkeyParser';
import type { SrcPos, SrcRange } from './parse';
import { rangeOf } from './model';
import { sliceCode } from './symbols';
import { ScopeInfo, refAt, cmpPos } from './scope';
import { BUILTIN_FUNCTION_MAP, BUILTIN_CLASS_MAP } from './builtins';

/**
 * Evaluation order, as AutoHotkey v2 runs it (checked on v2.1-alpha.32 to alpha.37):
 *
 * - Operators, calls, indexing and property gets run as soon as their operands are ready,
 *   left to right.
 * - A plain variable operand is not read where it appears. It is read when the operator, call,
 *   literal or property set that uses it runs. So x + (x := 5) adds 5 + 5.
 * - The result of an assignment, ++x, --x, (a, b), %name%, and of && || ?? ?: when they pick a
 *   variable, is the variable itself, not a copy of its value: (x := 1) + (x := 2) is 4.
 *   x++ and x-- give the old value.
 */

export type StepKind = 'read' | 'write' | 'compute' | 'call' | 'get' | 'set' | 'test' | 'build' | 'create';

export interface Step {
    kind: StepKind;
    /** The code this step works on. */
    range: SrcRange;
    title: string;
    /** Source text of the range, on one line. */
    code: string;
    /** More explanation, shown under the title. */
    detail?: string;
    /** A read that sees a value changed after the operand appeared. */
    warn?: string;
    /** Lowercase name of the variable this step changes. */
    writes?: string;
    /** "Only if x is true", for steps inside a short-circuit or ternary branch. */
    when?: string;
    depth: number;
}

export interface Evaluation {
    range: SrcRange;
    code: string;
    steps: Step[];
    /** How the result comes out, when it is a variable (read late) rather than a value. */
    result: string;
}

interface VarRef { name: string; lname: string; since: number; via?: string }
interface Operand { range: SrcRange; text: string; refs: VarRef[] }

const OP_TITLES: Record<string, string> = {
    '+': 'Add', '-': 'Subtract', '*': 'Multiply', '/': 'Divide', '//': 'Integer divide', '**': 'Raise to a power',
    '<<': 'Shift left', '>>': 'Shift right', '>>>': 'Shift right (unsigned)', '&': 'Bitwise and', '^': 'Bitwise exclusive or',
    '|': 'Bitwise or', '~=': 'Match a regular expression', '<': 'Compare', '>': 'Compare', '<=': 'Compare', '>=': 'Compare',
    '=': 'Compare (case-insensitive)', '==': 'Compare (case-sensitive)', '!=': 'Compare (not equal)', '!==': 'Compare (not equal, case-sensitive)',
};
const COMPOUND_TITLES: Record<string, string> = {
    '+=': 'add', '-=': 'subtract', '*=': 'multiply', '/=': 'divide', '//=': 'integer divide', '.=': 'join',
    '|=': 'bitwise or', '&=': 'bitwise and', '^=': 'bitwise exclusive or', '>>=': 'shift right', '<<=': 'shift left', '>>>=': 'shift right', '%=': 'take the remainder',
};

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n = 60) => s.length > n ? s.slice(0, n - 1) + '…' : s;

/** Deepest parse tree node whose range contains the position. */
function nodeAt(tree: Antlr4.ParseTree, pos: SrcPos): Antlr4.ParseTree | null {
    const r = rangeOf(tree);
    if (!r || cmpPos(pos, r.from) < 0 || cmpPos(pos, r.to) > 0) return null;
    for (let i = 0; i < tree.getChildCount(); i++) {
        const c = tree.getChild(i)!;
        // Line ends and spacing touch the next line's start; they never hold an expression.
        if (c instanceof P.EosContext || c instanceof P.SContext || c instanceof Antlr4.TerminalNode && !c.getText().trim()) continue;
        const hit = nodeAt(c, pos);
        if (hit) return hit;
    }
    return tree;
}

const isExprNode = (n: Antlr4.ParseTree) => n instanceof P.SingleExpressionContext || n instanceof P.PrimaryExpressionContext
    || n instanceof P.ExpressionSequenceContext || n instanceof P.FunctionStatementContext || n instanceof P.ArgumentsContext
    || n instanceof P.ArgumentContext || n instanceof P.AccessSuffixContext || n instanceof P.MemberIndexArgumentsContext
    || n instanceof P.ArrayLiteralContext || n instanceof P.ObjectLiteralContext || n instanceof P.PropertyAssignmentContext
    || n instanceof P.LiteralContext || n instanceof P.IdentifierContext || n instanceof P.MemberIdentifierContext
    || n instanceof P.DynamicIdentifierContext || n instanceof P.DereferenceContext || n instanceof P.PropertyNameContext
    || n instanceof P.AssignmentOperatorContext || n instanceof P.BooleanContext || n instanceof P.NumericLiteralContext;

/** The whole expression around a position: the outermost expression inside its statement. A fat
 *  arrow's body counts as its own expression. */
export function expressionAt(tree: Antlr4.ParseTree, pos: SrcPos): Antlr4.ParseTree | null {
    let n = nodeAt(tree, pos);
    if (!n && pos.col > 0) n = nodeAt(tree, { line: pos.line, col: pos.col - 1 });
    let best: Antlr4.ParseTree | null = null;
    for (let p = n; p; p = p.parent) {
        if (p instanceof P.FatArrowExpressionContext && best && best !== p && rangeOf(p.fatArrowExpressionHead()) && !isInside(best, p.fatArrowExpressionHead())) break;
        if (p instanceof P.FunctionBodyContext) break;
        if (p instanceof Antlr4.TerminalNode) continue;
        if (!isExprNode(p)) { if (best) break; continue; }
        if (p instanceof P.SingleExpressionContext || p instanceof P.ExpressionSequenceContext || p instanceof P.FunctionStatementContext) best = p;
    }
    if (best instanceof P.ExpressionSequenceContext && best.singleExpression().length === 1) best = best.singleExpression(0);
    return best;
}

function isInside(n: Antlr4.ParseTree, ancestor: Antlr4.ParseTree): boolean {
    for (let p: Antlr4.ParseTree | null = n; p; p = p.parent) if (p === ancestor) return true;
    return false;
}

export function evaluationSteps(expr: Antlr4.ParseTree, code: string, scopes: ScopeInfo | null): Evaluation {
    const steps: Step[] = [];
    let depth = 0;
    let when: string | undefined;
    const text = (n: Antlr4.ParseTree) => { const r = rangeOf(n); return r ? oneLine(sliceCode(code, r)) : n.getText(); };

    const push = (s: Omit<Step, 'depth' | 'code'> & { code?: string }) => {
        steps.push({ ...s, code: clip(s.code ?? oneLine(sliceCode(code, s.range))), depth, ...(when ? { when } : {}) });
        return steps.length - 1;
    };

    /** Read pending variables, then run the step that uses them. */
    const consume = (ops: Operand[], step: Omit<Step, 'depth' | 'code'> & { code?: string }) => {
        for (const op of ops) readOperand(op);
        return push(step);
    };

    const readOperand = (op: Operand) => {
        if (!op.refs.length) return;
        const names = [...new Set(op.refs.map(r => r.name))];
        const changed: string[] = [];
        for (const r of op.refs) {
            const at = steps.findIndex((s, i) => i >= r.since && s.writes === r.lname);
            if (at >= 0) changed.push(`${r.name} changed in step ${at + 1} (${steps[at].code})`);
        }
        const via = op.refs.find(r => r.via)?.via;
        push({
            kind: 'read', range: op.range, title: names.length > 1 ? `Read ${names.join(' or ')}` : `Read ${names[0]}`,
            ...(via ? { detail: via } : {}),
            ...(changed.length ? { warn: `${changed.join('; ')} after this operand appeared, so this reads the new value.` } : {}),
        });
    };

    const value = (n: Antlr4.ParseTree): Operand => ({ range: rangeOf(n)!, text: text(n), refs: [] });

    const isConstantName = (id: Antlr4.ParseTree): string | null => {
        const name = id.getText();
        const r = rangeOf(id);
        const ref = r && scopes ? refAt(scopes, r.from) : null;
        if (ref?.symbol.kind === 'function') return 'function';
        if (ref?.symbol.kind === 'class') return 'class';
        if (!ref || ref.symbol.kind === 'variable' && !ref.symbol.def) {
            if (BUILTIN_CLASS_MAP.has(name.toLowerCase())) return 'class';
            if (BUILTIN_FUNCTION_MAP.has(name.toLowerCase())) return 'function';
        }
        return null;
    };

    const args = (a: P.ArgumentsContext | null | undefined): Operand[] =>
        a ? a.argument().map(x => ev(x.singleExpression())) : [];

    const describeCallee = (callee: P.PrimaryExpressionContext): { ops: Operand[]; title: string; detail?: string } => {
        if (callee instanceof P.IdentifierExpressionContext) {
            const kind = isConstantName(callee);
            const name = callee.getText();
            if (kind === 'class') return { ops: [], title: `Create a ${name} object`, detail: `Calls ${name}.Call, which runs __New with these arguments.` };
            if (kind === 'function') return { ops: [], title: `Call ${name}` };
            const op = ev(callee);
            return { ops: [op], title: `Call the function in ${name}` };
        }
        if (callee instanceof P.AccessExpressionContext && callee.accessSuffix() instanceof P.MemberAccessContext) {
            const m = callee.accessSuffix() as P.MemberAccessContext;
            const obj = ev(callee.primaryExpression());
            const idx = args(m.memberIndexArguments()?.arguments());
            const name = m.memberIdentifier().getText();
            const dyn = m.memberIdentifier().dynamicIdentifier();
            if (dyn) evDynamic(dyn);
            return { ops: [obj, ...idx], title: `Call method ${name} of ${clip(obj.text, 24)}`, ...(m.QuestionMarkDot() ? { detail: `Skipped if ${clip(obj.text, 24)} is unset.` } : {}) };
        }
        const op = ev(callee);
        return { ops: [op], title: `Call the result of ${clip(op.text, 24)}` };
    };

    const evDynamic = (d: P.DynamicIdentifierContext): void => {
        for (const deref of d.dereference()) {
            const inner = ev(deref.singleExpression());
            consume([inner], { kind: 'compute', range: rangeOf(deref)!, title: 'Use this as part of a name' });
        }
    };

    const evAssignTarget = (target: P.PrimaryExpressionContext): { kind: 'var'; name: string } | { kind: 'member' | 'index' | 'dynamic'; ops: Operand[]; label: string } | null => {
        if (target instanceof P.IdentifierExpressionContext) return { kind: 'var', name: target.getText() };
        if (target instanceof P.AccessExpressionContext) {
            const s = target.accessSuffix();
            const obj = ev(target.primaryExpression());
            if (s instanceof P.MemberAccessContext) {
                const dyn = s.memberIdentifier().dynamicIdentifier();
                if (dyn) evDynamic(dyn);
                return { kind: 'member', ops: [obj, ...args(s.memberIndexArguments()?.arguments())], label: text(target) };
            }
            if (s instanceof P.IndexAccessContext) return { kind: 'index', ops: [obj, ...args(s.memberIndexArguments().arguments())], label: text(target) };
        }
        if (target instanceof P.DynamicIdentifierExpressionContext) {
            evDynamic(target.dynamicIdentifier());
            return { kind: 'dynamic', ops: [], label: text(target) };
        }
        return null;
    };

    const binary = (n: P.SingleExpressionContext, title: string) => {
        const kids = n.children.filter((c): c is P.SingleExpressionContext | P.PrimaryExpressionContext =>
            c instanceof P.SingleExpressionContext || c instanceof P.PrimaryExpressionContext);
        const l = ev(kids[0]), r = ev(kids[1]);
        consume([l, r], { kind: 'compute', range: rangeOf(n)!, title });
        return value(n);
    };

    const branch = <T>(label: string, f: () => T): T => {
        const savedWhen = when;
        depth++;
        when = label;
        try { return f(); } finally { depth--; when = savedWhen; }
    };

    const rootRange = rangeOf(expr)!;
    const ev = (n: Antlr4.ParseTree | null | undefined): Operand => {
        // Error recovery can leave a rule without its parts; treat those as empty values.
        const range = n ? rangeOf(n) : null;
        if (!n || !range) return { range: rootRange, text: '', refs: [] };
        if (n instanceof P.ExpressionSequenceContext) {
            const items = n.singleExpression().map(e => ev(e));
            return { range, text: text(n), refs: items[items.length - 1]?.refs ?? [] };
        }
        if (n instanceof P.AtomExpressionContext) return ev(n.primaryExpression());
        if (n instanceof P.ParenthesizedExpressionContext) {
            const inner = ev(n.expressionSequence());
            return { range, text: text(n), refs: inner.refs.map(r => ({ ...r, via: r.via ?? (n.expressionSequence().singleExpression().length > 1 ? 'A comma list gives its last item, here a variable.' : undefined) })) };
        }
        if (n instanceof P.IdentifierExpressionContext) {
            if (isConstantName(n)) return value(n);
            return { range, text: text(n), refs: [{ name: n.getText(), lname: n.getText().toLowerCase(), since: steps.length }] };
        }
        if (n instanceof P.LiteralExpressionContext) return value(n);
        if (n instanceof P.VarRefExpressionContext) {
            push({ kind: 'create', range, title: `Make a reference to ${text(n.primaryExpression())}`, detail: 'The variable itself is not read.' });
            return value(n);
        }
        if (n instanceof P.DynamicIdentifierExpressionContext) {
            evDynamic(n.dynamicIdentifier());
            return { range, text: text(n), refs: [{ name: text(n), lname: '%' + text(n).toLowerCase(), since: steps.length, via: 'The variable is found by name now and read later, like any variable.' }] };
        }
        if (n instanceof P.ArrayLiteralExpressionContext) {
            const items = args(n.arrayLiteral().arguments());
            consume(items, { kind: 'build', range, title: `Build an array of ${items.length} item${items.length === 1 ? '' : 's'}`, detail: items.some(i => i.refs.length) ? 'Variables in the list are read now, after every item has run.' : undefined });
            return value(n);
        }
        if (n instanceof P.ObjectLiteralExpressionContext) {
            const props = n.objectLiteral().propertyAssignment();
            const ops: Operand[] = [];
            for (const p of props) {
                const dyn = p.memberIdentifier().dynamicIdentifier();
                if (dyn) evDynamic(dyn);
                ops.push(ev(p.singleExpression()));
            }
            const names = props.map(p => p.memberIdentifier().getText());
            consume(ops, { kind: 'build', range, title: props.length ? `Build an object with ${clip(names.join(', '), 40)}` : 'Build an empty object',
                detail: ops.some(i => i.refs.length) ? 'Variables in the values are read now, after every value has run.' : undefined });
            return value(n);
        }
        if (n instanceof P.AccessExpressionContext) {
            const s = n.accessSuffix();
            if (s instanceof P.FunctionCallAccessContext) {
                const c = describeCallee(n.primaryExpression());
                const a = args(s.arguments());
                consume([...c.ops, ...a], { kind: 'call', range, title: c.title, detail: c.detail });
                return value(n);
            }
            if (s instanceof P.MemberAccessContext) {
                const obj = ev(n.primaryExpression());
                const dyn = s.memberIdentifier().dynamicIdentifier();
                if (dyn) evDynamic(dyn);
                const idx = args(s.memberIndexArguments()?.arguments());
                consume([obj, ...idx], { kind: 'get', range, title: `Get ${s.memberIdentifier().getText()} from ${clip(obj.text, 24)}`,
                    ...(s.QuestionMarkDot() ? { detail: `Skipped if ${clip(obj.text, 24)} is unset.` } : {}) });
                return value(n);
            }
            if (s instanceof P.IndexAccessContext) {
                const obj = ev(n.primaryExpression());
                const idx = args(s.memberIndexArguments().arguments());
                consume([obj, ...idx], { kind: 'get', range, title: `Index ${clip(obj.text, 24)}` });
                return value(n);
            }
            if (s instanceof P.AllowUnsetAccessContext) return { ...ev(n.primaryExpression()), range, text: text(n) };
        }
        if (n instanceof P.FunctionStatementContext) {
            const c = describeCallee(n.primaryExpression());
            const a = args(n.arguments());
            consume([...c.ops, ...a], { kind: 'call', range, title: c.title, detail: c.detail });
            return value(n);
        }
        if (n instanceof P.AssignmentExpressionContext) {
            const op = n.assignmentOperator().getText();
            const target = evAssignTarget(n.primaryExpression());
            const targetSince = steps.length;
            const right = ev(n.singleExpression());
            if (!target) { consume([right], { kind: 'set', range, title: 'Assign' }); return value(n); }
            if (target.kind === 'var') {
                const lname = target.name.toLowerCase();
                if (op === ':=') {
                    consume([right], { kind: 'write', range, title: `Store in ${target.name}`, writes: lname });
                } else {
                    const verb = COMPOUND_TITLES[op] ?? op;
                    readOperand({ range: rangeOf(n.primaryExpression())!, text: target.name, refs: [{ name: target.name, lname, since: targetSince }] });
                    consume([right], { kind: 'write', range, title: `${verb[0].toUpperCase()}${verb.slice(1)}, then store in ${target.name}`, writes: lname });
                }
                return { range, text: text(n), refs: [{ name: target.name, lname, since: steps.length, via: `The result of ${clip(text(n), 30)} is the variable ${target.name}, not a copy of its value.` }] };
            }
            const verb = op === ':=' ? 'Set' : `Update (${COMPOUND_TITLES[op] ?? op})`;
            consume([...target.ops, right], { kind: 'set', range, title: `${verb} ${clip(target.label, 30)}`, writes: target.kind === 'dynamic' ? '%' + target.label.toLowerCase() : undefined });
            return value(n);
        }
        if (n instanceof P.PreIncrementDecrementExpressionContext || n instanceof P.PostIncrementDecrementExpressionContext) {
            const pre = n instanceof P.PreIncrementDecrementExpressionContext;
            const opTok = n.getChild(pre ? 0 : 1)!.getText();
            const inner = n.singleExpression();
            const verb = opTok === '++' ? 'Add 1 to' : 'Subtract 1 from';
            const prim = inner instanceof P.AtomExpressionContext ? inner.primaryExpression() : null;
            if (prim instanceof P.IdentifierExpressionContext) {
                const name = prim.getText();
                push({ kind: 'write', range, title: `${verb} ${name}`, writes: name.toLowerCase(),
                    detail: pre ? `The result is the variable ${name} itself.` : `The result is the value ${name} had before.` });
                return pre ? { range, text: text(n), refs: [{ name, lname: name.toLowerCase(), since: steps.length, via: `The result of ${text(n)} is the variable ${name}.` }] } : value(n);
            }
            const target = prim ? evAssignTarget(prim) : null;
            consume(target && target.kind !== 'var' ? target.ops : [], { kind: 'set', range, title: `${verb} ${clip(text(inner), 30)}` });
            return value(n);
        }
        if (n instanceof P.UnaryExpressionContext || n instanceof P.VerbalNotExpressionContext) {
            const op = n instanceof P.VerbalNotExpressionContext ? 'not' : n.getChild(n.getChildCount() - 2)!.getText();
            const r = ev(n.singleExpression());
            const title = op === '-' ? 'Negate' : op === '+' ? 'Make a number' : op === '~' ? 'Bitwise not' : 'Logical not';
            consume([r], { kind: 'compute', range, title });
            return value(n);
        }
        if (n instanceof P.LogicalAndExpressionContext || n instanceof P.LogicalOrExpressionContext || n instanceof P.CoalesceExpressionContext) {
            const [lx, rx] = n.singleExpression();
            const l = ev(lx);
            const isAnd = n instanceof P.LogicalAndExpressionContext, isOr = n instanceof P.LogicalOrExpressionContext;
            const lt = clip(l.text, 24);
            const testAt = consume([l], {
                kind: 'test', range: l.range, title: isAnd ? `Test ${lt}` : isOr ? `Test ${lt}` : `Check whether ${lt} has a value`,
                detail: isAnd ? `If it is false, the result is ${lt} and the right side is skipped.`
                    : isOr ? `If it is true, the result is ${lt} and the right side is skipped.`
                        : `If it has a value, that is the result and the right side is skipped.`,
            });
            const r = branch(isAnd ? `only if ${lt} is true` : isOr ? `only if ${lt} is false` : `only if ${lt} is unset`, () => ev(rx));
            return { range, text: text(n), refs: [...l.refs.map(x => ({ ...x, since: testAt })), ...r.refs] };
        }
        if (n instanceof P.TernaryExpressionContext) {
            const [cx, tx, fx] = n.singleExpression();
            const c = ev(cx);
            const ct = clip(c.text, 24);
            consume([c], { kind: 'test', range: c.range, title: `Test ${ct}`, detail: 'Only one of the two branches runs.' });
            const t = branch(`only if ${ct} is true`, () => ev(tx));
            const f = branch(`only if ${ct} is false`, () => ev(fx));
            return { range, text: text(n), refs: [...t.refs, ...f.refs] };
        }
        if (n instanceof P.FatArrowExpressionContext) {
            push({ kind: 'create', range, title: 'Create a function', detail: 'Its body runs later, each time the function is called.' });
            return value(n);
        }
        if (n instanceof P.IsExpressionContext) {
            const l = ev(n.singleExpression()), r = ev(n.primaryExpression());
            consume([l, r], { kind: 'compute', range, title: 'Check the type (is)' });
            return value(n);
        }
        if (n instanceof P.ConcatenateExpressionContext) return binary(n, 'Join (concatenate)');
        if (n instanceof P.SingleExpressionContext) {
            const op = (n as unknown as { _op?: Antlr4.Token | null })._op?.text ?? '';
            return binary(n, OP_TITLES[op] ?? `Apply ${op}`);
        }
        return value(n);
    };

    const out = ev(expr);
    const r = rangeOf(expr)!;
    let up = expr.parent;
    if (up instanceof P.ExpressionSequenceContext) up = up.parent;
    const statementLevel = up instanceof P.ExpressionStatementContext;
    const names = statementLevel ? [] : [...new Set(out.refs.map(x => x.name))];
    return {
        range: r,
        code: sliceCode(code, r),
        steps,
        result: names.length ? `The result is the variable ${names.join(' or ')}, read by whatever uses it next.` : '',
    };
}
