/** Quote cells and keep untrusted text from becoming a spreadsheet formula. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[\u0000-\u0020\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
