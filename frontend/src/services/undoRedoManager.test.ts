/**
 * Smoke tests for UndoRedoManager. These lock in the current behaviour so
 * future refactors don't accidentally break the (subtle) overflow logic
 * around `maxHistorySize`.
 */

import { UndoRedoManager } from './undoRedoManager';

const push = (mgr: UndoRedoManager, label: string) => {
  mgr.addState({ label }, label);
};

describe('UndoRedoManager', () => {
  it('starts empty and refuses to undo or redo', () => {
    const mgr = new UndoRedoManager();
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
    expect(mgr.undo()).toBeNull();
    expect(mgr.redo()).toBeNull();
  });

  it('returns the previous state on undo and the next on redo', () => {
    const mgr = new UndoRedoManager();
    push(mgr, 'A');
    push(mgr, 'B');
    push(mgr, 'C');

    const undone = mgr.undo();
    expect(undone?.scheduleData).toEqual({ label: 'B' });

    const redone = mgr.redo();
    expect(redone?.scheduleData).toEqual({ label: 'C' });
  });

  it('clears the redo stack when a new state is pushed', () => {
    const mgr = new UndoRedoManager();
    push(mgr, 'A');
    push(mgr, 'B');
    push(mgr, 'C');
    mgr.undo(); // back to B
    push(mgr, 'D'); // should drop C

    expect(mgr.canRedo()).toBe(false);
    expect(mgr.getCurrentState()?.scheduleData).toEqual({ label: 'D' });
  });

  it('caps history at maxHistorySize and keeps the index pointing at the latest state', () => {
    const mgr = new UndoRedoManager();
    // default maxHistorySize is 50; push 60 states.
    for (let i = 0; i < 60; i++) push(mgr, `S${i}`);

    expect(mgr.getCurrentState()?.scheduleData).toEqual({ label: 'S59' });

    // Undo all the way back — we should still get back exactly maxHistorySize-1 states.
    let undoCount = 0;
    while (mgr.canUndo()) {
      mgr.undo();
      undoCount++;
    }
    expect(undoCount).toBe(49);
    // Earliest retained state should be S10, not S0.
    expect(mgr.getCurrentState()?.scheduleData).toEqual({ label: 'S10' });
  });

  it('clear() resets history fully', () => {
    const mgr = new UndoRedoManager();
    push(mgr, 'A');
    push(mgr, 'B');
    mgr.clear();
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
    expect(mgr.getCurrentState()).toBeNull();
  });
});
