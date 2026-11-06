import {
  Timestamp,
  FieldValue,
  type Firestore,
} from "firebase-admin/firestore";

type Data = Record<string, unknown>;

interface Store {
  docs: Map<string, Data>;
  subs: Map<string, Set<string>>; // docPath -> subcollection names
  nowMs: number;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Timestamp) {
    return { __ts: value.toMillis() };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__ts" in (value as Record<string, unknown>)
  ) {
    return Timestamp.fromMillis((value as { __ts: number }).__ts);
  }
  return value;
}

function cloneData(data: Data): Data {
  return JSON.parse(JSON.stringify(data, replacer), reviver) as Data;
}

function normalizeValue(store: Store, value: unknown): unknown {
  if (value instanceof FieldValue) {
    const name = (value as object).constructor.name;
    if (name === "ServerTimestampTransform") {
      return Timestamp.fromMillis(store.nowMs);
    }
    if (name === "DeleteTransform") {
      return DELETE_SENTINEL;
    }
    throw new Error(`unsupported FieldValue transform: ${name}`);
  }
  if (Array.isArray(value)) return value.map((v) => normalizeValue(store, v));
  if (value && typeof value === "object") {
    if (value instanceof Timestamp) return value;
    const out: Data = {};
    for (const [k, v] of Object.entries(value as Data)) {
      out[k] = normalizeValue(store, v);
    }
    return out;
  }
  return value;
}

const DELETE_SENTINEL = Symbol("delete");

function setField(target: Data, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Data;
  }
  const last = parts[parts.length - 1]!;
  if (value === DELETE_SENTINEL) {
    delete cur[last];
  } else {
    cur[last] = value;
  }
}

function getField(data: Data, path: string): unknown {
  let cur: unknown = data;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Data)[p];
  }
  return cur;
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Timestamp ? a.toMillis() : a;
  const bv = b instanceof Timestamp ? b.toMillis() : b;
  if (av === bv) return 0;
  if (av === undefined || av === null) return -1;
  if (bv === undefined || bv === null) return 1;
  return (av as number) < (bv as number) ? -1 : 1;
}

function matches(data: Data, field: string, op: string, value: unknown): boolean {
  const actual = getField(data, field);
  const av = actual instanceof Timestamp ? actual.toMillis() : actual;
  const bv = value instanceof Timestamp ? value.toMillis() : value;
  switch (op) {
    case "==":
      return av === bv;
    case "!=":
      return av !== bv;
    case "<":
      return (av as number) < (bv as number);
    case "<=":
      return (av as number) <= (bv as number);
    case ">":
      return (av as number) > (bv as number);
    case ">=":
      return (av as number) >= (bv as number);
    case "in":
      return Array.isArray(bv) && (bv as unknown[]).includes(av);
    case "array-contains":
      return Array.isArray(av) && (av as unknown[]).includes(bv);
    default:
      throw new Error(`unsupported op ${op}`);
  }
}

class MemDocSnap {
  constructor(
    public readonly exists: boolean,
    private readonly data_: Data | undefined,
    public readonly id: string,
    public readonly ref: MemDocRef,
  ) {}
  data(): Data | undefined {
    return this.data_ ? cloneData(this.data_) : undefined;
  }
  get(path: string): unknown {
    return this.data_ ? getField(this.data_, path) : undefined;
  }
}

