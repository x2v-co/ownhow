const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "use", "when",
  "with", "you", "your", "user", "users", "using", "需要", "使用", "用户",
  "可以", "用于", "进行", "支持", "相关", "以及", "或者", "一个"
]);

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value) {
  const normalized = normalizeText(value);
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const cjk = [];

  for (const run of cjkRuns) {
    if (run.length <= 2) cjk.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      cjk.push(run.slice(index, index + 2));
    }
  }

  return new Set([...latin, ...cjk].filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

export function overlapScore(left, right) {
  const a = left instanceof Set ? left : tokenize(left);
  const b = right instanceof Set ? right : tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

export function matchingTokens(left, right) {
  const a = left instanceof Set ? left : tokenize(left);
  const b = right instanceof Set ? right : tokenize(right);
  return [...a].filter((token) => b.has(token)).sort();
}

export function slugify(value) {
  const slug = normalizeText(value).replace(/[^a-z0-9\p{Script=Han}]+/gu, "-").replace(/^-|-$/g, "");
  return slug || "method";
}
