import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import DialogHost, { confirmDialog, promptDialog } from '../components/DialogHost';

describe('DialogHost', () => {
  it('confirm resolves true on the confirm button and false on Escape', async () => {
    render(<DialogHost />);
    let p!: Promise<boolean>;
    act(() => { p = confirmDialog({ title: 'Delete', message: 'Delete it?', confirmLabel: 'Delete', danger: true }); });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(p).resolves.toBe(true);

    let q!: Promise<boolean>;
    act(() => { q = confirmDialog('Sure?'); });
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    await expect(q).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('prompt returns the typed text, or null when cancelled', async () => {
    render(<DialogHost />);
    let p!: Promise<string | null>;
    act(() => { p = promptDialog({ message: 'Name:', defaultValue: 'Plan A', confirmLabel: 'Create' }); });
    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue('Plan A');
    fireEvent.change(input, { target: { value: 'Plan B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await expect(p).resolves.toBe('Plan B');

    let q!: Promise<string | null>;
    act(() => { q = promptDialog('Name:'); });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(q).resolves.toBeNull();
  });

  it('shows queued dialogs one at a time', async () => {
    render(<DialogHost />);
    let a!: Promise<boolean>, b!: Promise<boolean>;
    act(() => { a = confirmDialog('First?'); b = confirmDialog('Second?'); });
    expect(await screen.findByText('First?')).toBeInTheDocument();
    expect(screen.queryByText('Second?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Second?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
  });
});
