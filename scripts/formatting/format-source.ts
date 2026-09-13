import { format } from 'oxfmt';
import configuration from '../../oxfmt.config';

/** Format generated repository text with the same policy as the CLI. */
export async function formatSource(filePath: string, text: string): Promise<string> {
  const result = await format(filePath, text, configuration);
  if (result.errors.length > 0) {
    throw new Error(`Cannot format ${filePath}: ${result.errors.map((error) => error.message).join('; ')}`);
  }
  return result.code;
}
