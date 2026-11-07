type CookieOptions = {
  maxAge?: number;
  sameSite?: 'Lax' | 'Strict';
};

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const item of header.split(';')) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return null;
}

export function secureCookie(name: string, value: string, options: CookieOptions = {}): string {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  return attributes.join('; ');
}

export function clearCookie(name: string): string {
  return secureCookie(name, '', { maxAge: 0 });
}
