import * as Antlr4 from 'antlr4ng';
import { AutoHotkeyLexer } from './parser/AutoHotkeyLexer';
import { SrcRange, tokenRange } from './parse';

export interface TokenCallbacks {
    onSelect(range: SrcRange): void;
}

/** Table of lexer tokens, either as the parser receives them or everything the lexer produced. */
export class TokenView {
    private codeTokens: Antlr4.Token[] = [];
    private allTokens: Antlr4.Token[] = [];
    private ranges: (SrcRange | null)[] = [];
    private rowEls: HTMLTableRowElement[] = [];
    private current = -1;
    showAll = false;

    constructor(private host: HTMLElement, private cb: TokenCallbacks) {
        host.addEventListener('click', e => {
            const tr = (e.target as HTMLElement).closest('tr[data-i]') as HTMLTableRowElement | null;
            const r = tr ? this.ranges[Number(tr.dataset.i)] : null;
            if (r) this.cb.onSelect(r);
        });
    }

    setTokens(codeTokens: Antlr4.Token[], allTokens: Antlr4.Token[]) {
        this.codeTokens = codeTokens;
        this.allTokens = allTokens;
        this.render();
    }

    render() {
        const tokens = this.showAll ? this.allTokens : this.codeTokens;
        const names = AutoHotkeyLexer.symbolicNames;
        const table = document.createElement('table');
        table.className = 'token-table';
        table.innerHTML = '<thead><tr><th>#</th><th>Type</th><th>Text</th><th>Line:Col</th><th>Channel</th></tr></thead>';
        const body = document.createElement('tbody');
        this.ranges = [];
        this.rowEls = [];
        this.current = -1;
        tokens.forEach((t, i) => {
            const tr = document.createElement('tr');
            const range = tokenRange(t);
            this.ranges.push(range);
            tr.dataset.i = String(i);
            const synthesized = t.start < 0;
            if (t.channel !== Antlr4.Token.DEFAULT_CHANNEL) tr.className = 'hidden-channel';
            if (synthesized) tr.classList.add('synthesized');
            const channel = t.channel === Antlr4.Token.DEFAULT_CHANNEL ? 'default'
                : (AutoHotkeyLexer.channelNames[t.channel] ?? String(t.channel)).toLowerCase();
            const cells = [
                String(i),
                t.type === Antlr4.Token.EOF ? 'EOF' : names[t.type] ?? String(t.type),
                visible(t.text ?? ''),
                range ? `${range.from.line + 1}:${range.from.col + 1}` : (synthesized ? 'inserted' : ''),
                channel,
            ];
            for (const c of cells) {
                const td = document.createElement('td');
                td.textContent = c;
                tr.append(td);
            }
            body.append(tr);
            this.rowEls.push(tr);
        });
        table.append(body);
        const note = document.createElement('p');
        note.className = 'token-note';
        note.textContent = this.showAll
            ? `${tokens.length} tokens straight from the lexer, including comments and whitespace on hidden channels.`
            : `${tokens.length} tokens after whitespace preprocessing. This is the exact stream the parser reads; "inserted" rows were added by the preprocessor.`;
        this.host.replaceChildren(note, table);
    }

    /** Highlight the token under the cursor (line 0-based, col in code points). */
    markAt(line: number, col: number, reveal: boolean) {
        let found = -1;
        for (let i = 0; i < this.ranges.length; i++) {
            const r = this.ranges[i];
            if (!r) continue;
            const after = r.from.line < line || r.from.line === line && r.from.col <= col;
            const before = r.to.line > line || r.to.line === line && r.to.col > col;
            if (after && before) { found = i; break; }
        }
        if (found === this.current) return;
        this.rowEls[this.current]?.classList.remove('cur');
        this.current = found;
        const tr = this.rowEls[found];
        if (tr) {
            tr.classList.add('cur');
            if (reveal) tr.scrollIntoView({ block: 'nearest' });
        }
    }
}

function visible(s: string): string {
    return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}
