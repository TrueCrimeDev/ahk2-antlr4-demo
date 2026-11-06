import * as Antlr4 from 'antlr4ng';
import { AutoHotkeyLexer } from './parser/AutoHotkeyLexer';
import { AutoHotkeyParser, ProgramContext } from './parser/AutoHotkeyParser';
import { readTokens, LexError } from './lexing';

/** Source position: 0-based line, 0-based column counted in code points (ANTLR's unit). */
export interface SrcPos { line: number; col: number }
export interface SrcRange { from: SrcPos; to: SrcPos }

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
    severity: Severity;
    rule: string;
    message: string;
    range: SrcRange;
    /** Optional link to documentation that explains the rule. */
    docs?: string;
    /** A one-click fix: text edits applied together. */
    fix?: Fix;
}

/** Replace `range` with `text`; an empty range inserts. */
export interface TextEdit { range: SrcRange; text: string }
export interface Fix { title: string; edits: TextEdit[] }

export interface ParseResult {
    tree: ProgramContext | null;
    parser: AutoHotkeyParser | null;
    /** Tokens as the lexer produced them, including hidden-channel tokens. */
    allTokens: Antlr4.Token[];
    /** Tokens after whitespace preprocessing; this is what the parser consumes. */
    codeTokens: Antlr4.Token[];
    diagnostics: Diagnostic[];
    lexMs: number;
    parseMs: number;
}

export function cpLength(text: string): number {
    let n = 0;
    for (const _ of text) n++;
    return n;
}

/** End position of a token, accounting for tokens that span lines. */
export function tokenEnd(line0: number, col: number, text: string): SrcPos {
    const parts = text.split('\n');
    if (parts.length === 1) return { line: line0, col: col + cpLength(text) };
    return { line: line0 + parts.length - 1, col: cpLength(parts[parts.length - 1]) };
}

/** Range of a real token, or null for synthesized tokens and EOF. */
export function tokenRange(t: Antlr4.Token | null | undefined): SrcRange | null {
    if (!t || t.start < 0 || t.type === Antlr4.Token.EOF || t.line < 1) return null;
    const from = { line: t.line - 1, col: t.column };
    return { from, to: tokenEnd(from.line, from.col, t.text ?? '') };
}

const noop = () => { };

class CollectingErrorListener implements Antlr4.ANTLRErrorListener {
    public diagnostics: Diagnostic[] = [];
    syntaxError(_recognizer: any, offendingSymbol: any, line: number, charPositionInLine: number, msg: string) {
        const t = offendingSymbol as Antlr4.Token | null;
        let range = tokenRange(t);
        if (!range || t?.type === AutoHotkeyLexer.EOL) {
            // Zero-width or synthesized tokens: underline a single column at the reported position.
            const from = { line: Math.max(0, line - 1), col: charPositionInLine };
            range = { from, to: { line: from.line, col: from.col + 1 } };
        }
        this.diagnostics.push({ severity: 'error', rule: 'syntax', message: msg, range });
    }
    reportAmbiguity = noop;
    reportAttemptingFullContext = noop;
    reportContextSensitivity = noop;
}

export function parseSource(code: string): ParseResult {
    const result: ParseResult = {
        tree: null, parser: null, allTokens: [], codeTokens: [], diagnostics: [], lexMs: 0, parseMs: 0,
    };

    let t0 = performance.now();
    const lexer = new AutoHotkeyLexer(Antlr4.CharStream.fromString(code + '\n'));
    const lexErrors = new CollectingErrorListener();
    lexer.removeErrorListeners();
    lexer.addErrorListener(lexErrors);

    try {
        const { codeTokens, allTokens } = readTokens(lexer);
        result.codeTokens = codeTokens;
        result.allTokens = allTokens;
    } catch (e: any) {
        if (e instanceof LexError) {
            const from = { line: Math.max(0, e.line - 1), col: e.column };
            result.diagnostics.push({
                severity: 'error', rule: 'lexer', message: e.message,
                range: { from, to: { line: from.line, col: from.col + e.length } },
            });
        } else {
            result.diagnostics.push({
                severity: 'error', rule: 'lexer', message: String(e?.message ?? e),
                range: { from: { line: 0, col: 0 }, to: { line: 0, col: 1 } },
            });
        }
        result.lexMs = performance.now() - t0;
        return result;
    }
    result.diagnostics.push(...lexErrors.diagnostics.map(d => ({ ...d, rule: 'lexer' })));
    result.lexMs = performance.now() - t0;

    t0 = performance.now();
    const tokenStream = new Antlr4.CommonTokenStream(new Antlr4.ListTokenSource(result.codeTokens));
    const parser = new AutoHotkeyParser(tokenStream);
    const parseErrors = new CollectingErrorListener();
    parser.removeErrorListeners();
    parser.addErrorListener(parseErrors);
    result.tree = parser.program();
    result.parser = parser;
    result.parseMs = performance.now() - t0;
    result.diagnostics.push(...parseErrors.diagnostics);
    return result;
}
