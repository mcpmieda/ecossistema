import { useState } from 'react';
import { AlertDialog, Button } from '@heroui/react';

/**
 * "Excluir aluno lançado por engano": shown only for a student with no data anywhere (the server
 * checks it again, and the Portal account, before removing).
 */
export function RemoveStudentV1({
  name,
  disabled,
  onConfirm,
}: Readonly<{ name: string; disabled: boolean; onConfirm: () => void }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="danger" isDisabled={disabled} onPress={() => setOpen(true)}>
        Excluir aluno lançado por engano
      </Button>
      <AlertDialog.Backdrop isOpen={open} isDismissable={false} onOpenChange={setOpen}>
        <AlertDialog.Container size="md" placement="center">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>Excluir aluno lançado por engano</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="break-words font-medium">{name}</p>
              <p>
                Apaga o aluno, a posição na turma e a conta do Portal nunca usada. Não pode ser
                desfeito.
              </p>
              <p>Se a linha continuar na Relação, o aluno volta na próxima leitura.</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus variant="secondary" onPress={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                isDisabled={disabled}
                onPress={() => {
                  setOpen(false);
                  onConfirm();
                }}
              >
                Excluir
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
