import { toCsv } from './csvExport';

describe('toCsv', () => {
  it('quotes separators and quotes, neutralises formulas', () => {
    const csv = toCsv(['Job', 'Desc', 'Qty'], [['J1', 'Paste, "smooth"', 5], ['J2', '=SUM(A1)', null]]);
    expect(csv).toBe('Job,Desc,Qty\r\nJ1,"Paste, ""smooth""",5\r\nJ2,\'=SUM(A1),');
  });

  it('keeps zero-padded SYSPRO keys as text', () => {
    expect(toCsv(['Job'], [['000000000038413'], [42]])).toBe('Job\r\n"=""000000000038413"""\r\n42');
  });
});
