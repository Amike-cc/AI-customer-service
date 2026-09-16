/**
 * Mock 数据库辅助工具
 *
 * 提供 better-sqlite3 的内存模拟实现，用于不需要原生模块的单元测试。
 * 支持 CREATE TABLE / INSERT / SELECT / UPDATE / DELETE / 聚合查询。
 * 支持 INSERT 混合字面量与参数、UPDATE 算术表达式、WHERE 字面量、
 * 聚合查询带 WHERE、LIMIT ? 参数、UNIQUE 约束强制。
 */
export interface MockStatement {
  run: (...params: any[]) => { lastInsertRowid: number | bigint; changes: number };
  get: (...params: any[]) => any;
  all: (...params: any[]) => any[];
}

interface MockTable {
  columns: string[];
  rows: Map<number, Record<string, any>>;
  autoIncrement: number;
}

interface ColumnDef {
  name: string;
  type: string;
  primaryKey: boolean;
  autoIncrement: boolean;
  notNull: boolean;
  unique: boolean;
  defaultValue: any;
}

interface UniqueConstraint {
  columns: string[];
}

interface ValueToken {
  type: 'param' | 'literal';
  value?: any;
}

interface SetExpression {
  column: string;
  type: 'param' | 'literal' | 'arithmetic';
  value?: any;
  arithCol?: string;
  arithOp?: string;
  arithValType?: 'param' | 'literal';
  arithVal?: any;
}

interface Condition {
  column: string;
  op: string;
  type: 'param' | 'literal';
  value?: any;
}

interface ColumnSpec {
  dbColumn: string;
  alias: string;
}

interface OnConflictAssignment {
  column: string;
  type: 'excluded' | 'coalesce';
  excludedCol?: string;
  coalesceExcludedCol?: string;
  coalesceFallbackTable?: string;
  coalesceFallbackCol?: string;
}

interface OnConflictInfo {
  targetColumns: string[];
  assignments: OnConflictAssignment[];
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      inString = false;
      current += ch;
    } else if (ch === '(' && !inString) {
      depth++;
      current += ch;
    } else if (ch === ')' && !inString) {
      depth--;
      current += ch;
    } else if (ch === ';' && !inString && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function parseCreateTable(sql: string): { table: string; columns: ColumnDef[]; uniques: UniqueConstraint[] } | null {
  const match = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*)\)/i);
  if (!match) return null;
  const table = match[1];
  const body = match[2];
  const columns: ColumnDef[] = [];
  const uniques: UniqueConstraint[] = [];

  const parts = body.split(/,\s*(?![^()]*\))/);
  for (const part of parts) {
    const trimmed = part.trim();
    const uniqueMatch = trimmed.match(/^UNIQUE\s*\(([^)]+)\)/i);
    if (uniqueMatch) {
      uniques.push({ columns: uniqueMatch[1].split(',').map((s) => s.trim()) });
      continue;
    }
    if (/^(PRIMARY|FOREIGN|INDEX|CREATE|CHECK)/i.test(trimmed)) continue;
    const colMatch = trimmed.match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i);
    if (colMatch) {
      columns.push({
        name: colMatch[1],
        type: colMatch[2].toUpperCase(),
        primaryKey: /PRIMARY\s+KEY/i.test(trimmed),
        autoIncrement: /AUTOINCREMENT/i.test(trimmed),
        notNull: /NOT\s+NULL/i.test(trimmed),
        unique: /UNIQUE/i.test(trimmed),
        defaultValue: null,
      });
    }
  }
  return { table, columns, uniques };
}

