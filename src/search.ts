import * as Antlr4 from 'antlr4ng';
import * as P from './parser/AutoHotkeyParser';
import { parseSource, SrcRange, TextEdit } from './parse';
import { rangeOf } from './model';
import { sliceCode } from './symbols';

/**
 * Structural search: a pattern is AutoHotkey code where $name stands for any expression (or
 * name), and $$name in an argument list stands for the rest of the arguments. Patterns match
 * parse trees, not text, so spacing, line breaks and comments don't matter, and
 * SetTimer($fn, $ms) also matches the command form SetTimer Tick, 100.
 */

export interface Binding { range: SrcRange; text: string }
export interface Match { range: SrcRange; bindings: Map<string, Binding> }
export interface Pattern { root: Antlr4.ParseTree; metas: string[] }

const META = /^__META_(REST_)?(\w+)$/;
const metaName = (n: Antlr4.ParseTree) => META.exec(n.getText());

/** Compile a pattern, or return an error message. */
export function compilePattern(text: string): Pattern | string {
    const metas: string[] = [];
    const src = text.trim().replace(/\$(\$)?([A-Za-z_]\w*)/g, (_, rest, name) => {
        metas.push((rest ? '$$' : '$') + name);
        return `__META_${rest ? 'REST_' : ''}${name}`;
    });
    if (!src) return 'Type a pattern, such as SetTimer($fn, $ms).';
    const r = parseSource(src + '\n');
    const err = r.diagnostics.find(d => d.severity === 'error');
    if (!r.tree || err) return `The pattern isn't valid AutoHotkey: ${err?.message ?? 'it could not be parsed'}.`;
    let root: Antlr4.ParseTree | null = r.tree;
    // Unwrap program > sourceElements > sourceElement > statement > expression.
    for (;;) {
        if (!root) break;
        const kids = significant(root);
        if (root instanceof P.ExpressionStatementContext) { root = root.expressionSequence(); continue; }
        if (root instanceof P.ExpressionSequenceContext && root.singleExpression().length === 1) { root = root.singleExpression(0); break; }
        if (root instanceof P.ProgramContext || root instanceof P.SourceElementsContext || root instanceof P.SourceElementContext || root instanceof P.StatementContext) {
            if (kids.length !== 1) {
                return kids.length ? 'Search for one statement or expression at a time.' : 'Type a pattern, such as SetTimer($fn, $ms).';
            }
            root = kids[0];
            continue;
        }
        break;
    }
    if (!root) return 'The pattern is empty.';
    if (metaName(root)) return 'A pattern needs some fixed code around its $ placeholders.';
    return { root, metas };
}

/** Children that carry meaning: no whitespace, line ends or eos markers. */
function significant(n: Antlr4.ParseTree): Antlr4.ParseTree[] {
    const out: Antlr4.ParseTree[] = [];
    for (let i = 0; i < n.getChildCount(); i++) {
        const c = n.getChild(i)!;
        if (c instanceof Antlr4.TerminalNode) {
            const t = c.getText();
            if (!t.trim() || t === '<EOF>') continue;
        } else if (c instanceof P.EosContext || c instanceof P.SContext) continue;
        out.push(c);
    }
    return out;
}

interface CallShape { callee: P.PrimaryExpressionContext; args: P.ArgumentsContext | null }

function callShape(n: Antlr4.ParseTree): CallShape | null {
    if (n instanceof P.AtomExpressionContext) n = n.primaryExpression();
    if (n instanceof P.FunctionStatementContext) return { callee: n.primaryExpression(), args: n.arguments() };
    if (n instanceof P.AccessExpressionContext && n.accessSuffix() instanceof P.FunctionCallAccessContext) {
        return { callee: n.primaryExpression(), args: (n.accessSuffix() as P.FunctionCallAccessContext).arguments() };
    }
    return null;
}

