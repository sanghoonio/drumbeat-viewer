/**
 * Field reference: maps raw export column names to friendly labels + groups for the
 * color-by control, and excludes columns that aren't meaningful to color by
 * (the layout axes, ids, free text). Works for any atlas analysis export.
 */
import type { ColumnInfo } from "./columns";
import type { ScaleType } from "../stores/view";

// Never offered as a color-by dimension (axes, ids, free text, provenance).
const EXCLUDE = new Set([
  "umap_x", "umap_y", "post_id", "native_id", "author_id", "author_nickname",
  "url", "document", "cluster_keywords", "topic_id", "model", "text_hash",
  "hashtags", "music_title", "caption",
]);

// De-cluttering: hide caption + on-screen (OCR) channels entirely, every *_arc metric (not
// informative), and the VADER polarity LEVELS (compound / segment mean·min·max) that duplicate
// RoBERTa sentiment + VAD valence. Kept: VADER segment std/p_neg/p_pos/n_seg.
const HIDE_PREFIX = ["cap_", "ocr_"];
const HIDE_EXACT = new Set([
  "all_vader_compound", "tr_vader_compound",
  "tr_vader_seg_mean", "tr_vader_seg_min", "tr_vader_seg_max",
  "hook_vader_seg_mean", "hook_vader_seg_min", "hook_vader_seg_max",
]);
function isHidden(name: string): boolean {
  return name.endsWith("_arc") || HIDE_PREFIX.some((p) => name.startsWith(p)) || HIDE_EXACT.has(name);
}

const CHANNEL: Record<string, string> = {
  cap: "Caption", tr: "Transcript", hook: "Hook", ocr: "On-screen", all: "All text", body: "Body",
};

// Standalone (non-channel) columns.
const META: Record<string, string> = {
  cluster: "Cluster",
  view_count: "Views", like_count: "Likes", comment_count: "Comments", share_count: "Shares",
  collect_count: "Saves", repost_count: "Reposts", author_follower_count: "Followers",
  create_time: "Post date", duration_ms: "Duration (ms)",
  platform: "Platform", region: "Region", content_type: "Content type", author_handle: "Author",
  has_transcript: "Has transcript", has_onscreen: "Has on-screen",
  transcript_confidence: "Transcript confidence", onscreen_confidence: "On-screen confidence",
  is_ad: "Is ad", is_paid_partnership: "Paid partnership", is_drumbeat: "Drumbeat",
};

// The suffix after a channel prefix (e.g. tr_vader_seg_mean → "vader_seg_mean").
const METRIC: Record<string, string> = {
  vader_compound: "VADER sentiment", vader_pos: "VADER positive", vader_neg: "VADER negative",
  vader_seg_mean: "VADER mean", vader_seg_std: "VADER volatility", vader_seg_min: "VADER min",
  vader_seg_max: "VADER max", vader_seg_p_neg: "VADER % negative", vader_seg_p_pos: "VADER % positive",
  vader_seg_arc: "VADER arc", vader_seg_n_seg: "segments",
  // NRC Valence-Arousal-Dominance lexicon — distinct from VADER, so named by dimension.
  vad_valence: "Valence", vad_arousal: "Arousal", vad_dominance: "Dominance",
  subjectivity: "subjectivity", polarity: "TextBlob polarity",
  roberta_neg: "RoBERTa negative", roberta_neu: "RoBERTa neutral", roberta_pos: "RoBERTa positive",
  roberta_pos_std: "RoBERTa pos volatility", roberta_pos_arc: "RoBERTa pos arc",
  n_words: "words", ttr: "lexical diversity", flesch: "reading ease",
};

const ENGAGEMENT = new Set([
  "view_count", "like_count", "comment_count", "share_count",
  "collect_count", "repost_count", "author_follower_count",
]);

// Numeric-typed columns that are semantically categorical (so no color scale + an
// ordinal palette) — the type-based classifier can't tell these from real continuous.
const CATEGORICAL = new Set([
  "cluster", "is_ad", "is_paid_partnership", "is_drumbeat",
  "has_transcript", "has_onscreen",
]);

/** Semantic kind, overriding the naive numeric-type classification. */
export function isCategorical(c: ColumnInfo): boolean {
  return c.kind === "categorical" || CATEGORICAL.has(c.name);
}
export function isContinuous(c: ColumnInfo): boolean {
  return c.kind === "continuous" && !CATEGORICAL.has(c.name);
}

/** Sensible default axis/summary scale for a column: heavy-tailed counts → log. */
export function defaultScale(name: string): ScaleType {
  if (ENGAGEMENT.has(name) || name.endsWith("_count") || name === "duration_ms") return "log";
  return "linear";
}

// Sort order within a group: channel first, then a fixed metric order.
const CH_RANK: Record<string, number> = { cap: 0, tr: 1, hook: 2, ocr: 3, all: 4, body: 5 };
const METRIC_ORDER = [
  "vader_compound", "vader_pos", "vader_neg",
  "vader_seg_mean", "vader_seg_std", "vader_seg_min", "vader_seg_max",
  "vader_seg_p_neg", "vader_seg_p_pos", "vader_seg_arc", "vader_seg_n_seg",
  "vad_valence", "vad_arousal", "vad_dominance", "subjectivity", "polarity",
  "roberta_neg", "roberta_neu", "roberta_pos", "roberta_pos_std", "roberta_pos_arc",
  "n_words", "ttr", "flesch",
];
const GOEMO_ORDER = [
  "anger", "disgust", "fear", "sadness", "annoyance", "disapproval",
  "approval", "joy", "gratitude", "optimism", "caring", "neutral",
];
// Non-channel columns (engagement + metadata), in display order.
const META_ORDER = [
  "cluster",
  "view_count", "like_count", "comment_count", "share_count", "collect_count",
  "repost_count", "author_follower_count",
  "create_time", "duration_ms", "platform", "region", "content_type", "author_handle",
  "has_transcript", "has_onscreen", "transcript_confidence", "onscreen_confidence",
  "is_ad", "is_paid_partnership", "is_drumbeat",
];

