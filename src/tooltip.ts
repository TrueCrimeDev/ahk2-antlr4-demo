/**
 * Styled tooltips: small dark tips that replace the browser's title tooltips, and hover cards
 * for richer content (editor hovers, graph nodes).
 */

export type Placement = 'above' | 'below';

export interface TipOptions {
    placement?: Placement;
    /** Keep it open while the pointer is over it (for links and buttons inside). */
    interactive?: boolean;
}

let nextId = 0;

/** A floating box that positions itself next to an anchor rectangle and stays on screen. */
export class Tip {
    readonly el: HTMLDivElement;
    /** Whatever the tip currently describes, so callers can skip redundant updates. */
    owner: unknown = null;
    private showTimer: number | undefined;
    private hideTimer: number | undefined;

    constructor(className: string) {
        this.el = document.createElement('div');
        this.el.className = `tip ${className}`;
        this.el.id = `tip-${nextId++}`;
        this.el.setAttribute('role', 'tooltip');
        this.el.hidden = true;
        document.body.append(this.el);
        this.el.addEventListener('pointerenter', () => clearTimeout(this.hideTimer));
    }

    get visible() { return !this.el.hidden; }

    /** Show `content` next to `anchor` after `delay` ms (0 = now). Replaces any pending show. */
    open(owner: unknown, content: () => (Node | string)[], anchor: () => DOMRect | null, delay: number, opts: TipOptions = {}) {
        clearTimeout(this.showTimer);
        clearTimeout(this.hideTimer);
        const run = () => {
            const rect = anchor();
            if (!rect) return;
            this.owner = owner;
            this.el.replaceChildren(...content());
            this.el.classList.toggle('interactive', !!opts.interactive);
            this.place(rect, opts.placement ?? 'below');
        };
        if (delay > 0) this.showTimer = window.setTimeout(run, delay); else run();
    }

    /** Hide now, or after `delay` ms unless the pointer moves onto the tip (interactive tips). */
    close(delay = 0) {
        clearTimeout(this.showTimer);
        clearTimeout(this.hideTimer);
        const run = () => {
            this.el.hidden = true;
            this.el.classList.remove('shown');
            this.owner = null;
        };
        if (delay > 0 && this.visible) this.hideTimer = window.setTimeout(run, delay); else run();
    }

    cancelPending() { clearTimeout(this.showTimer); }

    /** Cancel a pending close (the pointer came back). */
    keep() { clearTimeout(this.hideTimer); }

    contains(node: Node | null) { return !!node && this.el.contains(node); }

    private place(anchor: DOMRect, placement: Placement) {
        const el = this.el;
        const margin = 8, gap = 6;
        el.classList.remove('shown');
        el.style.visibility = 'hidden';
        el.style.left = '0px';
        el.style.top = '0px';
        el.hidden = false;
        const w = el.offsetWidth, h = el.offsetHeight;
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        const fitsAbove = anchor.top - gap - h >= margin;
        const fitsBelow = anchor.bottom + gap + h <= vh - margin;
        const side: Placement = placement === 'above' ? (fitsAbove || !fitsBelow ? 'above' : 'below') : (fitsBelow || !fitsAbove ? 'below' : 'above');
        const top = side === 'above' ? anchor.top - gap - h : anchor.bottom + gap;
        const left = Math.min(Math.max(margin, anchor.left), vw - w - margin);
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(Math.max(margin, Math.min(top, vh - h - margin)))}px`;
        el.dataset.side = side;
        el.style.visibility = '';
        void el.offsetWidth; // Restart the fade-in.
        el.classList.add('shown');
    }
}

// ---------------------------------------------------------------------------
// Simple tips for anything with a title attribute

/** "Next match (Shift+Enter)" -> text plus a key cap, when the parentheses hold only keys. */
export function withKeys(text: string): (Node | string)[] {
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(text);
    const keys = m?.[2].split(/\s*(?:,|\/|or)\s*/);
    if (!m || !keys?.every(k => /^(Ctrl|Shift|Alt|Cmd|Esc|Escape|Enter|Tab|F\d{1,2}|[A-Z0-9↑↓←→])(\+(Ctrl|Shift|Alt|Enter|Esc|Tab|F\d{1,2}|[A-Z0-9↑↓←→]))*$/.test(k))) return [text];
    const out: (Node | string)[] = [m[1], ' '];
    keys.forEach((k, i) => {
        if (i) out.push(' ');
        out.push(kbd(k));
    });
    return out;
}

export function kbd(keys: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'kbd-group';
    keys.split('+').forEach((k, i) => {
        if (i) el.append('+');
        const key = document.createElement('kbd');
        key.textContent = k;
        el.append(key);
    });
    return el;
}

/**
 * Replace browser title tooltips with styled ones, page-wide. A title is moved to data-tip the
 * first time the pointer or keyboard focus reaches its element, so dynamically created elements
 * are covered too.
 */
export function installSimpleTips(root: HTMLElement = document.body) {
    const tip = new Tip('tip-simple');
    let target: HTMLElement | null = null;
    let warmUntil = 0;

    const textOf = (el: HTMLElement) => {
        const title = el.getAttribute('title');
        if (title) {
            el.dataset.tip = title;
            el.removeAttribute('title');
            if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
        }
        return el.dataset.tip ?? '';
    };
    const show = (el: HTMLElement, delay: number) => {
        const text = textOf(el);
        if (!text) return;
        target = el;
        el.setAttribute('aria-describedby', tip.el.id);
        tip.open(el, () => withKeys(text), () => el.isConnected ? el.getBoundingClientRect() : null, delay);
    };
    const hide = () => {
        if (tip.visible) warmUntil = performance.now() + 400;
        target?.removeAttribute('aria-describedby');
        target = null;
        tip.close();
    };
    const tipTarget = (n: EventTarget | null) => (n as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]') ?? null;

    root.addEventListener('pointerover', e => {
        if (e.pointerType === 'touch') return;
        const el = tipTarget(e.target);
        if (!el || el === target) return;
        hide();
        // Moving between buttons keeps tips "warm" and shows the next one right away.
        show(el, performance.now() < warmUntil ? 0 : 450);
    });
    root.addEventListener('pointerout', e => {
        if (target && !target.contains(e.relatedTarget as Node | null)) hide();
    });
    root.addEventListener('focusin', e => {
        const el = tipTarget(e.target);
        if (el && (el as HTMLElement).matches(':focus-visible')) show(el, 0);
    });
    root.addEventListener('focusout', () => hide());
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, true);
    window.addEventListener('scroll', hide, true);
    return tip;
}

// ---------------------------------------------------------------------------
// Pieces for cards

const SEVERITY_PATHS: Record<string, string> = {
    error: '<circle cx="8" cy="8" r="7"/><path d="M5.6 5.6l4.8 4.8m0-4.8l-4.8 4.8" class="glyph"/>',
    warning: '<path d="M8 1.6l6.9 12.2H1.1z"/><path d="M8 6.1v3.5" class="glyph"/><circle cx="8" cy="11.7" r=".95" class="dot"/>',
    info: '<circle cx="8" cy="8" r="7"/><path d="M8 7.3v4.1" class="glyph"/><circle cx="8" cy="4.9" r=".95" class="dot"/>',
};

export function severityIcon(severity: string): SVGSVGElement {
    const wrap = document.createElement('span');
    wrap.innerHTML = `<svg class="sev-icon sev-${severity}" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">${SEVERITY_PATHS[severity] ?? SEVERITY_PATHS.info}</svg>`;
    return wrap.firstElementChild as SVGSVGElement;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    for (const c of children) if (c) e.append(c);
    return e;
}
