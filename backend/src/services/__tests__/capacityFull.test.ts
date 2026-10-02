import { capacityFull } from '../SchedulingEngine';

const slot = (from: string, to: string) => ({
  capacityStart: new Date(`2026-10-05T${from}:00`), capacityEnd: new Date(`2026-10-05T${to}:00`),
}) as any;
const win = (from: string, to: string): [Date, Date] => [new Date(`2026-10-05T${from}:00`), new Date(`2026-10-05T${to}:00`)];

describe('capacityFull', () => {
  it('capacity 1: any overlap blocks (unchanged)', () => {
    expect(capacityFull([slot('08:00', '09:00')], ...win('08:30', '10:00'), 1)).toBe(true);
    expect(capacityFull([], ...win('08:30', '10:00'), 1)).toBe(false);
  });

  it('capacity 2: two back-to-back jobs leave room for a third', () => {
    const booked = [slot('08:00', '10:00'), slot('10:00', '12:00')];
    expect(capacityFull(booked, ...win('09:00', '11:00'), 2)).toBe(false);
  });

  it('capacity 2: two jobs running together fill it', () => {
    const booked = [slot('08:00', '12:00'), slot('09:00', '11:00')];
    expect(capacityFull(booked, ...win('10:00', '13:00'), 2)).toBe(true);
  });

  it('only counts overlap inside the window', () => {
    const booked = [slot('08:00', '09:00'), slot('08:30', '09:30')]; // both together 08:30–09:00 only
    expect(capacityFull(booked, ...win('09:00', '10:00'), 2)).toBe(false);
  });
});