function metricRank(rest: string): number {
  if (rest.startsWith("goemo_")) {
    const i = GOEMO_ORDER.indexOf(rest.slice(6));
    return 100 + (i >= 0 ? i : 99);
  }
  const i = METRIC_ORDER.indexOf(rest);
  return i >= 0 ? i : 500;
}

function sortKey(name: string): number {
  const cs = channelSplit(name);
  if (cs) return CH_RANK[cs[0]] * 1000 + metricRank(cs[1]);
  const i = META_ORDER.indexOf(name);
  return i >= 0 ? i : 900;
}

function channelSplit(name: string): [string, string] | null {
  const i = name.indexOf("_");
  if (i < 0) return null;
  const ch = name.slice(0, i);
  return CHANNEL[ch] ? [ch, name.slice(i + 1)] : null;
}

export function fieldLabel(name: string): string {
  if (META[name]) return META[name];
  const cs = channelSplit(name);
  if (cs) {
    const [ch, rest] = cs;
    if (rest.startsWith("goemo_")) return `${CHANNEL[ch]}: ${rest.slice(6)}`;
    return `${CHANNEL[ch]}: ${METRIC[rest] ?? rest}`;
  }
  return name;
}

// One-line "what is this" descriptions, keyed by metric suffix / exact name.
const METRIC_DESC: Record<string, string> = {
  vader_seg_std: "Volatility of VADER rule-based sentiment across segments.",
  vader_seg_p_neg: "Share of segments VADER scored net-negative.",
  vader_seg_p_pos: "Share of segments VADER scored net-positive.",
  vader_seg_n_seg: "Number of transcript segments.",
  vad_valence: "NRC-VAD valence: unpleasant → pleasant word tone.",
  vad_arousal: "NRC-VAD arousal: calm → excited/intense word tone.",
  vad_dominance: "NRC-VAD dominance: controlled → in-control word tone.",
  subjectivity: "TextBlob subjectivity: 0 factual → 1 opinionated.",
  polarity: "TextBlob polarity: −1 negative → +1 positive.",
  roberta_neg: "RoBERTa transformer: mean probability of negative sentiment.",
  roberta_neu: "RoBERTa transformer: mean probability of neutral sentiment.",
  roberta_pos: "RoBERTa transformer: mean probability of positive sentiment.",
  roberta_pos_std: "Volatility of RoBERTa positive probability across segments.",
  n_words: "Word count.",
  ttr: "Type-token ratio: lexical diversity (unique / total words).",
  flesch: "Flesch reading ease: higher is easier to read.",
};
const META_DESC: Record<string, string> = {
  view_count: "Total views.",
  like_count: "Total likes.",
  comment_count: "Total comments.",
  share_count: "Total shares.",
  collect_count: "Total saves.",
  repost_count: "Total reposts.",
  author_follower_count: "Author's follower count.",
  create_time: "When the post was published.",
  duration_ms: "Video duration (milliseconds).",
  transcript_confidence: "Whisper transcription confidence.",
  onscreen_confidence: "On-screen (OCR) text confidence.",
};

/** One-line description of a field, for tooltips. Empty string if none known. */
export function fieldDescription(name: string): string {
  if (META_DESC[name]) return META_DESC[name];
  const cs = channelSplit(name);
  if (cs) {
    const rest = cs[1];
    if (rest.startsWith("goemo_")) return `GoEmotions: probability the text expresses ${rest.slice(6)}.`;
    if (METRIC_DESC[rest]) return METRIC_DESC[rest];
  }
  return "";
}

function fieldGroup(name: string): string {
  if (name === "cluster") return "Embedding";
  if (ENGAGEMENT.has(name)) return "Engagement";
  const cs = channelSplit(name);
  if (cs) {
    const rest = cs[1];
    if (rest.startsWith("goemo_")) return "Emotion";
    if (rest.startsWith("vader") || rest.startsWith("vad_") ||
        rest === "subjectivity" || rest === "polarity" || rest.startsWith("roberta")) return "Sentiment";
    if (rest === "n_words" || rest === "ttr" || rest === "flesch") return "Text";
  }
  return "Metadata";
}

const GROUP_ORDER = ["Embedding", "Engagement", "Sentiment", "Emotion", "Text", "Metadata"];

export interface FieldOption { name: string; label: string; categorical: boolean; }
export interface FieldGroup { group: string; items: FieldOption[]; }

/** Grouped, labeled color-by options — excludes ids/axes/free text. */
export function colorByGroups(columns: ColumnInfo[]): FieldGroup[] {
  const groups = new Map<string, FieldOption[]>();
  for (const c of columns) {
    if (c.kind === "id" || EXCLUDE.has(c.name) || isHidden(c.name)) continue;
    const g = fieldGroup(c.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ name: c.name, label: fieldLabel(c.name), categorical: isCategorical(c) });
  }
  for (const items of groups.values()) items.sort((a, b) => sortKey(a.name) - sortKey(b.name));
  const order = [...GROUP_ORDER, ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g))];
  return order.filter((g) => groups.has(g)).map((g) => ({ group: g, items: groups.get(g)! }));
}
