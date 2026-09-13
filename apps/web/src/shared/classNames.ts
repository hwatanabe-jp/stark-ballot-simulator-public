export function joinClassNames(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