function parseOnConflict(sql: string): { cleaned: string; onConflict: OnConflictInfo | null } {
  const match = sql.match(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET\s+([\s\S]*?)$/i);
  if (!match) {
    return { cleaned: sql, onConflict: null };
  }
  const targetColumns = match[1].split(',').map((s) => s.trim());
  const setStr = match[2].trim().replace(/,$/, '').trim();
  const assignments: OnConflictAssignment[] = [];
  const parts = splitByCommaRespectingParens(setStr);
  for (const part of parts) {
    const trimmed = part.trim();
    const excludedMatch = trimmed.match(/^(\w+)\s*=\s*excluded\.(\w+)$/i);
    if (excludedMatch) {
      assignments.push({ column: excludedMatch[1], type: 'excluded', excludedCol: excludedMatch[2] });
      continue;
    }
    const coalesceMatch = trimmed.match(/^(\w+)\s*=\s*COALESCE\s*\(\s*excluded\.(\w+)\s*,\s*(\w+)\.(\w+)\s*\)$/i);
    if (coalesceMatch) {
      assignments.push({
        column: coalesceMatch[1],
        type: 'coalesce',
        coalesceExcludedCol: coalesceMatch[2],
        coalesceFallbackTable: coalesceMatch[3],
        coalesceFallbackCol: coalesceMatch[4],
      });
      continue;
    }
  }
  const cleaned = sql.replace(/\s+ON\s+CONFLICT[\s\S]*$/i, '');
  return { cleaned, onConflict: { targetColumns, assignments } };
}

function splitByCommaRespectingParens(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      inString = false;
      current += ch;
    } else if (ch === '(' && !inString) {
      depth++;
      current += ch;
    } else if (ch === ')' && !inString) {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0 && !inString) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseInsert(sql: string): { table: string; columns: string[]; valueTokens: ValueToken[]; onConflict: OnConflictInfo | null } | null {
  const { cleaned: cleanedSql, onConflict } = parseOnConflict(sql);
  const match = cleanedSql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)/i);
  if (!match) return null;
  const table = match[1];
  const columns = match[2].split(',').map((s) => s.trim());
  const valuesStr = match[3];
  const valueTokens = parseValueTokens(valuesStr);
  return { table, columns, valueTokens, onConflict };
}

