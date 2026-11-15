import type { GradebookSheetStudentNameV9 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { BatchSuccess } from './import-batch';

/**
 * The students' names as the teacher's workbook has them, by class and number, from the term
 * sheets: what rule 14 (BN-DEC-046, "aluno trocado") compares with the Relação. Used by the
 * OneDrive reading and sent with the manual import (#1477).
 */
export function gradebookSheetStudentNamesV1(success: BatchSuccess): GradebookSheetStudentNameV9[] {
  const names = new Map<string, GradebookSheetStudentNameV9>();
  for (const sheet of success.summary.gradeSheets) {
    if (!sheet.stage.startsWith('trimester-')) continue;
    const classCode = sheet.className.trim().slice(0, 32);
    if (!classCode) continue;
    for (const student of sheet.students) {
      const number = Number(student.number.trim());
      const name = student.name.trim().slice(0, 240);
      if (Number.isSafeInteger(number) && number > 0 && name)
        names.set(`${classCode.toUpperCase()}|${number}`, [classCode, number, name]);
    }
  }
  return [...names.values()];
}