class MemQuerySnap {
  constructor(public readonly docs: MemDocSnap[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
}

interface Condition {
  field: string;
  op: string;
  value: unknown;
}

class MemQuery {
  constructor(
    protected readonly store: Store,
    protected readonly paths: () => string[],
    protected conditions: Condition[] = [],
    protected orders: Array<{ field: string; dir: "asc" | "desc" }> = [],
    protected limitN?: number,
  ) {}

  where(field: string, op: string, value: unknown): this {
    this.conditions.push({ field, op, value });
    return this;
  }
  orderBy(field: string, dir: "asc" | "desc" = "asc"): this {
    this.orders.push({ field, dir });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  async get(): Promise<MemQuerySnap> {
    let results: MemDocSnap[] = [];
    for (const path of this.paths()) {
      const data = this.store.docs.get(path);
      if (!data) continue;
      if (this.conditions.every((c) => matches(data, c.field, c.op, c.value))) {
        const id = path.split("/").pop()!;
        results.push(new MemDocSnap(true, data, id, new MemDocRef(this.store, path)));
      }
    }
    for (const o of this.orders) {
      results.sort((a, b) => {
        const c = compare(
          getField(a.data()!, o.field),
          getField(b.data()!, o.field),
        );
        return o.dir === "desc" ? -c : c;
      });
    }
    if (this.limitN !== undefined) results = results.slice(0, this.limitN);
    return new MemQuerySnap(results);
  }
}

class MemCollectionRef extends MemQuery {
  constructor(
    store: Store,
    public readonly path: string,
  ) {
    super(store, () => {
      const prefix = path + "/";
      const out: string[] = [];
      for (const p of store.docs.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
          out.push(p);
        }
      }
      return out;
    });
  }
  doc(id?: string): MemDocRef {
    const docId = id ?? `doc_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
    return new MemDocRef(this.store, `${this.path}/${docId}`);
  }
  get id(): string {
    return this.path.split("/").pop()!;
  }
  get parent(): MemDocRef | null {
    const parentPath = this.path.split("/").slice(0, -1).join("/");
    return parentPath ? new MemDocRef(this.store, parentPath) : null;
  }
}

class MemDocRef {
  constructor(
    private readonly store: Store,
    public readonly path: string,
  ) {}
  get id(): string {
    return this.path.split("/").pop()!;
  }
  get parent(): MemCollectionRef {
    return new MemCollectionRef(
      this.store,
      this.path.split("/").slice(0, -1).join("/"),
    );
  }
  collection(name: string): MemCollectionRef {
    this.registerSub(name);
    return new MemCollectionRef(this.store, `${this.path}/${name}`);
  }
  private registerSub(name: string): void {
    const set = this.store.subs.get(this.path) ?? new Set<string>();
    set.add(name);
    this.store.subs.set(this.path, set);
  }
  async listCollections(): Promise<MemCollectionRef[]> {
    const names = this.store.subs.get(this.path) ?? new Set<string>();
    return [...names].map((n) => new MemCollectionRef(this.store, `${this.path}/${n}`));
  }
  async get(): Promise<MemDocSnap> {
    const data = this.store.docs.get(this.path);
    return new MemDocSnap(!!data, data, this.id, this);
  }
  async set(data: Data, opts?: { merge?: boolean }): Promise<void> {
    const normalized = normalizeValue(this.store, data) as Data;
    if (opts?.merge && this.store.docs.has(this.path)) {
      const existing = this.store.docs.get(this.path)!;
      const merged = { ...existing };
      for (const [k, v] of Object.entries(normalized)) {
        setField(merged, k, v);
      }
      this.store.docs.set(this.path, merged);
    } else {
      this.store.docs.set(this.path, normalized);
    }
    this.registerInParent();
  }
  async update(data: Data): Promise<void> {
    const existing = this.store.docs.get(this.path);
    if (!existing) throw new Error(`not-found: ${this.path}`);
    const updated = cloneData(existing);
    for (const [k, v] of Object.entries(data)) {
      setField(updated, k, normalizeValue(this.store, v));
    }
    this.store.docs.set(this.path, updated);
  }
  async create(data: Data): Promise<void> {
    if (this.store.docs.has(this.path)) throw new Error(`already-exists: ${this.path}`);
    await this.set(data);
  }
  async delete(): Promise<void> {
    this.store.docs.delete(this.path);
  }
  private registerInParent(): void {
    const parentPath = this.path.split("/").slice(0, -2).join("/");
    const name = this.path.split("/").slice(0, -1).pop()!;
    if (parentPath) {
      const set = this.store.subs.get(parentPath) ?? new Set<string>();
      set.add(name);
      this.store.subs.set(parentPath, set);
    }
  }
}

class MemTransaction {
  constructor(private readonly store: Store) {}
  get(ref: MemDocRef): Promise<MemDocSnap>;
  get(query: MemQuery): Promise<MemQuerySnap>;
  async get(target: MemDocRef | MemQuery): Promise<MemDocSnap | MemQuerySnap> {
    return target instanceof MemQuery ? target.get() : target.get();
  }
  async set(ref: MemDocRef, data: Data, opts?: { merge?: boolean }): Promise<this> {
    await ref.set(data, opts);
    return this;
  }
  async update(ref: MemDocRef, data: Data): Promise<this> {
    await ref.update(data);
    return this;
  }
  async create(ref: MemDocRef, data: Data): Promise<this> {
    await ref.create(data);
    return this;
  }
  async delete(ref: MemDocRef): Promise<this> {
    await ref.delete();
    return this;
  }
}

class MemBatch {
  private ops: Array<() => Promise<void>> = [];
  constructor(private readonly store: Store) {}
  set(ref: MemDocRef, data: Data, opts?: { merge?: boolean }): this {
    this.ops.push(() => ref.set(data, opts));
    return this;
  }
  update(ref: MemDocRef, data: Data): this {
    this.ops.push(() => ref.update(data));
    return this;
  }
  delete(ref: MemDocRef): this {
    this.ops.push(() => ref.delete());
    return this;
  }
  async commit(): Promise<void> {
    for (const op of this.ops) await op();
    this.ops = [];
  }
}

export class MemoryFirestore {
  private store: Store = { docs: new Map(), subs: new Map(), nowMs: Date.now() };

  /** テスト用: serverTimestamp が解決する時刻を固定する。 */
  setNow(ms: number): void {
    this.store.nowMs = ms;
  }

  doc(path: string): MemDocRef {
    return new MemDocRef(this.store, path);
  }
  collection(path: string): MemCollectionRef {
    return new MemCollectionRef(this.store, path);
  }
  collectionGroup(name: string): MemQuery {
    return new MemQuery(this.store, () => {
      const out: string[] = [];
      for (const p of this.store.docs.keys()) {
        const parent = p.split("/").slice(0, -1).join("/");
        if (parent.split("/").pop() === name) out.push(p);
      }
      return out;
    });
  }
  async runTransaction<T>(fn: (tx: MemTransaction) => Promise<T>): Promise<T> {
    const tx = new MemTransaction(this.store);
    return fn(tx);
  }
  batch(): MemBatch {
    return new MemBatch(this.store);
  }

  /** Firestore として使うためのキャスト口。 */
  asFirestore(): Firestore {
    return this as unknown as Firestore;
  }

  /** テスト補助: 全ドキュメントパス一覧。 */
  listAllPaths(): string[] {
    return [...this.store.docs.keys()];
  }
  raw(path: string): Data | undefined {
    return this.store.docs.get(path);
  }
}