function parseValueTokens(valuesStr: string): ValueToken[] {
  const tokens: ValueToken[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < valuesStr.length; i++) {
    const ch = valuesStr[i];
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      inString = false;
      current += ch;
    } else if (ch === ',' && !inString) {
      tokens.push(parseValueToken(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(parseValueToken(current.trim()));
  return tokens;
}

function parseValueToken(str: string): ValueToken {
  if (str === '?') return { type: 'param' };
  if (str.startsWith("'") && str.endsWith("'")) {
    return { type: 'literal', value: str.slice(1, -1) };
  }
  const num = Number(str);
  if (!isNaN(num) && str.trim() !== '') return { type: 'literal', value: num };
  return { type: 'literal', value: str };
}

function parseSelect(sql: string): {
  table: string;
  columnSpecs: ColumnSpec[];
  whereClause: string | null;
  orderBy: Array<{ column: string; direction: string }>;
  limit: { type: 'param' | 'literal'; value?: number } | null;
  isAggregate: boolean;
  aggregateExprs: { expr: string; alias: string }[];
} | null {
  let work = sql.trim();

  // Extract LIMIT
  let limit: { type: 'param' | 'literal'; value?: number } | null = null;
  const limitMatch = work.match(/\s+LIMIT\s+(\?|\d+)$/i);
  if (limitMatch) {
    work = work.replace(/\s+LIMIT\s+(\?|\d+)$/i, '');
    if (limitMatch[1] === '?') {
      limit = { type: 'param' };
    } else {
      limit = { type: 'literal', value: parseInt(limitMatch[1]) };
    }
  }

  // Extract ORDER BY (ASC|DESC 可选，SQLite 默认 ASC)
  let orderBy: Array<{ column: string; direction: string }> = [];
  const orderMatch = work.match(/\s+ORDER\s+BY\s+([\w\s,]+)$/i);
  if (orderMatch) {
    work = work.replace(/\s+ORDER\s+BY\s+([\w\s,]+)$/i, '');
    orderBy = orderMatch[1].split(',').map((part) => {
      const normalized = part.trim().replace(/\s+NULLS\s+(?:FIRST|LAST)$/i, '');
      const match = normalized.match(/^(\w+)(?:\s+(ASC|DESC))?$/i)!;
      return { column: match[1], direction: (match[2] || 'ASC').toUpperCase() };
    });
  }

  // Extract WHERE
  let whereClause: string | null = null;
  const whereMatch = work.match(/\s+WHERE\s+(.*)$/is);
  if (whereMatch) {
    work = work.replace(/\s+WHERE\s+(.*)$/is, '');
    whereClause = whereMatch[1].trim();
  }

  // Extract SELECT ... FROM table
  const mainMatch = work.match(/SELECT\s+(.*?)\s+FROM\s+(\w+)$/is);
  if (!mainMatch) return null;

  const columnsStr = mainMatch[1].trim();
  const table = mainMatch[2];

  // Check if aggregate query
  const isAggregate = /\b(COUNT|SUM|AVG|MAX|MIN)\s*\(/i.test(columnsStr);

  if (isAggregate) {
    const aggregateExprs = parseAggregateColumns(columnsStr);
    return { table, columnSpecs: [], whereClause, orderBy, limit, isAggregate, aggregateExprs };
  }

  // Parse regular columns
  // SELECT * 特殊处理：返回空 columnSpecs，transformRow 会返回所有列
  if (columnsStr === '*') {
    return { table, columnSpecs: [], whereClause, orderBy, limit, isAggregate: false, aggregateExprs: [] };
  }
  const columnSpecs: ColumnSpec[] = columnsStr.split(',').map((s) => {
    const trimmed = s.trim();
    const aliasMatch = trimmed.match(/^(\w+)\s+(?:AS\s+)?(\w+)$/i);
    if (aliasMatch) {
      return { dbColumn: aliasMatch[1], alias: aliasMatch[2] };
    }
    return { dbColumn: trimmed, alias: trimmed };
  });

  return { table, columnSpecs, whereClause, orderBy, limit, isAggregate: false, aggregateExprs: [] };
}

function parseAggregateColumns(columnsStr: string): { expr: string; alias: string }[] {
  const exprs: { expr: string; alias: string }[] = [];
  let depth = 0;
  let current = '';
  let inString = false;

  for (let i = 0; i < columnsStr.length; i++) {
    const ch = columnsStr[i];
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      inString = false;
      current += ch;
    } else if (ch === '(' && !inString) {
      depth++;
      current += ch;
    } else if (ch === ')' && !inString) {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0 && !inString) {
      const { expr, alias } = parseAggregateExpr(current.trim());
      exprs.push({ expr, alias });
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    const { expr, alias } = parseAggregateExpr(current.trim());
    exprs.push({ expr, alias });
  }
  return exprs;
}

function parseAggregateExpr(str: string): { expr: string; alias: string } {
  const aliasMatch = str.match(/\s+AS\s+(\w+)$/i);
  if (aliasMatch) {
    return { expr: str.replace(/\s+AS\s+(\w+)$/i, '').trim(), alias: aliasMatch[1] };
  }
  return { expr: str, alias: str };
}

function parseUpdate(sql: string): { table: string; sets: SetExpression[]; whereClause: string | null } | null {
  const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]*))?$/i);
  if (!match) return null;
  const table = match[1];
  const setStr = match[2].trim();
  const whereClause = match[3]?.trim() || null;
  const sets = parseSetClause(setStr);
  return { table, sets, whereClause };
}

function parseSetClause(setStr: string): SetExpression[] {
  const sets: SetExpression[] = [];
  const parts = setStr.split(',').map((s) => s.trim());
  for (const part of parts) {
    sets.push(parseSetExpression(part));
  }
  return sets;
}

