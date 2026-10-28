import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/csv';

describe('CSV log export', () => {
  it('keeps commas, quotes and multiline content in a single quoted cell', () => {
    expect(csvCell('模型,"test"\r\n第二行')).toBe('"模型,""test""\r\n第二行"');
  });

  it.each(['=1+1', '+SUM(1,2)', '-1+2', '@SUM(1,2)', ' \t=1+1', '\uFEFF=1+1'])(
    'exports formula-like text as literal data: %s', (value) => {
      expect(csvCell(value)).toBe('"\'' + value + '"');
    },
  );

  it('preserves numeric values and ordinary model IDs', () => {
    expect(csvCell(-0.5)).toBe('"-0.5"');
    expect(csvCell('gpt-4.1')).toBe('"gpt-4.1"');
    expect(csvCell('')).toBe('""');
  });
});
