/*
 * The preview's clock (owner request 01/11/2026: "próxima terça às 14:00"): the whole page lives at
 * this moment in Brasília and runs from it. Another moment by the address:
 * ?data=2026-11-10&hora=08:00. Only the preview imports this file, first of all, before any page
 * reads the date.
 */
const params = new URLSearchParams(window.location.search);
const date = /^\d{4}-\d{2}-\d{2}$/u.test(params.get('data') ?? '') ? params.get('data') : '2026-11-03';
const time = /^([01]\d|2[0-3]):[0-5]\d$/u.test(params.get('hora') ?? '') ? params.get('hora') : '14:00';

const RealDate = Date;
const offset = RealDate.parse(`${date}T${time}:00-03:00`) - RealDate.now();

class PreviewDate extends RealDate {
  constructor(...args: [] | ConstructorParameters<typeof Date>) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [number]));
  }
  static override now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = PreviewDate as DateConstructor;
