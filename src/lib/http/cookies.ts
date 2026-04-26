/**
 * Return a cookie value by name from a Cookie header string.
 */
export function getCookieValue(cookieString: string, name: string): string | null {
  if (!cookieString) {
    return null;
  }
  const entries = cookieString
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.startsWith(`${name}=`)) {
      return entry.slice(name.length + 1);
    }
  }
  return null;
}
