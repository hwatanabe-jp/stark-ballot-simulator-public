/** Non-null object admission excluding arrays; prototypes are unrestricted.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isNonArrayObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
