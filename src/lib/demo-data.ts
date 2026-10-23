/**
 * Local, keyless embedding + generation primitives.
 *
 * Demo mode needs *some* vector space for retrieval to be meaningful, so we use a
 * seeded keyword-hash embedding: stable, deterministic, free, and good enough that
 * "What is the refund window?" ranks the refund policy chunk first.
 */
import { createHash } from "node:crypto";

export const VECTOR_DIM = 512;

/** Words that carry no retrieval signal in either English or Arabic. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "have", "has", "had", "having", "will", "would", "can", "could", "should", "shall", "may",
  "might", "must", "not", "no", "yes", "it", "its", "this", "that", "these", "those", "i", "you",
  "he", "she", "we", "they", "them", "his", "her", "our", "their", "my", "your", "me", "us",
  "what", "which", "who", "whom", "when", "where", "why", "how", "all", "any", "some", "than",
  "then", "so", "such", "into", "about", "over", "under", "again", "more", "most", "there",
  "here", "just", "also", "very", "too", "up", "out", "off", "per", "via", "etc",
  // Arabic function words — questions in Arabic still need content words to match
  "ما", "ماذا", "كيف", "متى", "اين", "هل", "لماذا", "من", "في", "على", "الى", "عن", "ان", "انت",
  "هذا", "هذه", "ذلك", "التي", "الذي", "او", "ثم", "كان", "كانت", "يكون", "مع", "له", "لها",
  "لا", "لم", "لن", "قد", "كل", "بعض", "غير", "بين", "حتى", "اذا", "هو", "هي", "نحن", "هم",
]);

/** Small Arabic morphological normalisation so استرداد/الاسترداد/استرجاع all match. */
function normalizeArabic(word: string): string {
  return word
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u064B-\u0652]/g, "");
}

export function keywords(text: string): string[] {
  return normalizeArabic(text.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Seeded 0..1 hash — deterministic across processes, unlike Math.random. */
function hash01(seed: string): number {
  const digest = createHash("sha1").update(seed).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/** All n-grams of a word, lowercased and Arabic-normalised. */
function ngrams(word: string, min: number, max: number): string[] {
  const chars = Array.from(normalizeArabic(word.toLowerCase()));
  const out: string[] = [];
  for (let size = min; size <= max; size += 1) {
    for (let i = 0; i + size <= chars.length; i += 1) out.push(chars.slice(i, i + size).join(""));
  }
  return out;
}

/**
 * Character-ngram hashing embedder.
 *
 * Word-level hashing cannot work for retrieval: "refund" and "refunds" would land in
 * different buckets with zero overlap, so a question would never match its own
 * document. Overlapping character n-grams give the shared substring a real signal
 * while staying deterministic and keyless — exactly what demo mode needs.
 */
export function embedLocal(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIM).fill(0);
  const counts = new Map<string, number>();
  for (const word of keywords(text)) counts.set(word, (counts.get(word) ?? 0) + 1);

  for (const [word, count] of counts) {
    const tf = 1 / (1 + Math.log(count));
    const grams = [...ngrams(word, 3, 5), ...(word.length <= 6 ? [normalizeArabic(word.toLowerCase())] : [])];
    for (const gram of grams) {
      const bucket = Math.floor(hash01(gram) * VECTOR_DIM);
      const sign = hash01(`sign:${gram}`) > 0.5 ? 1 : -1;
      vector[bucket] += sign * tf;
    }
  }
  return l2normalize(vector);
}

/**
 * Fraction of the query's content terms that actually appear in the text.
 *
 * This is a better grounding signal than raw similarity: a similarity score scales
 * with how many terms happen to match, so a short unrelated query can still clear a
 * fixed threshold. Coverage is per-query and absolute — "the refund policy" either
 * shares its content words with the chunk or it does not.
 */
export function coverage(query: string, text: string): number {
  const qTerms = keywords(query);
  if (qTerms.length === 0) return 0;

  const present = new Set<string>();
  for (const word of keywords(text)) {
    present.add(word);
    for (const gram of ngrams(word, 3, 5)) present.add(gram);
  }

  let matched = 0;
  for (const term of qTerms) {
    if (present.has(term) || ngrams(term, 3, 5).some((gram) => present.has(gram))) matched += 1;
  }
  return matched / qTerms.length;
}

/**
 * BM25-style lexical score over word and character n-gram terms.
 *
 * Word terms carry the precision; n-gram terms carry morphology ("refund" ↔ "refunds")
 * and Arabic root variants. Without the n-gram half, an exact-word scorer returns 0 for
 * a question and its own document — which is precisely the failure that matters.
 */
export function lexicalScore(query: string, text: string): number {
  const qTerms = new Set(keywords(query));
  if (qTerms.size === 0) return 0;

  const docTerms = keywords(text);
  if (docTerms.length === 0) return 0;

  const freq = new Map<string, number>();
  const add = (term: string) => freq.set(term, (freq.get(term) ?? 0) + 1);
  docTerms.forEach(add);
  // N-gram terms are added for every word, weighted below a full word match.
  for (const word of docTerms) for (const gram of ngrams(word, 3, 5)) add(gram);

  const avgLen = Math.max(1, docTerms.length);
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;

  const scoreTerm = (term: string, weight: number) => {
    const count = freq.get(term) ?? 0;
    if (count === 0) return;
    const idf = 1.6;
    score += weight * ((idf * count * (k1 + 1)) / (count + k1 * (1 - b + (b * docTerms.length) / avgLen)));
  };

  for (const term of qTerms) {
    scoreTerm(term, 1);
    // Morphological bridge: the query word's own n-grams match inflected forms.
    for (const gram of ngrams(term, 3, 5)) scoreTerm(gram, 0.25);
  }
  return score;
}

export function l2normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/** Cosine similarity in [-1, 1]; 1 = identical keyword profile. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

