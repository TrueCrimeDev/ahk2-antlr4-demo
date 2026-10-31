import * as Antlr4 from 'antlr4ng';
import { AutoHotkeyParser } from './parser/AutoHotkeyParser';
import { SrcPos, SrcRange, tokenRange } from './parse';

export type NodeKind = 'rule' | 'token' | 'error';

export interface ViewNode {
    id: number;
    kind: NodeKind;
    /** Rule name or token type name. */
    name: string;
    /** Token text (tokens and error nodes only). */
    text?: string;
    /** Label shown in the graph, matching the original demo's format. */
    label: string;
    range: SrcRange | null;
    children: ViewNode[];
    parent: ViewNode | null;
    depth: number;
    tree: Antlr4.ParseTree;
}

export interface Model {
    root: ViewNode | null;
    nodes: ViewNode[];
}

export function comparePos(a: SrcPos, b: SrcPos): number {
    return a.line - b.line || a.col - b.col;
}

export function unionRange(a: SrcRange | null, b: SrcRange | null): SrcRange | null {
    if (!a) return b;
    if (!b) return a;
    return {
        from: comparePos(a.from, b.from) <= 0 ? a.from : b.from,
        to: comparePos(a.to, b.to) >= 0 ? a.to : b.to,
    };
}

const rangeCache = new WeakMap<object, SrcRange | null>();

/** Source range covered by any parse tree node (union of its real tokens). */
export function rangeOf(node: Antlr4.ParseTree): SrcRange | null {
    if (rangeCache.has(node)) return rangeCache.get(node)!;
    let r: SrcRange | null = null;
    if (node instanceof Antlr4.TerminalNode) {
        r = tokenRange(node.symbol);
    } else {
        for (let i = 0; i < node.getChildCount(); i++) r = unionRange(r, rangeOf(node.getChild(i)!));
    }
    rangeCache.set(node, r);
    return r;
}

const SKIP_RULES = new Set(['s', 'eos']);
const isTerminal = (n: Antlr4.ParseTree) => n.getChildCount() === 0 && n instanceof Antlr4.TerminalNode;

/**
 * Builds the display tree. The collapse behavior is a port of the original demo:
 * wrapper rules (s, eos) are skipped, and single-child chains are collapsed.
 */
export function buildModel(tree: Antlr4.ParseTree, parser: AutoHotkeyParser, collapse: boolean): Model {
    const nodes: ViewNode[] = [];
    const vocab = parser.vocabulary;

    const isHiddenTerminal = (n: Antlr4.ParseTree) => {
        if (!(n instanceof Antlr4.TerminalNode)) return false;
        const type = n.symbol?.type;
        if (type == null) return false;
        const name = vocab.getSymbolicName(type) || '';
        return name === 'EOL' || name === 'WS' || name === 'EOF';
    };

    function collapsed(node: Antlr4.ParseTree): Antlr4.ParseTree {
        if (!collapse) return node;
        let n = node;
        while (!isTerminal(n) && n.getChildCount() === 1) {
            const ruleName = parser.ruleNames[(n as Antlr4.ParserRuleContext).ruleIndex];
            if (!SKIP_RULES.has(ruleName)) break;
            n = n.getChild(0)!;
        }
        while (!isTerminal(n) && n.getChildCount() === 1) {
            const only = n.getChild(0)!;
            if (isTerminal(only) && isHiddenTerminal(only)) break;
            n = only;
        }
        return n;
    }

    function add(node: Antlr4.ParseTree, parent: ViewNode | null): void {
        const n = collapsed(node);
        let view: ViewNode;
        if (n instanceof Antlr4.TerminalNode) {
            if (isHiddenTerminal(n)) return;
            const isError = n instanceof Antlr4.ErrorNode;
            const name = isError ? 'error' : (vocab.getSymbolicName(n.symbol.type) || String(n.symbol.type));
            const text = n.getText();
            view = {
                id: nodes.length, kind: isError ? 'error' : 'token', name, text,
                label: `${name}: "${text}"`, range: rangeOf(n), children: [], parent,
                depth: parent ? parent.depth + 1 : 0, tree: n,
            };
        } else {
            const ctx = n as Antlr4.ParserRuleContext;
            const name = parser.ruleNames[ctx.ruleIndex];
            if (collapse && SKIP_RULES.has(name)) return;
            view = {
                id: nodes.length, kind: 'rule', name, label: name, range: rangeOf(ctx), children: [],
                parent, depth: parent ? parent.depth + 1 : 0, tree: ctx,
            };
        }
        nodes.push(view);
        parent?.children.push(view);
        for (let i = 0; i < n.getChildCount(); i++) add(n.getChild(i)!, view);
    }

    add(tree, null);
    return { root: nodes[0] ?? null, nodes };
}

/** Deepest node whose range contains pos. Ties go to the node that appears first. */
export function nodeAtPos(model: Model, pos: SrcPos): ViewNode | null {
    const root = model.root;
    if (!root?.range || comparePos(pos, root.range.from) < 0 || comparePos(pos, root.range.to) > 0) return null;
    let best: ViewNode | null = null;
    let cur: ViewNode | null = root;
    while (cur) {
        best = cur;
        let next: ViewNode | null = null;
        for (const c of cur.children) {
            if (c.range && comparePos(c.range.from, pos) <= 0 && comparePos(pos, c.range.to) < 0) { next = c; break; }
        }
        if (!next) {
            // Cursor right after the last character of a node still counts as inside it.
            for (const c of cur.children) {
                if (c.range && comparePos(c.range.from, pos) <= 0 && comparePos(pos, c.range.to) === 0) { next = c; break; }
            }
        }
        cur = next;
    }
    return best;
}
