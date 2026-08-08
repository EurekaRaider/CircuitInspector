import type { TableFormat, TableImportResult, TableKind, TableRowError } from "@circuit-inspector/contracts";

const headers: Record<TableKind, string[]> = {
  PINOUT: ["connector", "pin", "net_name"],
  DESIGN_METRIC: ["id", "value", "unit"],
  CONNECTOR_MAPPING: ["product_connector", "wib_connector", "product_pin", "wib_pin"],
  NET_ALIAS: ["product_net", "wib_net"],
  CONSTRAINT: ["id", "area", "requirement", "check", "metric_id", "comparator", "required_value", "required_min", "required_max", "unit", "verification_mode", "source_authority"]
};

export function parseTable(kind: TableKind, text: string, format: TableFormat): TableImportResult {
  let rows: Array<Record<string, unknown>>;
  try {
    if (format === "JSON") {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || parsed.schema_version !== 1 || parsed.kind !== kind || !Array.isArray(parsed.rows)) {
        throw new Error(`JSON must contain schema_version 1, kind ${kind}, and a rows array`);
      }
      const candidate = parsed.rows;
      rows = candidate.map((row) => isRecord(row) ? row : {});
    } else {
      rows = parseCsv(text);
    }
  } catch (error) {
    return { schema_version: 1, kind, rows: [], errors: [{ row: 0, field: null, message: String(error) }] };
  }
  const normalized = rows.map((row) => normalizeRow(kind, row));
  return { schema_version: 1, kind, rows: normalized, errors: validateRows(kind, normalized) };
}

export function serializeTable(kind: TableKind, rows: Array<Record<string, unknown>>, format: TableFormat): string {
  const normalized = rows.map((row) => normalizeRow(kind, row));
  if (format === "JSON") return `${JSON.stringify({ schema_version: 1, kind, rows: normalized }, null, 2)}\n`;
  const keys = headers[kind];
  const body = normalized.map((row) => keys.map((key) => csvCell(csvValue(kind, row, key))).join(",")).join("\n");
  return `${keys.map(csvCell).join(",")}\n${body}${body ? "\n" : ""}`;
}

function parseCsv(text: string): Array<Record<string, unknown>> {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(field.trim());
      field = "";
    } else if (character === "\n") {
      record.push(field.trim());
      if (record.some(Boolean)) records.push(record);
      record = [];
      field = "";
    } else if (character !== "\r") field += character;
  }
  record.push(field.trim());
  if (record.some(Boolean)) records.push(record);
  if (!records.length) return [];
  const names = records[0]!.map((value) => value.trim());
  if (!names.every(Boolean)) throw new Error("CSV header contains an empty column name");
  return records.slice(1).map((values) => Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""])));
}

function normalizeRow(kind: TableKind, row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of headers[kind]) result[key] = typeof row[key] === "string" ? row[key].trim() : row[key] ?? "";
  if (kind === "DESIGN_METRIC" && typeof result.value === "string" && result.value !== "" && Number.isFinite(Number(result.value))) result.value = Number(result.value);
  if (kind === "CONSTRAINT") {
    if (result.comparator === "RANGE") {
      const existing = row.required_value;
      if (isRecord(existing) && Number.isFinite(existing.min) && Number.isFinite(existing.max)) {
        result.required_value = { min: Number(existing.min), max: Number(existing.max) };
      } else {
        const min = Number(result.required_min);
        const max = Number(result.required_max);
        if (Number.isFinite(min) && Number.isFinite(max)) result.required_value = { min, max };
      }
    } else if (typeof result.required_value === "string" && result.required_value !== "" && Number.isFinite(Number(result.required_value))) {
      result.required_value = Number(result.required_value);
    }
  }
  return result;
}

function validateRows(kind: TableKind, rows: Array<Record<string, unknown>>): TableRowError[] {
  const errors: TableRowError[] = [];
  const duplicates = new Map<string, number>();
  rows.forEach((row, index) => {
    const line = index + 2;
    const required = kind === "PINOUT" ? ["connector", "pin", "net_name"]
      : kind === "DESIGN_METRIC" ? ["id", "value", "unit"]
        : kind === "CONNECTOR_MAPPING" ? ["product_connector", "wib_connector"]
          : kind === "NET_ALIAS" ? ["product_net", "wib_net"]
            : ["id", "area", "requirement", "check", "comparator", "required_value", "verification_mode", "source_authority"];
    for (const name of required) {
      if (row[name] === "" || row[name] == null) errors.push({ row: line, field: name, message: `${name} is required` });
    }
    if (kind === "CONNECTOR_MAPPING" && Boolean(row.product_pin) !== Boolean(row.wib_pin)) {
      errors.push({ row: line, field: "product_pin", message: "product_pin and wib_pin must both be present or both be empty" });
    }
    if (kind === "CONSTRAINT") {
      if (row.check === "DESIGN_METRIC" && !row.metric_id) errors.push({ row: line, field: "metric_id", message: "metric_id is required for DESIGN_METRIC" });
      if (row.check === "DESIGN_METRIC" && !row.unit) errors.push({ row: line, field: "unit", message: "unit is required for DESIGN_METRIC" });
      if (row.comparator === "RANGE") {
        const range = row.required_value;
        if (!isRecord(range) || !Number.isFinite(range.min) || !Number.isFinite(range.max) || Number(range.min) > Number(range.max)) {
          errors.push({ row: line, field: "required_value", message: "RANGE requires finite required_min and required_max values" });
        }
      }
    }
    const duplicateKey = kind === "PINOUT" ? `${row.connector}\u0000${row.pin}`
      : kind === "CONSTRAINT" || kind === "DESIGN_METRIC" ? String(row.id)
        : kind === "NET_ALIAS" ? String(row.product_net)
          : kind === "CONNECTOR_MAPPING" ? `${row.product_connector}\u0000${row.wib_connector}\u0000${row.product_pin}\u0000${row.wib_pin}`
            : "";
    if (duplicateKey) {
      const normalized = duplicateKey.toLocaleUpperCase("en-US");
      const previous = duplicates.get(normalized);
      if (previous != null) errors.push({ row: line, field: null, message: `Duplicate row; first declared on row ${previous}` });
      else duplicates.set(normalized, line);
    }
    if (kind === "NET_ALIAS") {
      const targetKey = `target\u0000${String(row.wib_net).toLocaleUpperCase("en-US")}`;
      const previous = duplicates.get(targetKey);
      if (previous != null) errors.push({ row: line, field: "wib_net", message: `Duplicate alias target; first declared on row ${previous}` });
      else duplicates.set(targetKey, line);
    }
  });
  return errors;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvValue(kind: TableKind, row: Record<string, unknown>, key: string): unknown {
  if (kind !== "CONSTRAINT" || !isRecord(row.required_value)) return row[key];
  if (key === "required_value") return "";
  if (key === "required_min") return row.required_value.min;
  if (key === "required_max") return row.required_value.max;
  return row[key];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