function parseSetExpression(str: string): SetExpression {
  // Arithmetic: column = column + ? or column = column + 1
  const arithMatch = str.match(/^(\w+)\s*=\s*(\w+)\s*([+\-])\s*(\?|\d+|'[^']*')$/);
  if (arithMatch) {
    const column = arithMatch[1];
    const arithCol = arithMatch[2];
    const arithOp = arithMatch[3];
    const valStr = arithMatch[4];
    if (valStr === '?') {
      return { column, type: 'arithmetic', arithCol, arithOp, arithValType: 'param' };
    }
    if (valStr.startsWith("'")) {
      return { column, type: 'arithmetic', arithCol, arithOp, arithValType: 'literal', arithVal: valStr.slice(1, -1) };
    }
    return { column, type: 'arithmetic', arithCol, arithOp, arithValType: 'literal', arithVal: Number(valStr) };
  }

  // Literal string: column = 'value'
  const strLiteralMatch = str.match(/^(\w+)\s*=\s*'([^']*)'$/);
  if (strLiteralMatch) {
    return { column: strLiteralMatch[1], type: 'literal', value: strLiteralMatch[2] };
  }

  // Literal number: column = 0
  const numLiteralMatch = str.match(/^(\w+)\s*=\s*(\d+(?:\.\d+)?)$/);
  if (numLiteralMatch) {
    return { column: numLiteralMatch[1], type: 'literal', value: Number(numLiteralMatch[2]) };
  }

  // Parameter: column = ?
  const paramMatch = str.match(/^(\w+)\s*=\s*\?$/);
  if (paramMatch) {
    return { column: paramMatch[1], type: 'param' };
  }

  // Fallback: try to extract column = something
  const fallbackMatch = str.match(/^(\w+)\s*=\s*(.+)$/);
  if (fallbackMatch) {
    return { column: fallbackMatch[1], type: 'literal', value: fallbackMatch[2] };
  }

  return { column: str, type: 'literal', value: null };
}

function parseDelete(sql: string): { table: string; whereClause: string | null } | null {
  const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { table: match[1], whereClause: match[2]?.trim() || null };
}

function parseWhereClause(whereClause: string): Condition[] {
  if (!whereClause) return [];
  const conditions: Condition[] = [];
  const parts = whereClause.split(/\s+AND\s+/i);
  for (const part of parts) {
    const trimmed = part.trim();

    // IS NULL
    const isNullMatch = trimmed.match(/^(\w+)\s+IS\s+NULL/i);
    if (isNullMatch) {
      conditions.push({ column: isNullMatch[1], op: 'IS NULL', type: 'literal', value: null });
      continue;
    }

    // IS NOT NULL
    const isNotNullMatch = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL/i);
    if (isNotNullMatch) {
      conditions.push({ column: isNotNullMatch[1], op: 'IS NOT NULL', type: 'literal', value: null });
      continue;
    }

    // Comparison with parameter: column >= ?, column > ?, etc.
    const paramMatch = trimmed.match(/^(\w+)\s*(>=|<=|!=|>|<|=)\s*\?$/);
    if (paramMatch) {
      conditions.push({ column: paramMatch[1], op: paramMatch[2], type: 'param' });
      continue;
    }

    // Comparison with string literal: column = 'value'
    const strLiteralMatch = trimmed.match(/^(\w+)\s*(>=|<=|!=|>|<|=)\s*'([^']*)'$/);
    if (strLiteralMatch) {
      conditions.push({ column: strLiteralMatch[1], op: strLiteralMatch[2], type: 'literal', value: strLiteralMatch[3] });
      continue;
    }

    // Comparison with numeric literal: column = 0, column > 0
    const numLiteralMatch = trimmed.match(/^(\w+)\s*(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
    if (numLiteralMatch) {
      conditions.push({ column: numLiteralMatch[1], op: numLiteralMatch[2], type: 'literal', value: Number(numLiteralMatch[3]) });
      continue;
    }
  }
  return conditions;
}

