import * as Antlr4 from 'antlr4ng';
import { AutoHotkeyLexer } from './parser/AutoHotkeyLexer';

/** A lexing failure with a source position (1-based line, 0-based code point column). */
export class LexError extends Error {
    constructor(message: string, public line: number, public column: number, public length = 1) {
        super(message);
    }
}

// Token preprocessing ported from Descolada's original demo (and Keysharp's C# lexer driver).
// Only change: errors are thrown as LexError so the UI can place them in the editor.
export function readTokens(lexer: AutoHotkeyLexer): { codeTokens: Antlr4.Token[], allTokens: Antlr4.Token[] } {
    const tokenStream = new Antlr4.CommonTokenStream(lexer);
    tokenStream.fill();
    const tokens = tokenStream.getTokens();

    const codeTokens: Antlr4.Token[] = [];
    let index = 0;

    // skip any leading WS
    while (index < tokens.length && tokens[index].type === AutoHotkeyLexer.WS) {
        index++;
    }

    const ERROR_CHANNEL = AutoHotkeyLexer.channelNames.indexOf("ERROR");

    // by default we include everything except hidden‐channel tokens
    while (index < tokens.length) {
        let tk = tokens[index];
        
        let shouldAdd = true;
        let skipAdvance = false;

        // skip purely hidden tokens (comments, directive‑mode hidden WS, etc.)
        if (tk.channel === Antlr4.Lexer.HIDDEN) {
            index++;
            continue;
        } else if (tk.channel === ERROR_CHANNEL) {
            // Show in the graph area and skip parsing
            if (tk.text === "\"" || tk.text === "'")
                throw new LexError(`Unterminated string literal`, tk.line, tk.column);
            throw new LexError(`Unexpected '${tk.text}'`, tk.line, tk.column, Math.max(1, [...(tk.text ?? '')].length));
        }

        switch (tk.type) {
            case AutoHotkeyLexer.Hashtag:
                if (index+1 < tokens.length && tokens[index+1].channel == AutoHotkeyLexer.HIDDEN)
                    throw new LexError(`Unexpected whitespace after #`, tk.line, tk.column);
            case AutoHotkeyLexer.OpenBrace:
                PopWhitespaces(codeTokens, /*allowLinebreaks*/ false);
                break;

            case AutoHotkeyLexer.OpenParen:
                index = SkipWhitespaces(tokens, codeTokens, index);
                break;

            case AutoHotkeyLexer.Comma:
                index = SkipWhitespaces(tokens, codeTokens, index);
                PopEOLs(codeTokens);
                break;

            case AutoHotkeyLexer.CloseParen:
                PopWhitespaces(codeTokens, /*allowLinebreaks*/ true);
                break;
            // arithmetic / bitwise operators
            case AutoHotkeyLexer.Multiply:
                PopWhitespaces(codeTokens, /*allowLinebreaks*/ true);
                break;

            case AutoHotkeyLexer.EOL: {
                PopWhitespaces(codeTokens, /*allowLinebreaks*/ true);
                index = SkipWhitespaces(tokens, codeTokens, index);
                break;
            }

            case AutoHotkeyLexer.Not:
            case AutoHotkeyLexer.BitNot:
			case AutoHotkeyLexer.Plus: // Can't pop whitespaces because of function call statement
			case AutoHotkeyLexer.Minus:
				index = SkipWhitespaces(tokens, codeTokens, index);
                break;

            case AutoHotkeyLexer.Dot:
            case AutoHotkeyLexer.Assign:
            case AutoHotkeyLexer.Divide:
            case AutoHotkeyLexer.IntegerDivide:
            case AutoHotkeyLexer.Power:
            case AutoHotkeyLexer.NullCoalesce:
            case AutoHotkeyLexer.RightShiftArithmetic:
            case AutoHotkeyLexer.LeftShiftArithmetic:
            case AutoHotkeyLexer.RightShiftLogical:
            case AutoHotkeyLexer.LessThan:
            case AutoHotkeyLexer.MoreThan:
            case AutoHotkeyLexer.LessThanEquals:
            case AutoHotkeyLexer.GreaterThanEquals:
            case AutoHotkeyLexer.Equals_:
            case AutoHotkeyLexer.NotEquals:
            case AutoHotkeyLexer.IdentityEquals:
            case AutoHotkeyLexer.IdentityNotEquals:
            case AutoHotkeyLexer.RegExMatch:
            case AutoHotkeyLexer.BitXOr:
            case AutoHotkeyLexer.BitOr:
            case AutoHotkeyLexer.And:
            case AutoHotkeyLexer.Or:
            case AutoHotkeyLexer.VerbalAnd:
            case AutoHotkeyLexer.VerbalOr:
            case AutoHotkeyLexer.MultiplyAssign:
            case AutoHotkeyLexer.DivideAssign:
            case AutoHotkeyLexer.ModulusAssign:
            case AutoHotkeyLexer.PlusAssign:
            case AutoHotkeyLexer.MinusAssign:
            case AutoHotkeyLexer.LeftShiftArithmeticAssign:
            case AutoHotkeyLexer.RightShiftArithmeticAssign:
            case AutoHotkeyLexer.RightShiftLogicalAssign:
            case AutoHotkeyLexer.IntegerDivideAssign:
            case AutoHotkeyLexer.ConcatenateAssign:
            case AutoHotkeyLexer.BitAndAssign:
            case AutoHotkeyLexer.BitXorAssign:
            case AutoHotkeyLexer.BitOrAssign:
            case AutoHotkeyLexer.PowerAssign:
            case AutoHotkeyLexer.NullishCoalescingAssign:
            case AutoHotkeyLexer.QuestionMarkDot:
            case AutoHotkeyLexer.Arrow:
                PopWhitespaces(codeTokens, /*allowLinebreaks*/ true);
                index = SkipWhitespaces(tokens, codeTokens, index);
                break;

            case AutoHotkeyLexer.Loop: {
                // if next is WS + a keyword, consume them
                var condition = false;
                if (tokens[index + 1]?.type === AutoHotkeyLexer.WS) {
                    const t2 = tokens[index + 2]?.type;
                    if (
                        t2 === AutoHotkeyLexer.Files ||
                        t2 === AutoHotkeyLexer.Parse ||
                        t2 === AutoHotkeyLexer.Read ||
                        t2 === AutoHotkeyLexer.Reg
                    ) {
                        index += 2;
                        codeTokens.push(tk); // Add "Loop"
                        tokens[index - 1].channel = AutoHotkeyLexer.HIDDEN; // Hide whitespaces
                        codeTokens.push(tokens[index - 1]); // Add whitespaces
                        tk = tokens[index];
                        condition = tk.type === AutoHotkeyLexer.Not || tk.type === AutoHotkeyLexer.VerbalNot;
                    }
                }
                codeTokens.push(tk);
                if (tokens[index + 1].type == AutoHotkeyLexer.Comma) {
                    index++;
                    tokens[index].channel = AutoHotkeyLexer.HIDDEN; // Hide comma
                    codeTokens.push(tokens[index]);
                }
                AddWhitespaces(tokens, codeTokens, index, condition);
                shouldAdd = false;
                // fallthrough to adding the Loop token
                break;
            }

            // a bunch of statement‐like keywords get extra whitespace inserted
            case AutoHotkeyLexer.Try:
            case AutoHotkeyLexer.If:
            case AutoHotkeyLexer.Catch:
            case AutoHotkeyLexer.Finally:
            case AutoHotkeyLexer.As:
            case AutoHotkeyLexer.For:
            case AutoHotkeyLexer.Switch:
            case AutoHotkeyLexer.Case:
            case AutoHotkeyLexer.Default:
            case AutoHotkeyLexer.While:
            case AutoHotkeyLexer.Until:
            case AutoHotkeyLexer.Else:
            case AutoHotkeyLexer.Goto:
            case AutoHotkeyLexer.Throw:
            case AutoHotkeyLexer.Static:
            case AutoHotkeyLexer.Not:
            case AutoHotkeyLexer.VerbalNot:
                codeTokens.push(tk);
                index = AddWhitespaces(tokens, codeTokens, index, /*linebreaksOnNot*/ tk.type === AutoHotkeyLexer.Not || tk.type === AutoHotkeyLexer.VerbalNot);
                shouldAdd = false;
                break;

            case AutoHotkeyLexer.CloseBrace:
                {
                    let i = PopWhitespaces(codeTokens, /*allowLinebreaks=*/ true);
                    // ensure a trailing EOL after a close‑brace
                    const eolToken = Antlr4.CommonToken.fromType(AutoHotkeyLexer.EOL, '\n');
                    if (codeTokens[i]?.type !== AutoHotkeyLexer.EOL) {
                        codeTokens.push(eolToken);
                    }
                    codeTokens.push(tk);
                    i = index;
                    let eolPresent = false;
                    while (++i < tokens.length) {
                        if ((tokens[i].channel == AutoHotkeyLexer.HIDDEN)
                            || (tokens[i].type == AutoHotkeyLexer.WS))
                            index++;
                        else if (tokens[i].type == AutoHotkeyLexer.EOL) {
                            eolPresent = true;
                            break;
                        }
                        else
                            break;
                    }
                    if (!eolPresent) {
                        codeTokens.push(eolToken);
                    }
                    shouldAdd = false;
                }
                break;

            case AutoHotkeyLexer.HotIf:
            case AutoHotkeyLexer.InputLevel:
            case AutoHotkeyLexer.UseHook:
            case AutoHotkeyLexer.SuspendExempt:
                index = SkipWhitespaces(tokens, codeTokens, index, false);
                break;

            default:
                break;
        }

        if (shouldAdd)
            codeTokens.push(tk);
        if (!skipAdvance)
            index++;
    }

    // strip any remaining WS / EOL at the very front
    while (
        codeTokens.length &&
        (codeTokens[0].type === AutoHotkeyLexer.WS ||
            codeTokens[0].type === AutoHotkeyLexer.EOL)
    ) {
        codeTokens.shift();
    }

    return { codeTokens, allTokens: tokens };
}

