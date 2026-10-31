import { Model, ViewNode } from './model';

export interface OutlineCallbacks {
    onSelect(node: ViewNode): void;
}

/** Collapsible text view of the tree. Handles trees too large for the graph. */
export class OutlineView {
    private rows = new Map<number, HTMLElement>();
    private items = new Map<number, HTMLLIElement>();
    private collapsed = new Set<string>();
    private classes = new Map<string, Set<number>>();
    private model: Model | null = null;
    private keys = new Map<number, string>();

    constructor(private host: HTMLElement, private cb: OutlineCallbacks) {
        host.addEventListener('click', e => {
            const target = e.target as HTMLElement;
            const li = target.closest('li') as HTMLLIElement | null;
            if (!li || !this.model) return;
            const node = this.model.nodes[Number(li.dataset.id)];
            if (!node) return;
            if (target.closest('.twisty')) {
                this.toggle(li, node);
            } else {
                this.cb.onSelect(node);
            }
            e.stopPropagation();
        });
    }

    render(model: Model) {
        this.model = model;
        this.rows.clear();
        this.items.clear();
        this.keys.clear();
        const root = document.createElement('ul');
        root.className = 'outline-root';
        if (model.root) root.append(this.item(model.root, `${model.root.name}#0`));
        this.host.replaceChildren(root);
        for (const [cls, ids] of this.classes) for (const id of ids) this.rows.get(id)?.classList.add(cls);
    }

    mark(cls: string, nodes: ViewNode[]) {
        const prev = this.classes.get(cls);
        if (prev) for (const id of prev) this.rows.get(id)?.classList.remove(cls);
        const next = new Set(nodes.map(n => n.id));
        this.classes.set(cls, next);
        for (const id of next) this.rows.get(id)?.classList.add(cls);
    }

    reveal(node: ViewNode) {
        for (let p = node.parent; p; p = p.parent) {
            const li = this.items.get(p.id);
            if (li?.classList.contains('closed')) this.toggle(li, p);
        }
        this.rows.get(node.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    setAll(open: boolean) {
        if (!this.model) return;
        // Keys are the chain of rule names and child positions, so fold state survives re-parses.
        this.collapsed.clear();
        for (const n of this.model.nodes) {
            if (!n.children.length || n === this.model.root) continue;
            if (!open) this.collapsed.add(this.keys.get(n.id)!);
            this.items.get(n.id)?.classList.toggle('closed', !open);
        }
    }

    private toggle(li: HTMLLIElement, node: ViewNode) {
        const closed = li.classList.toggle('closed');
        const key = this.keys.get(node.id)!;
        if (closed) this.collapsed.add(key); else this.collapsed.delete(key);
    }

    private item(n: ViewNode, key: string): HTMLLIElement {
        const li = document.createElement('li');
        li.dataset.id = String(n.id);
        this.keys.set(n.id, key);
        if (this.collapsed.has(key)) li.classList.add('closed');
        const row = document.createElement('div');
        row.className = `row kind-${n.kind}`;
        const twisty = document.createElement('span');
        twisty.className = 'twisty';
        if (n.children.length) twisty.setAttribute('aria-label', 'Expand or collapse');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = n.name;
        row.append(twisty, name);
        if (n.text !== undefined) {
            const text = document.createElement('span');
            text.className = 'text';
            text.textContent = JSON.stringify(n.text);
            row.append(text);
        }
        if (n.range) {
            const pos = document.createElement('span');
            pos.className = 'pos';
            pos.textContent = `${n.range.from.line + 1}:${n.range.from.col + 1}`;
            row.append(pos);
        }
        li.append(row);
        this.rows.set(n.id, row);
        this.items.set(n.id, li);
        if (n.children.length) {
            li.classList.add('has-children');
            const ul = document.createElement('ul');
            n.children.forEach((c, i) => ul.append(this.item(c, `${key}/${c.name}#${i}`)));
            li.append(ul);
        }
        return li;
    }
}