/** Argument slots in order; empty slots (f(, x)) are null. */
function argList(args: P.ArgumentsContext | null): (P.ArgumentContext | null)[] {
    const out: (P.ArgumentContext | null)[] = [];
    if (!args) return out;
    let pending = true;
    for (const c of significant(args)) {
        if (c instanceof P.ArgumentContext) { out.push(c); pending = false; }
        else if (c.getText() === ',') { if (pending) out.push(null); pending = true; }
    }
    return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function findMatches(tree: Antlr4.ParseTree, pattern: Pattern, code: string): Match[] {
    const out: Match[] = [];
    const text = (n: Antlr4.ParseTree) => { const r = rangeOf(n); return r ? sliceCode(code, r) : n.getText(); };

    const bind = (b: Map<string, Binding>, name: string, n: Antlr4.ParseTree): boolean => {
        const r = rangeOf(n);
        if (!r) return false;
        const t = text(n);
        const prev = b.get(name);
        if (prev) return norm(prev.text).toLowerCase() === norm(t).toLowerCase();
        b.set(name, { range: r, text: t });
        return true;
    };

    const sameKind = (p: Antlr4.ParseTree, c: Antlr4.ParseTree) => {
        if (p instanceof P.SingleExpressionContext) return c instanceof P.SingleExpressionContext;
        if (p instanceof P.PrimaryExpressionContext) return c instanceof P.PrimaryExpressionContext;
        return p.constructor === c.constructor;
    };

    const matchArgs = (pa: P.ArgumentsContext | null, ca: P.ArgumentsContext | null, b: Map<string, Binding>): boolean => {
        const ps = argList(pa), cs = argList(ca);
        for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            const m = p ? metaName(p) : null;
            if (m?.[1]) { // $$rest: the remaining arguments
                const rest = cs.slice(i).filter((x): x is P.ArgumentContext => !!x);
                if (rest.length) {
                    const from = rangeOf(rest[0])!, to = rangeOf(rest[rest.length - 1])!;
                    const range = { from: from.from, to: to.to };
                    const t = sliceCode(code, range);
                    const prev = b.get('$$' + m[2]);
                    if (prev && norm(prev.text).toLowerCase() !== norm(t).toLowerCase()) return false;
                    b.set('$$' + m[2], { range, text: t });
                } else b.set('$$' + m[2], { range: rangeOf(ca ?? pa!) ?? { from: { line: 0, col: 0 }, to: { line: 0, col: 0 } }, text: '' });
                return true;
            }
            const c = cs[i];
            if (i >= cs.length) return false;
            if (!p || !c) { if (p !== c) return false; continue; }
            if (!match(p, c, b)) return false;
        }
        return ps.length === cs.length;
    };

    const match = (p: Antlr4.ParseTree, c: Antlr4.ParseTree, b: Map<string, Binding>): boolean => {
        const m = metaName(p);
        if (m && !m[1] && !(p instanceof Antlr4.TerminalNode) && (sameKind(p, c) || p.constructor === c.constructor)) return bind(b, '$' + m[2], c);
        // Call patterns also match the command form, and vice versa.
        const pc = callShape(p), cc = callShape(c);
        if (pc && cc) return match(pc.callee, cc.callee, b) && matchArgs(pc.args, cc.args, b);
        if (p instanceof Antlr4.TerminalNode || c instanceof Antlr4.TerminalNode) {
            if (!(p instanceof Antlr4.TerminalNode && c instanceof Antlr4.TerminalNode)) return false;
            const pt = p.getText(), ct = c.getText();
            if (m && m[2]) return bind(b, '$' + m[2], c); // $name in a name position (members, labels)
            return /^["']/.test(pt) ? pt === ct : pt.toLowerCase() === ct.toLowerCase();
        }
        if (p instanceof P.ArgumentsContext && c instanceof P.ArgumentsContext) return matchArgs(p, c, b);
        if (p.constructor !== c.constructor) {
            // Names: an identifier pattern matches the same name in any wrapper.
            return false;
        }
        const ps = significant(p), cs = significant(c);
        if (ps.length !== cs.length) return false;
        for (let i = 0; i < ps.length; i++) if (!match(ps[i], cs[i], b)) return false;
        return true;
    };

    const rootIsCall = !!callShape(pattern.root);
    const candidate = (c: Antlr4.ParseTree) => rootIsCall ? !!callShape(c) && (c instanceof P.SingleExpressionContext || c instanceof P.FunctionStatementContext)
        : sameKind(pattern.root, c);

    const visit = (c: Antlr4.ParseTree) => {
        if (c instanceof Antlr4.TerminalNode) return;
        if (candidate(c)) {
            const b = new Map<string, Binding>();
            if (match(pattern.root, c, b)) {
                const r = rangeOf(c);
                if (r) { out.push({ range: r, bindings: b }); return; } // Outermost match only.
            }
        }
        for (let i = 0; i < c.getChildCount(); i++) visit(c.getChild(i)!);
    };
    visit(tree);
    return out;
}

/** Fill a replacement template's $name / $$name placeholders from a match. */
export function fillTemplate(template: string, m: Match): string {
    return template.replace(/\$(\$)?([A-Za-z_]\w*)/g, (all, rest, name) => m.bindings.get((rest ? '$$' : '$') + name)?.text ?? all);
}

export function replaceEdits(matches: Match[], template: string): TextEdit[] {
    return matches.map(m => ({ range: m.range, text: fillTemplate(template, m) }));
}