// Helpers (direct port of your C# PopWhitespaces / SkipWhitespaces logic)

function PopWhitespaces(
    codeTokens: Antlr4.Token[],
    allowLinebreaks = true
): number {
    let i = codeTokens.length - 1;
    while (i >= 0) {
        const ct = codeTokens[i];
        if (
            ct.type === AutoHotkeyLexer.WS ||
            (allowLinebreaks && ct.type === AutoHotkeyLexer.EOL)
        ) {
            codeTokens.pop();
            i--;
        } else {
            break;
        }
    }
    return i;
}

function SkipWhitespaces(
    allTokens: Antlr4.Token[],
    codeTokens: Antlr4.Token[],
    startIndex: number,
    linebreaks: boolean = true
): number {
    let idx = startIndex;
    while (++idx < allTokens.length) {
        const t = allTokens[idx];
        if ((t.channel === AutoHotkeyLexer.HIDDEN) 
            || (t.type === AutoHotkeyLexer.WS) 
            || (linebreaks && t.type == AutoHotkeyLexer.EOL)) {
            startIndex++;
        } else {
            break;
        }
    }
    return startIndex;
}

function PopEOLs(codeTokens: Antlr4.Token[]) {
    // remove any EOL tokens at the end of codeTokens
    while (
        codeTokens.length &&
        codeTokens[codeTokens.length - 1].type === AutoHotkeyLexer.EOL
    ) {
        codeTokens.pop();
    }
}

function AddWhitespaces(
    allTokens: Antlr4.Token[],
    codeTokens: Antlr4.Token[],
    startIndex: number,
    condition: boolean
): number {
    let i = startIndex;
    while (++i < allTokens.length) {
        const t = allTokens[i];

        if (t.channel === AutoHotkeyLexer.HIDDEN)
            startIndex++;
        // If it's an EOL and condition is true, skip it
        else if (t.type === AutoHotkeyLexer.EOL && condition) {
            startIndex++;
        }
        // If it’s a plain whitespace token, keep it
        else if (t.type === AutoHotkeyLexer.WS) {
            codeTokens.push(t);
            startIndex++;
        }
        // Otherwise stop
        else {
            break;
        }
    }
    return startIndex;

}