function evaluateConditions(row: Record<string, any>, conditions: Condition[], params: any[], paramIdx: { i: number }): boolean {
  for (const cond of conditions) {
    const rowVal = row[cond.column];

    if (cond.op === 'IS NULL') {
      if (rowVal !== null && rowVal !== undefined) return false;
      continue;
    }
    if (cond.op === 'IS NOT NULL') {
      if (rowVal === null || rowVal === undefined) return false;
      continue;
    }

    let compareVal: any;
    if (cond.type === 'param') {
      compareVal = params[paramIdx.i++];
    } else {
      compareVal = cond.value;
    }

    switch (cond.op) {
      case '=':
        if (rowVal != compareVal) return false;
        break;
      case '!=':
        if (rowVal == compareVal) return false;
        break;
      case '>':
        if (!(Number(rowVal) > Number(compareVal))) return false;
        break;
      case '>=':
        if (!(Number(rowVal) >= Number(compareVal))) return false;
        break;
      case '<':
        if (!(Number(rowVal) < Number(compareVal))) return false;
        break;
      case '<=':
        if (!(Number(rowVal) <= Number(compareVal))) return false;
        break;
    }
  }
  return true;
}

function transformRow(row: Record<string, any>, columnSpecs: ColumnSpec[]): Record<string, any> {
  if (columnSpecs.length === 0) {
    // SELECT * 返回原始 snake_case 列名，与 better-sqlite3 行为一致
    return { ...row };
  }
  const result: Record<string, any> = {};
  for (const spec of columnSpecs) {
    const alias = snakeToCamel(spec.alias);
    result[alias] = row[spec.dbColumn];
  }
  return result;
}

function executeAggregate(
  exprs: { expr: string; alias: string }[],
  rows: Record<string, any>[],
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const { expr, alias } of exprs) {
    // COUNT(*)
    if (/COUNT\s*\(\s*\*\s*\)/i.test(expr)) {
      result[alias] = rows.length;
      continue;
    }

    // SUM(CASE WHEN column > 0 THEN 1 ELSE 0 END)
    const sumCaseMatch = expr.match(/SUM\s*\(\s*CASE\s+WHEN\s+(\w+)\s*(>|<|>=|<=|=|!=)\s*(\d+)\s+THEN\s+(\d+)\s+ELSE\s+(\d+)\s+END\s*\)/i);
    if (sumCaseMatch) {
      const col = sumCaseMatch[1];
      const op = sumCaseMatch[2];
      const threshold = Number(sumCaseMatch[3]);
      const thenVal = Number(sumCaseMatch[4]);
      const elseVal = Number(sumCaseMatch[5]);
      result[alias] = rows.reduce((sum, r) => {
        const val = Number(r[col]);
        let conditionMet = false;
        switch (op) {
          case '>': conditionMet = val > threshold; break;
          case '<': conditionMet = val < threshold; break;
          case '>=': conditionMet = val >= threshold; break;
          case '<=': conditionMet = val <= threshold; break;
          case '=': conditionMet = val == threshold; break;
          case '!=': conditionMet = val != threshold; break;
        }
        return sum + (conditionMet ? thenVal : elseVal);
      }, 0);
      continue;
    }

    // SUM(column)
    const sumMatch = expr.match(/SUM\s*\(\s*(\w+)\s*\)/i);
    if (sumMatch) {
      const col = sumMatch[1];
      result[alias] = rows.reduce((sum, r) => sum + Number(r[col] || 0), 0);
      continue;
    }

    // AVG(column)
    const avgMatch = expr.match(/AVG\s*\(\s*(\w+)\s*\)/i);
    if (avgMatch) {
      const col = avgMatch[1];
      const vals = rows.map((r) => Number(r[col] || 0));
      result[alias] = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      continue;
    }

    // MAX(column)
    const maxMatch = expr.match(/MAX\s*\(\s*(\w+)\s*\)/i);
    if (maxMatch) {
      const col = maxMatch[1];
      result[alias] = rows.length > 0 ? Math.max(...rows.map((r) => Number(r[col] || 0))) : null;
      continue;
    }

    // MIN(column)
    const minMatch = expr.match(/MIN\s*\(\s*(\w+)\s*\)/i);
    if (minMatch) {
      const col = minMatch[1];
      result[alias] = rows.length > 0 ? Math.min(...rows.map((r) => Number(r[col] || 0))) : null;
      continue;
    }

    // COALESCE(column, default)
    const coalesceMatch = expr.match(/COALESCE\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/i);
    if (coalesceMatch) {
      const col = coalesceMatch[1];
      const defaultVal = Number(coalesceMatch[2]);
      result[alias] = rows.length > 0 ? (rows[0][col] ?? defaultVal) : defaultVal;
      continue;
    }

    result[alias] = null;
  }
  return result;
}

