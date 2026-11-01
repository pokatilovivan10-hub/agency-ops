export function cleanProjectName(value) {
  const name = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^[«„“"']+|[»“”"'.!?;,]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (name.length < 2 || name.length > 80) return '';
  return name;
}

export function normalizeProjectName(value) {
  return cleanProjectName(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function extractProjectName(input = {}) {
  const explicit = cleanProjectName(input.project_name);
  if (explicit) return explicit;

  const transcript = String(input.transcript || '').normalize('NFKC').trim();
  if (!transcript) return '';
  const tail = transcript.slice(-1200);
  const candidates = tail
    .split(/\n+/u)
    .flatMap(line => line.split(/(?<=[.!?])\s+/u))
    .map(line => line.trim())
    .filter(Boolean)
    .reverse();

  for (const candidate of candidates) {
    const match = candidate.match(/^проект\s*[:—-]?\s*(.+?)[.!?]?$/iu);
    if (!match) continue;
    const name = cleanProjectName(match[1]);
    if (name) return name;
  }
  return '';
}
