/**
 * A picker screen a parser could not read. Discovery records it as a failed read: a screen that
 * shows no models never becomes an empty list.
 */
export class PickerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PickerParseError';
  }
}
