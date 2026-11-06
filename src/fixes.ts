import type { SrcPos, TextEdit } from './parse';

/** UTF-16 offset of a position (columns are code points) in `code`. */
export function offsetOf(code: string, p: SrcPos): number {
    let i = 0;
    for (let line = 0; line < p.line; line++) {
        const nl = code.indexOf('\n', i);
        if (nl < 0) return code.length;
        i = nl + 1;
    }
    for (let col = 0; col < p.col && i < code.length && code[i] !== '\n'; col++) {
        i += code.codePointAt(i)! > 0xffff ? 2 : 1;
    }
    return i;
}

/** Apply edits to code; edits must not overlap. */
export function applyEdits(code: string, edits: TextEdit[]): string {
    const spans = edits.map(e => ({ from: offsetOf(code, e.range.from), to: offsetOf(code, e.range.to), text: e.text }))
        .sort((a, b) => b.from - a.from);
    let out = code;
    for (const s of spans) out = out.slice(0, s.from) + s.text + out.slice(s.to);
    return out;
}
