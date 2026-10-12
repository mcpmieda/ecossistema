import { useState } from 'react';
import { Alert, Button } from '@heroui/react';
import type {
  GradebookRelationMovementConfirmationV9,
  GradebookRelationMovementPositionV9,
  GradebookRelationMovementReviewV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';

function positionKey(position: GradebookRelationMovementPositionV9): string {
  return JSON.stringify([position.classCode, position.number]);
}

export function RelationMovementReviewV9({
  review,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly review: GradebookRelationMovementReviewV9;
  readonly busy: boolean;
  readonly onConfirm: (confirmation: GradebookRelationMovementConfirmationV9) => void;
  readonly onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const pairs = review.groups.flatMap((group) =>
    group.origins.flatMap((origin) => {
      const destination = group.destinations.find(
        (item) => positionKey(item) === selected[positionKey(origin)],
      );
      return destination
        ? [
            {
              origin: { classCode: origin.classCode, number: origin.number },
              destination: { classCode: destination.classCode, number: destination.number },
            },
          ]
        : [];
    }),
  );
  const complete =
    review.groups.length > 0 &&
    review.groups.every((group) => {
      const choices = group.origins.map((origin) => selected[positionKey(origin)]);
      return (
        group.origins.length === group.destinations.length &&
        choices.every((key) => group.destinations.some((item) => positionKey(item) === key)) &&
        new Set(choices).size === group.destinations.length
      );
    });

  return (
    <section aria-label="Conferência de movimentações" className="mt-5 space-y-4">
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Confira os pares de movimentação</Alert.Title>
          <Alert.Description>
            Escolha o destino de cada saída. A Relação inteira será aplicada após a confirmação.
          </Alert.Description>
        </Alert.Content>
      </Alert>
      {review.groups.map((group) => (
        <fieldset
          key={group.origins.map(positionKey).join('|')}
          disabled={busy}
          className="space-y-3 rounded-xl border border-default p-3"
        >
          <legend className="px-1 text-sm font-semibold">
            {group.origins[0]?.classCode} → {group.destinations[0]?.classCode}
          </legend>
          {group.origins.length === group.destinations.length ? null : (
            <p role="alert" className="text-sm">
              Saídas e entradas em quantidade diferente. Corrija a Relação e reenvie.
            </p>
          )}
          {group.origins.map((origin) => {
            const originKey = positionKey(origin);
            const taken = new Set(
              group.origins
                .filter((item) => positionKey(item) !== originKey)
                .map((item) => selected[positionKey(item)]),
            );
            return (
              <div key={originKey} className="grid gap-2 sm:grid-cols-2 sm:items-center">
                <div className="min-w-0 text-sm">
                  <p className="text-muted">
                    FOI PARA · {origin.classCode} · nº {origin.number}
                  </p>
                  <strong className="break-words">{origin.name}</strong>
                </div>
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                  <span>ESTAVA NO</span>
                  <select
                    aria-label={`Destino para ${origin.name}, ${origin.classCode} nº ${origin.number}`}
                    className="w-full rounded-lg border border-default bg-surface p-2"
                    value={selected[originKey] ?? ''}
                    onChange={(event) =>
                      setSelected((current) => ({
                        ...current,
                        [originKey]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Escolha o destino</option>
                    {group.destinations.map((destination) => (
                      <option
                        key={positionKey(destination)}
                        value={positionKey(destination)}
                        disabled={taken.has(positionKey(destination))}
                      >
                        {destination.name} · {destination.classCode} · nº {destination.number}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          isDisabled={busy || !complete}
          onPress={() => onConfirm({ digest: review.digest, pairs })}
        >
          Confirmar pares e aplicar Relação
        </Button>
        <Button variant="secondary" isDisabled={busy} onPress={onCancel}>
          Cancelar conferência
        </Button>
      </div>
    </section>
  );
}
