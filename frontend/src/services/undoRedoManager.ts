/**
 * Undo/Redo functionality manager
 */

export interface ScheduleState {
  timestamp: Date;
  scheduleData: any;
  description: string;
}

export class UndoRedoManager {
  private history: ScheduleState[] = [];
  private currentIndex = -1;
  private maxHistorySize = 50;

  addState(scheduleData: any, description: string): void {
    // Remove any redo states
    this.history = this.history.slice(0, this.currentIndex + 1);

    // Add new state
    this.history.push({
      timestamp: new Date(),
      scheduleData,
      description
    });

    // Limit history size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    } else {
      this.currentIndex++;
    }
  }

  undo(): ScheduleState | null {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.history[this.currentIndex];
    }
    return null;
  }

  redo(): ScheduleState | null {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      return this.history[this.currentIndex];
    }
    return null;
  }

  canUndo(): boolean {
    return this.currentIndex > 0;
  }

  canRedo(): boolean {
    return this.currentIndex < this.history.length - 1;
  }

  getHistory(): ScheduleState[] {
    return this.history.map((state, index) => ({
      ...state,
      isCurrent: index === this.currentIndex
    })) as any;
  }

  clear(): void {
    this.history = [];
    this.currentIndex = -1;
  }

  getCurrentState(): ScheduleState | null {
    return this.currentIndex >= 0 ? this.history[this.currentIndex] : null;
  }
}

export const createUndoRedoManager = () => new UndoRedoManager();
