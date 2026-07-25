export function containsDigit(text: string): boolean {
  return /\d/.test(text.normalize("NFKC"));
}

export function extractMatchingCodes(text: string, productCodes: string[]): string[] {
  const digitRuns = text.normalize("NFKC").match(/\d+/g) ?? [];
  return productCodes.filter((code) => digitRuns.some((run) => run.includes(code)));
}
