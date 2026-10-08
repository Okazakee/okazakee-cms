/**
 * Deterministic in-process Supabase boundary fake for dispatcher tests.
 *
 * It implements only the query-builder surface the CMS actions use
 * (select/insert/update/upsert/delete + eq/in/filter/single/maybeSingle) and an
 * in-memory Storage bucket. No network, no secrets, no real Postgres.
 *
 * The spec's `src/testing/lib` harness is an out-of-process E2E fixture server
 * (real local Supabase, used by `start-isolated.mjs`); it cannot run inside
 * vitest. This unit fake is the in-process equivalent for the required
 * "real dispatcher + injected external boundary" tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export interface FakeSupabaseState {
  tables: Record<string, Row[]>;
  objects: Record<string, unknown>;
  uploads: string[];
  removed: string[];
  log: Array<{ table: string; mode: string; payload?: unknown }>;
  failNext: {
    table: string;
    mode: string;
    message: string;
    code?: string;
    times?: number;
    after?: number;
    throws?: boolean;
  } | null;
  failUpload: { pathIncludes?: string; message: string } | null;
}

export interface FakeSupabaseOptions {
  tables?: Record<string, Row[]>;
  user?: { id: string; email: string } | null;
  failNext?: {
    table: string;
    mode: string;
    message: string;
    code?: string;
    times?: number;
    after?: number;
    throws?: boolean;
  } | null;
  failUpload?: { pathIncludes?: string; message: string } | null;
}

export interface FakeSupabase {
  client: SupabaseClient;
  state: FakeSupabaseState;
}

function matchesFilter(
  row: Row,
  column: string,
  op: string,
  value: unknown
): boolean {
  const actual = row[column];
  if (op === 'eq') {
    if (typeof value === 'string' && value.startsWith('{')) {
      return JSON.stringify(actual) === value;
    }
    return actual === value;
  }
  if (op === 'neq') return actual !== value;
  return true;
}

class QueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  private mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private filters: Array<(row: Row) => boolean> = [];
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private returning = false;
  private columns = '*';
  private orders: Array<{
    column: string;
    ascending: boolean;
    nullsFirst: boolean;
  }> = [];

  constructor(
    private state: FakeSupabaseState,
    private table: string
  ) {}

  select(columns = '*'): this {
    this.columns = columns;
    this.returning = true;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }

  upsert(payload: Row): this {
    this.mode = 'upsert';
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => matchesFilter(row, column, 'eq', value));
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  filter(column: string, op: string, value: unknown): this {
    this.filters.push((row) => matchesFilter(row, column, op, value));
    return this;
  }

  order(
    column: string,
    options: {
      ascending?: boolean;
      nullsFirst?: boolean;
      referencedTable?: string;
    } = {}
  ): this {
    if (!options.referencedTable) {
      this.orders.push({
        column,
        ascending: options.ascending ?? true,
        nullsFirst: options.nullsFirst ?? false,
      });
    }
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable by design.
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: unknown;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    if (!this.state.tables[this.table]) this.state.tables[this.table] = [];
    return this.state.tables[this.table];
  }

  private async execute(): Promise<{ data: unknown; error: unknown }> {
    const rows = this.rows();
    this.state.log.push({
      table: this.table,
      mode: this.mode,
      payload: this.payload ?? undefined,
    });

    const fail = this.state.failNext;
    if (fail && fail.table === this.table && fail.mode === this.mode) {
      if ((fail.after ?? 0) > 0) fail.after = (fail.after ?? 0) - 1;
      else {
        const remaining = (fail.times ?? 1) - 1;
        if (remaining <= 0) this.state.failNext = null;
        else fail.times = remaining;
        if (fail.throws) throw new Error(fail.message);
        return {
          data: null,
          error: { message: fail.message, code: fail.code ?? 'FAKE' },
        };
      }
    }

    let result: Row[] = [];

    if (this.mode === 'select') {
      result = rows.filter((row) => this.filters.every((f) => f(row)));
    } else if (this.mode === 'insert') {
      const incoming = Array.isArray(this.payload)
        ? this.payload
        : [this.payload as Row];
      for (const row of incoming) {
        const stored = { ...row };
        if (stored.id === undefined) {
          const maxId = rows.reduce(
            (max, existing) => Math.max(max, Number(existing.id) || 0),
            0
          );
          stored.id = maxId + 1;
        }
        rows.push(stored);
        result.push(stored);
      }
    } else if (this.mode === 'update') {
      const matched = rows.filter((row) => this.filters.every((f) => f(row)));
      for (const row of matched) Object.assign(row, this.payload);
      result = matched;
    } else if (this.mode === 'upsert') {
      const row = this.payload as Row;
      const key = row.id !== undefined ? 'id' : 'language';
      const index = rows.findIndex((existing) => existing[key] === row[key]);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...row };
        result = [rows[index]];
      } else {
        rows.push({ ...row });
        result = [rows[rows.length - 1]];
      }
    } else if (this.mode === 'delete') {
      const kept: Row[] = [];
      for (const row of rows) {
        if (this.filters.every((f) => f(row))) result.push(row);
        else kept.push(row);
      }
      this.state.tables[this.table] = kept;
    }

    if (this.orders.length > 0) {
      result.sort((a, b) => {
        for (const order of this.orders) {
          const left = a[order.column];
          const right = b[order.column];
          if (left == null && right == null) continue;
          if (left == null) return order.nullsFirst ? -1 : 1;
          if (right == null) return order.nullsFirst ? 1 : -1;
          const comparison =
            typeof left === 'number' && typeof right === 'number'
              ? left - right
              : String(left).localeCompare(String(right));
          if (comparison !== 0)
            return order.ascending ? comparison : -comparison;
        }
        return 0;
      });
    }

    if (!this.columns.includes('*')) {
      const columns = this.columns.split(',').map((column) => column.trim());
      result = result.map((row) =>
        Object.fromEntries(columns.map((column) => [column, row[column]]))
      );
    }

    if (this.singleMode) {
      if (result.length !== 1) {
        if (result.length === 0 && this.singleMode === 'maybeSingle') {
          return { data: null, error: null };
        }
        return {
          data: null,
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
            details: `${result.length} rows`,
          },
        };
      }
      return { data: result[0], error: null };
    }

    return { data: this.returning ? result : null, error: null };
  }
}

class FakeStorageBucket {
  constructor(
    private state: FakeSupabaseState,
    private bucket: string
  ) {}

  async upload(
    path: string,
    _data: unknown,
    options?: { upsert?: boolean }
  ): Promise<{ data: unknown; error: unknown }> {
    const fail = this.state.failUpload;
    if (fail && (!fail.pathIncludes || path.includes(fail.pathIncludes))) {
      return { data: null, error: { message: fail.message } };
    }
    const full = `${this.bucket}/${path}`;
    if (this.state.objects[full] !== undefined && !options?.upsert) {
      return { data: null, error: { message: 'The resource already exists' } };
    }
    this.state.objects[full] = _data;
    this.state.uploads.push(path);
    return { data: { path }, error: null };
  }

  async remove(paths: string[]): Promise<{ data: unknown; error: unknown }> {
    for (const path of paths) {
      delete this.state.objects[`${this.bucket}/${path}`];
      this.state.removed.push(path);
    }
    return { data: paths.map((path) => ({ name: path })), error: null };
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    return {
      data: {
        publicUrl: `https://fake.supabase.co/storage/v1/object/public/${this.bucket}/${path}`,
      },
    };
  }
}

export function createFakeSupabase(
  options: FakeSupabaseOptions = {}
): FakeSupabase {
  const state: FakeSupabaseState = {
    tables: options.tables ?? {},
    objects: {},
    uploads: [],
    removed: [],
    log: [],
    failNext: options.failNext ?? null,
    failUpload: options.failUpload ?? null,
  };

  const user =
    options.user === undefined
      ? { id: 'user-1', email: 'admin@example.com' }
      : options.user;

  const client = {
    from: (table: string) => new QueryBuilder(state, table),
    storage: {
      from: (bucket: string) => new FakeStorageBucket(state, bucket),
    },
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      admin: {
        createUser: async () => ({
          data: { user: { id: 'created-user' } },
          error: null,
        }),
      },
    },
  } as unknown as SupabaseClient;

  return { client, state };
}
