/**
 * Keyboard shortcuts configuration
 */

export interface KeyboardShortcut {
  action: string;
  keys: string;
  description: string;
  handler: () => void;
}

export class KeyboardShortcutManager {
  private shortcuts: Map<string, KeyboardShortcut> = new Map();

  register(shortcut: KeyboardShortcut): void {
    this.shortcuts.set(shortcut.keys, shortcut);
  }

  unregister(keys: string): void {
    this.shortcuts.delete(keys);
  }

  getShortcuts(): KeyboardShortcut[] {
    return Array.from(this.shortcuts.values());
  }

  handleKeyDown(event: KeyboardEvent): void {
    const keys = this.getKeysPressed(event);
    const shortcut = this.shortcuts.get(keys);

    if (shortcut) {
      event.preventDefault();
      shortcut.handler();
    }
  }

  private getKeysPressed(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.shiftKey) parts.push('Shift');
    if (event.altKey) parts.push('Alt');

    const key = event.key.toUpperCase();
    if (
      key !== 'CONTROL' &&
      key !== 'SHIFT' &&
      key !== 'ALT' &&
      key !== 'META'
    ) {
      parts.push(key);
    }

    return parts.join('+');
  }
}

// Default shortcuts
export const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  {
    action: 'Generate Schedule',
    keys: 'Ctrl+Enter',
    description: 'Generate new schedule',
    handler: () => console.log('Generate schedule shortcut triggered')
  },
  {
    action: 'Export Schedule',
    keys: 'Ctrl+Shift+E',
    description: 'Export current schedule',
    handler: () => console.log('Export schedule shortcut triggered')
  },
  {
    action: 'Undo',
    keys: 'Ctrl+Z',
    description: 'Undo last change',
    handler: () => console.log('Undo shortcut triggered')
  },
  {
    action: 'Redo',
    keys: 'Ctrl+Shift+Z',
    description: 'Redo last undone change',
    handler: () => console.log('Redo shortcut triggered')
  },
  {
    action: 'Show Help',
    keys: '?',
    description: 'Show keyboard shortcuts',
    handler: () => console.log('Show help shortcut triggered')
  }
];

export const createShortcutManager = () => new KeyboardShortcutManager();
