/**
 * 控制面使用的 SQL 客户端接口。
 *
 * 这是控制面实际需要的方法子集（prepare/bind/first/all/run/batch），刻意做成
 * 后端无关的形状：`lib/` 里的函数只依赖这个接口，不依赖具体 PostgreSQL
 * 客户端，替换连接池实现时不用改调用方。
 *
 * 不在接口里的能力就是有意不给的：没有 `exec`（多语句执行，注入面大），
 * 没有游标/流式读取（当前所有查询都带 LIMIT）。需要时再加，不要顺手放开。
 */

/** 批量写入返回的元信息；`changes` 是乐观并发判定的唯一依据。 */
export type SqlRunMeta = { changes: number };

export type SqlRunResult = { meta: SqlRunMeta };

export type SqlQueryResult<T> = { results: T[]; meta: SqlRunMeta };

export interface SqlStatement {
  /** 绑定占位符参数，返回可执行语句。实现必须使用参数化绑定，不得做字符串拼接。 */
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>>;
  run(): Promise<SqlRunResult>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** 事务语义：全部成功或全部回滚，返回结果与入参顺序一一对应。 */
  batch(statements: SqlStatement[]): Promise<SqlRunResult[]>;
  /**
   * 在一个事务里交错读写。回调必须只用传入的 `tx` 建语句——
   * 用外层的 `db` 建的语句会落到事务外面。
   *
   * `batch` 表达不了「先按条件选一行并锁住，再据此决定写什么」，
   * 作业租约正需要这个：没有它就只能靠「先 SELECT、再用重复一遍条件的
   * 守卫 UPDATE 抢」这种绕法。
   */
  transaction<T>(run: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}
