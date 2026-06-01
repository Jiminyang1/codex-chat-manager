import os from "node:os";

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

type Align = "left" | "right";
export type TableColumn = {
  key: string;
  label: string;
  width?: number;
  min?: number;
  align?: Align;
};
type TableRow = Record<string, any>;

function shouldColor() {
  return process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR);
}

function color(code: string, value: unknown): string {
  return shouldColor() ? `${code}${value}${COLOR.reset}` : String(value);
}

function stripAnsi(value: unknown): string {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function compactPath(value: unknown): string {
  if (!value) return "";
  const home = os.homedir();
  return String(value).replace(home, "~");
}

function shortId(value: unknown, length = 18): string {
  if (!value) return "";
  return String(value).slice(0, length);
}

function twoDigits(value: unknown): string {
  return String(value).padStart(2, "0");
}

function formatDateObject(date: Date): string {
  if (Number.isNaN(date.getTime())) return "-";
  return [
    date.getFullYear(),
    "-",
    twoDigits(date.getMonth() + 1),
    "-",
    twoDigits(date.getDate()),
    " ",
    twoDigits(date.getHours()),
    ":",
    twoDigits(date.getMinutes())
  ].join("");
}

function formatDate(seconds: unknown): string {
  if (!seconds) return "-";
  return formatDateObject(new Date(Number(seconds) * 1000));
}

function formatIsoDate(value: unknown): string {
  if (!value) return "-";
  return formatDateObject(new Date(String(value)));
}

function truncate(value: unknown, width: number): string {
  const text = String(value ?? "");
  if (stripAnsi(text).length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, Math.max(0, width - 1))}.`;
}

function pad(value: unknown, width: number, align: Align = "left"): string {
  const text = String(value ?? "");
  const size = stripAnsi(text).length;
  if (size >= width) return text;
  const spaces = " ".repeat(width - size);
  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

function printTitle(title: string): void {
  console.log(color(COLOR.bold, title));
  console.log(color(COLOR.gray, "-".repeat(Math.max(16, stripAnsi(title).length))));
}

function printKeyValues(rows: Array<[string, unknown]>): void {
  const width = Math.max(...rows.map(([key]) => stripAnsi(key).length), 0);
  for (const [key, value] of rows) {
    console.log(`${color(COLOR.gray, pad(key, width))}  ${value}`);
  }
}

function printTable(columns: TableColumn[], rows: TableRow[], { empty = "No rows." }: { empty?: string } = {}): void {
  if (!rows.length) {
    console.log(color(COLOR.gray, empty));
    return;
  }
  const widths = columns.map((column) => {
    const values = rows.map((row) => truncate(row[column.key], column.width ?? 30));
    const max = Math.max(stripAnsi(column.label).length, ...values.map((value) => stripAnsi(value).length));
    return Math.min(column.width ?? max, Math.max(max, column.min ?? 0));
  });
  console.log(columns.map((column, index) => color(COLOR.bold, pad(truncate(column.label, widths[index]), widths[index], column.align))).join("  "));
  console.log(columns.map((_, index) => color(COLOR.gray, "-".repeat(widths[index]))).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => pad(truncate(row[column.key], widths[index]), widths[index], column.align)).join("  "));
  }
}

function printNext(command: string): void {
  console.log("");
  console.log(`${color(COLOR.gray, "Next")}  ${command}`);
}

export {
  COLOR,
  color,
  compactPath,
  formatDate,
  formatIsoDate,
  printKeyValues,
  printNext,
  printTable,
  printTitle,
  shellQuote,
  shortId
};
