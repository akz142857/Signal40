import type { SqlDatabase, SqlQueryResult, SqlRunResult, SqlStatement } from './sql.ts';

/**
 * PostgreSQL 的 `SqlDatabase` 实现。
 *
 * 只依赖 `query(text, values)` 这一个能力，所以 `pg.Pool`、`pg.Client` 和
 * PGlite 都能直接喂进来——测试因此可以在进程内的真 PG 上跑，不需要起容器。
 */

/** 执行器：`pg.Pool` / `pg.PoolClient` / PGlite 都满足这个形状。 */
export interface PgQueryRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }>;
}

/** 能开事务的执行器。`pg.Pool` 有 `connect()`；PGlite 用 `transaction()`。 */
export interface PgTransactionRunner extends PgQueryRunner {
  connect?(): Promise<PgQueryRunner & { release(): void }>;
}

/**
 * 把 D1/SQLite 风格的 `?` 占位符换成 PG 的 `$1..$n`。
 *
 * 225 处 SQL 全部写的是 `?`，在这里统一转换比逐条改写安全得多。
 * 单引号字符串内部的 `?` 不算占位符（PG 用 `''` 转义引号，这里一并处理）。
 */
export function toPositionalPlaceholders(sql: string) {
  let out = '';
  let parameter = 0;
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (inString) {
      out += character;
      if (character === "'") {
        if (sql[index + 1] === "'") {
          out += "'";
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      out += character;
      continue;
    }
    if (character === '?') {
      parameter += 1;
      out += `$${parameter}`;
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * 让 node-postgres 把 int8 当数字返回。
 *
 * `COUNT(*)` 和 `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` 在 PG 里都是 int8，
 * node-postgres 默认按字符串返回，而 SQLite 和 PGlite 返回数字——
 * 不做这一步，测试会全绿而生产上 `total > 0` 这类判断会静默失效。
 * 计数值远小于 2^53，转成 number 不会丢精度。
 *
 * 在建连接池之前调用一次：`configurePgTypeParsers(pgTypes)`。
 */
export function configurePgTypeParsers(types: { setTypeParser(oid: number, parser: (value: string) => unknown): void }) {
  const INT8 = 20;
  types.setTypeParser(INT8, (value) => Number(value));
}

function changesOf(result: { rowCount?: number | null; affectedRows?: number }) {
  return result.rowCount ?? result.affectedRows ?? 0;
}

class PgStatement implements SqlStatement {
  // 显式字段而不是构造函数参数属性：仓库用 --experimental-strip-types 纯剥离模式跑 TS。
  readonly text: string;
  readonly values: unknown[];
  private readonly runner: PgTransactionRunner;

  constructor(runner: PgTransactionRunner, text: string, values: unknown[] = []) {
    this.runner = runner;
    this.text = text;
    this.values = values;
  }

  bind(...values: unknown[]): SqlStatement {
    return new PgStatement(this.runner, this.text, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.runner.query(this.text, this.values);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>> {
    const result = await this.runner.query(this.text, this.values);
    return { results: result.rows as T[], meta: { changes: changesOf(result) } };
  }

  async run(): Promise<SqlRunResult> {
    const result = await this.runner.query(this.text, this.values);
    return { meta: { changes: changesOf(result) } };
  }
}

export function createPgDatabase(runner: PgTransactionRunner): SqlDatabase {
  /** 取一个独占连接跑显式事务；PGlite 这类单连接实现没有 connect()，直接复用本体。 */
  async function withConnection<T>(run: (executor: PgQueryRunner) => Promise<T>): Promise<T> {
    const client = runner.connect ? await runner.connect() : null;
    const executor: PgQueryRunner = client ?? runner;
    await executor.query('BEGIN');
    try {
      const value = await run(executor);
      await executor.query('COMMIT');
      return value;
    } catch (error) {
      await executor.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  return {
    prepare(sql) {
      return new PgStatement(runner, toPositionalPlaceholders(sql));
    },
    transaction(run) {
      return withConnection((executor) => run(createPgDatabase(executor)));
    },
    async batch(statements) {
      const prepared = statements.map((statement) => {
        if (!(statement instanceof PgStatement)) throw new TypeError('batch 只接受同一个 PG 连接创建的语句。');
        return statement;
      });
      return withConnection(async (executor) => {
        const results: SqlRunResult[] = [];
        for (const statement of prepared) {
          const result = await executor.query(statement.text, statement.values);
          results.push({ meta: { changes: changesOf(result) } });
        }
        return results;
      });
    },
  };
}
