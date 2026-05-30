export function cjkRatio(value: string): number {
  let cjk = 0;
  let counted = 0;

  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || shouldIgnoreForLanguageRatio(codePoint)) {
      continue;
    }

    counted += 1;
    if (isCjkCodePoint(codePoint)) {
      cjk += 1;
    }
  }

  return counted === 0 ? 0 : cjk / counted;
}

export function isProbablyCjk(value: string, threshold = 0.3): boolean {
  return cjkRatio(value) >= threshold;
}

export function shouldSkipForTargetLanguage(value: string, targetLanguage: string): boolean {
  if (!value.trim()) {
    return true;
  }

  return targetLanguage.toLowerCase().startsWith("zh") && isProbablyCjk(value);
}

function shouldIgnoreForLanguageRatio(codePoint: number): boolean {
  if (codePoint <= 0x20 || codePoint === 0x7f) {
    return true;
  }
  if (codePoint >= 0x21 && codePoint <= 0x2f) {
    return true;
  }
  if (codePoint >= 0x3a && codePoint <= 0x40) {
    return true;
  }
  if (codePoint >= 0x5b && codePoint <= 0x60) {
    return true;
  }
  return codePoint >= 0x7b && codePoint <= 0x7e;
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

