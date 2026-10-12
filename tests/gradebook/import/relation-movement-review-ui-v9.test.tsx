import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GradebookRelationMovementReviewV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { RelationMovementReviewV9 } from '../../../src/features/gradebook/import/relation-movement-review-v9';

const review: GradebookRelationMovementReviewV9 = {
  digest: 'a'.repeat(64),
  groups: [
    {
      origins: [
        { classCode: '7A', number: 1, name: 'LÍVIA SINTÉTICA' },
        { classCode: '7A', number: 2, name: 'MAÍRA SINTÉTICA' },
      ],
      destinations: [
        { classCode: '7B', number: 11, name: 'LÍVIA CORRIGIDA' },
        { classCode: '7B', number: 12, name: 'MAÍRA CORRIGIDA' },
      ],
    },
  ],
};
const key = (number: number) => JSON.stringify(['7B', number]);
const destination = (name: string) =>
  screen.getByRole('combobox', { name: new RegExp(`Destino para ${name}`, 'u') });
const confirm = () => screen.getByRole('button', { name: 'Confirmar pares e aplicar Relação' });

afterEach(cleanup);

describe('interface de conferência explícita de movimentações V9', () => {
  it('shows original names and positions, starts empty, and requires every unique pair', () => {
    const onConfirm = vi.fn();
    render(
      <RelationMovementReviewV9
        review={review}
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('LÍVIA SINTÉTICA')).toBeTruthy();
    expect(screen.getByText('FOI PARA · 7A · nº 1')).toBeTruthy();
    expect(screen.getAllByRole('option', { name: 'LÍVIA CORRIGIDA · 7B · nº 11' })).toHaveLength(2);
    expect(destination('LÍVIA')).toHaveProperty('value', '');
    expect(destination('MAÍRA')).toHaveProperty('value', '');
    expect(confirm()).toHaveProperty('disabled', true);
    fireEvent.change(destination('LÍVIA'), { target: { value: key(11) } });
    expect(confirm()).toHaveProperty('disabled', true);
    fireEvent.change(destination('MAÍRA'), { target: { value: key(11) } });
    expect(confirm()).toHaveProperty('disabled', true);
    fireEvent.change(destination('MAÍRA'), { target: { value: key(12) } });
    expect(screen.getAllByText('LÍVIA CORRIGIDA · 7B · nº 11', { selector: 'span' })).toHaveLength(
      1,
    );
    expect(screen.getByText('MAÍRA CORRIGIDA · 7B · nº 12', { selector: 'span' })).toBeTruthy();
    expect(confirm()).toHaveProperty('disabled', false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
      digest: review.digest,
      pairs: [
        { origin: { classCode: '7A', number: 1 }, destination: { classCode: '7B', number: 11 } },
        { origin: { classCode: '7A', number: 2 }, destination: { classCode: '7B', number: 12 } },
      ],
    });
  });

  it('says why a group with more exits than entries cannot be confirmed', () => {
    const unbalanced: GradebookRelationMovementReviewV9 = {
      digest: review.digest,
      groups: [{ ...review.groups[0]!, destinations: [review.groups[0]!.destinations[0]!] }],
    };
    render(
      <RelationMovementReviewV9
        review={unbalanced}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'Saídas e entradas em quantidade diferente. Corrija a Relação e reenvie.',
    );
    fireEvent.change(destination('LÍVIA'), { target: { value: key(11) } });
    expect(confirm()).toHaveProperty('disabled', true);
    cleanup();
    render(
      <RelationMovementReviewV9
        review={review}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels without confirming and a new preview starts with no retained choices', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <RelationMovementReviewV9
        key="first"
        review={review}
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.change(destination('LÍVIA'), { target: { value: key(11) } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar conferência' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(
      <RelationMovementReviewV9
        key="fresh"
        review={{ ...review, digest: 'b'.repeat(64) }}
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(destination('LÍVIA')).toHaveProperty('value', '');
    expect(confirm()).toHaveProperty('disabled', true);
  });

  it('prevents interaction while the confirmed request is in flight', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <RelationMovementReviewV9 review={review} busy onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(confirm()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancelar conferência' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(destination('LÍVIA').closest('fieldset')).toHaveProperty('disabled', true);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('preserves long synthetic names in the transfer review without truncating the explicit choice', () => {
    const longOrigin = 'O'.repeat(300);
    const longDestination = 'D'.repeat(300);
    const selectedDestinationLabel = `${longDestination} · 9B · nº 2`;
    render(
      <RelationMovementReviewV9
        review={{
          digest: 'c'.repeat(64),
          groups: [
            {
              origins: [{ classCode: '9A', number: 1, name: longOrigin }],
              destinations: [{ classCode: '9B', number: 2, name: longDestination }],
            },
          ],
        }}
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(longOrigin)).toBeTruthy();
    const destinationChoice = screen.getByRole('combobox', {
      name: new RegExp(`Destino para ${longOrigin}`, 'u'),
    });
    expect(screen.queryByText(selectedDestinationLabel, { selector: 'span' })).toBeNull();
    fireEvent.change(destinationChoice, { target: { value: JSON.stringify(['9B', 2]) } });
    expect(screen.getByRole('option', { name: selectedDestinationLabel })).toBeTruthy();
    expect(screen.getByText(selectedDestinationLabel, { selector: 'span' }).textContent).toBe(
      selectedDestinationLabel,
    );
    expect(confirm()).toHaveProperty('disabled', false);
    fireEvent.change(destinationChoice, { target: { value: '' } });
    expect(screen.queryByText(selectedDestinationLabel, { selector: 'span' })).toBeNull();
    expect(confirm()).toHaveProperty('disabled', true);
  });
});
