/** A path with `/` separators, no leading `./` and no trailing `/`, so one file compares equal however it was spelled. */
export const cleanPath = (path: string): string => path.replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/$/, '');