export function createMockDatabase() {
  const tables = new Map<string, MockTable>();
  const schemas = new Map<string, ColumnDef[]>();
  const uniqueConstraints = new Map<string, UniqueConstraint[]>();

  function getTable(name: string): MockTable {
    let t = tables.get(name);
    if (!t) {
      t = { columns: [], rows: new Map(), autoIncrement: 0 };
      tables.set(name, t);
    }
    return t;
  }

  function exec(sql: string): void {
    const statements = splitSqlStatements(sql);
    for (const stmt of statements) {
      const createMatch = parseCreateTable(stmt);
      if (createMatch) {
        const table = getTable(createMatch.table);
        table.columns = createMatch.columns.map((c) => c.name);
        schemas.set(createMatch.table, createMatch.columns);
        if (createMatch.uniques.length > 0) {
          uniqueConstraints.set(createMatch.table, createMatch.uniques);
        }
        continue;
      }
      // CREATE INDEX, ALTER TABLE 等 — no-op for mock
    }
  }

  function prepare(sql: string): MockStatement {
    const trimmedSql = sql.trim();

    // INSERT
    const insertMatch = parseInsert(trimmedSql);
    if (insertMatch) {
      return {
        run: (...params: any[]) => {
          const table = getTable(insertMatch.table);
          const uniques = uniqueConstraints.get(insertMatch.table) || [];

          // Build the row with mixed literal and param values
          const row: Record<string, any> = {};
          let paramIdx = 0;
          for (let i = 0; i < insertMatch.columns.length; i++) {
            const col = insertMatch.columns[i];
            const token = insertMatch.valueTokens[i];
            if (token.type === 'param') {
              row[col] = params[paramIdx++];
            } else {
              row[col] = token.value;
            }
          }

          // Check ON CONFLICT target columns for upsert
          if (insertMatch.onConflict) {
            const targetCols = insertMatch.onConflict.targetColumns;
            for (const [existingId, existingRow] of table.rows) {
              let allMatch = true;
              for (const col of targetCols) {
                if (existingRow[col] !== row[col]) {
                  allMatch = false;
                  break;
                }
              }
              if (allMatch) {
                for (const assignment of insertMatch.onConflict.assignments) {
                  if (assignment.type === 'excluded' && assignment.excludedCol) {
                    existingRow[assignment.column] = row[assignment.excludedCol];
                  } else if (assignment.type === 'coalesce' && assignment.coalesceExcludedCol) {
                    const newVal = row[assignment.coalesceExcludedCol];
                    existingRow[assignment.column] = newVal != null ? newVal : existingRow[assignment.coalesceFallbackCol || assignment.column];
                  }
                }
                return { lastInsertRowid: existingId, changes: 1 };
              }
            }
          }

          // Check UNIQUE constraints
          for (const unique of uniques) {
            for (const [, existingRow] of table.rows) {
              let allMatch = true;
              for (const col of unique.columns) {
                if (existingRow[col] !== row[col]) {
                  allMatch = false;
                  break;
                }
              }
              if (allMatch) {
                throw new Error(`UNIQUE constraint failed: ${insertMatch.table}.${unique.columns.join(', ')}`);
              }
            }
          }

          // Auto-increment ID
          table.autoIncrement += 1;
          const id = table.autoIncrement;
          if (!('id' in row)) {
            row.id = id;
          }
          table.rows.set(id, row);
          return { lastInsertRowid: id, changes: 1 };
        },
        get: () => undefined,
        all: () => [],
      };
    }

    // SELECT
    const selectMatch = parseSelect(trimmedSql);
    if (selectMatch) {
      const table = getTable(selectMatch.table);
      return {
        run: () => ({ lastInsertRowid: 0, changes: 0 }),
        get: (...params: any[]) => {
          const whereConditions = parseWhereClause(selectMatch.whereClause || '');

          // Filter rows by WHERE (consuming WHERE params first)
          let results: any[] = [];
          for (const [, row] of table.rows) {
            const condIdx = { i: 0 };
            if (evaluateConditions(row, whereConditions, params, condIdx)) {
              if (selectMatch.isAggregate) {
                results.push(row);
              } else {
                results.push(transformRow(row, selectMatch.columnSpecs));
              }
            }
          }

          // Count WHERE params consumed
          const whereParamCount = whereConditions.filter((c) => c.type === 'param').length;
          let paramIdx = whereParamCount;

          // Apply ORDER BY
          if (selectMatch.orderBy.length > 0) {
            results.sort((a, b) => {
              for (const { column, direction } of selectMatch.orderBy) {
                const av = a[column] ?? a[snakeToCamel(column)];
                const bv = b[column] ?? b[snakeToCamel(column)];
                const result = typeof av === 'number' && typeof bv === 'number'
                  ? (direction === 'DESC' ? bv - av : av - bv)
                  : (direction === 'DESC'
                    ? String(bv).localeCompare(String(av))
                    : String(av).localeCompare(String(bv)));
                if (result !== 0) return result;
              }
              return 0;
            });
          }

          // Apply LIMIT (LIMIT param comes after WHERE params)
          if (selectMatch.limit) {
            let limit: number;
            if (selectMatch.limit.type === 'param') {
              limit = params[paramIdx++];
            } else {
              limit = selectMatch.limit.value!;
            }
            results = results.slice(0, limit);
          }

          if (selectMatch.isAggregate) {
            return executeAggregate(selectMatch.aggregateExprs, results);
          }

          return results[0];
        },
        all: (...params: any[]) => {
          const whereConditions = parseWhereClause(selectMatch.whereClause || '');

          let limit: number | undefined;
          let paramIdx = 0;

          if (selectMatch.limit) {
            // WHERE params come first, then LIMIT param
            // We don't know how many WHERE params there are yet, but we parse conditions first
          }

          // Filter rows
          let results: any[] = [];
          for (const [, row] of table.rows) {
            const condIdx = { i: 0 };
            if (evaluateConditions(row, whereConditions, params, condIdx)) {
              if (selectMatch.isAggregate) {
                results.push(row);
              } else {
                results.push(transformRow(row, selectMatch.columnSpecs));
              }
            }
          }

          // Count WHERE params consumed
          const whereParamCount = whereConditions.filter((c) => c.type === 'param').length;
          paramIdx = whereParamCount;

          // Apply ORDER BY
          if (selectMatch.orderBy.length > 0) {
            results.sort((a, b) => {
              for (const { column, direction } of selectMatch.orderBy) {
                const av = a[column] ?? a[snakeToCamel(column)];
                const bv = b[column] ?? b[snakeToCamel(column)];
                const result = typeof av === 'number' && typeof bv === 'number'
                  ? (direction === 'DESC' ? bv - av : av - bv)
                  : (direction === 'DESC'
                    ? String(bv).localeCompare(String(av))
                    : String(av).localeCompare(String(bv)));
                if (result !== 0) return result;
              }
              return 0;
            });
          }

          // Apply LIMIT
          if (selectMatch.limit) {
            if (selectMatch.limit.type === 'param') {
              limit = params[paramIdx++];
            } else {
              limit = selectMatch.limit.value;
            }
            if (limit !== undefined) {
              results = results.slice(0, limit);
            }
          }

          if (selectMatch.isAggregate) {
            return [executeAggregate(selectMatch.aggregateExprs, results)];
          }

          return results;
        },
      };
    }

    // UPDATE
    const updateMatch = parseUpdate(trimmedSql);
    if (updateMatch) {
      return {
        run: (...params: any[]) => {
          const table = getTable(updateMatch.table);
          let changes = 0;
          let paramIdx = 0;

          // Parse WHERE conditions to know how many params they consume
          const whereConditions = parseWhereClause(updateMatch.whereClause || '');

          for (const [, row] of table.rows) {
            // Evaluate WHERE first (params come in SQL order: SET params, then WHERE params)
            // Actually, in SQL, the parameter order is determined by the position of ? in the SQL string.
            // For UPDATE ... SET col1 = ?, col2 = ? WHERE col3 = ?
            // The params are: [set1, set2, where1]
            // For UPDATE ... SET col1 = col + 1, col2 = ? WHERE col3 = ?
            // The params are: [set2, where1]

            // We need to figure out how many SET params there are before WHERE params.
            // Let's count SET params first.
            const setParamCount = updateMatch.sets.filter(
              (s) => s.type === 'param' || (s.type === 'arithmetic' && s.arithValType === 'param'),
            ).length;

            // The params order is: SET params first, then WHERE params
            // But we need to evaluate WHERE for each row, so we need to know which params are for WHERE
            // Since we're iterating over rows, we need to reset paramIdx for each row's WHERE evaluation
            // Actually no - the params are the same for all rows. We just need to evaluate WHERE with the right params.

            // For WHERE evaluation, params start after SET params
            const whereStartIdx = setParamCount;
            const whereParamValues = params.slice(whereStartIdx);
            const condIdx = { i: 0 };
            const matches = evaluateConditions(row, whereConditions, whereParamValues, condIdx);

            if (matches) {
              // Apply SET expressions using SET params
              let setParamIdx = 0;
              for (const set of updateMatch.sets) {
                if (set.type === 'param') {
                  row[set.column] = params[setParamIdx++];
                } else if (set.type === 'literal') {
                  row[set.column] = set.value;
                } else if (set.type === 'arithmetic') {
                  const currentVal = Number(row[set.arithCol] || 0);
                  let addVal: number;
                  if (set.arithValType === 'param') {
                    addVal = Number(params[setParamIdx++]);
                  } else {
                    addVal = Number(set.arithVal);
                  }
                  if (set.arithOp === '+') {
                    row[set.column] = currentVal + addVal;
                  } else if (set.arithOp === '-') {
                    row[set.column] = currentVal - addVal;
                  }
                }
              }
              changes++;
            }
          }
          return { lastInsertRowid: 0, changes };
        },
        get: () => undefined,
        all: () => [],
      };
    }

    // DELETE
    const deleteMatch = parseDelete(trimmedSql);
    if (deleteMatch) {
      return {
        run: (...params: any[]) => {
          const table = getTable(deleteMatch.table);
          let changes = 0;
          const toDelete: number[] = [];
          const conditions = parseWhereClause(deleteMatch.whereClause || '');
          const paramIdx = { i: 0 };
          for (const [id, row] of table.rows) {
            const condIdx = { i: 0 };
            if (evaluateConditions(row, conditions, params, condIdx)) {
              toDelete.push(id);
              changes++;
            }
          }
          for (const id of toDelete) {
            table.rows.delete(id);
          }
          return { lastInsertRowid: 0, changes };
        },
        get: () => undefined,
        all: () => [],
      };
    }

    // Default: no-op statement
    return {
      run: () => ({ lastInsertRowid: 0, changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
  }

  return {
    exec,
    prepare,
    pragma: () => {},
    transaction: <T>(fn: () => T): T => fn(),
    close: () => {},
  };
}
