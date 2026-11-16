import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

type OpenSslRunner = (file: string, args: string[], options: { encoding: 'utf8' }) => string;

export type CertificateValidity = {
  startDateTime: string;
  endDateTime: string;
};

export function parseCertificateValidity(output: string): CertificateValidity {
  const values = new Map(
    output
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        if (index <= 0) return ['', ''] as const;
        return [line.slice(0, index), line.slice(index + 1)] as const;
      }),
  );
  const notBefore = values.get('notBefore') ?? '';
  const notAfter = values.get('notAfter') ?? '';
  const start = new Date(notBefore);
  const end = new Date(notAfter);
  if (
    !notBefore ||
    !notAfter ||
    Number.isNaN(start.valueOf()) ||
    Number.isNaN(end.valueOf()) ||
    end.valueOf() <= start.valueOf()
  ) {
    throw new Error('Invalid certificate validity');
  }
  return {
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
  };
}

export function readCertificateValidity(
  runner: OpenSslRunner = execFileSync as OpenSslRunner,
): CertificateValidity {
  const runnerTemp = process.env.RUNNER_TEMP?.trim();
  if (!runnerTemp) throw new Error('Missing runner temp');
  const certificatePath = join(runnerTemp, 'maintenance-rotation', 'cert.pem');
  const output = runner(
    'openssl',
    ['x509', '-in', certificatePath, '-noout', '-startdate', '-enddate'],
    { encoding: 'utf8' },
  );
  return parseCertificateValidity(output);
}

function main(): void {
  process.stdout.write(`${JSON.stringify(readCertificateValidity())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    console.error('Certificate validity extraction failed');
    process.exitCode = 1;
  }
}
