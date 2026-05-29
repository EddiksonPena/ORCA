import type {
  CompactConversationRequest,
  CompactConversationResponse,
  CompactionCandidate,
  ConversationTurn,
  IngestMemoryRequest,
} from "@orca/schemas";

import { createStableId, dedupeStrings, extractEntities, summarize, tokenize } from "./utils.js";

const SOFT_THRESHOLD = 0.7;
const MIN_PROCEDURAL_SCORE = 0.62;
const MIN_SEMANTIC_SCORE = 0.48;
const MIN_EPISODIC_SCORE = 0.52;
const MAX_WORKING_MESSAGES = 6;

const FACT_PATTERNS = [
  /\b(is|are|uses|requires|runs on|depends on|mapped to|configured as)\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
];

const PROCEDURAL_PATTERNS = [
  /^\s*\d+\./m,
  /\bfirst\b/i,
  /\bthen\b/i,
  /\bnext\b/i,
  /\bfinally\b/i,
  /\brun\b/i,
  /\bexecute\b/i,
  /\bdeploy\b/i,
  /\brestart\b/i,
  /\bfix\b/i,
];

const OPEN_LOOP_PATTERNS = [
  /\?/,
  /\btodo\b/i,
  /\bnext step\b/i,
  /\bfollow up\b/i,
  /\bneed to\b/i,
  /\bremaining\b/i,
  /\bblocker\b/i,
];

const splitSentences = (content: string): string[] =>
  content
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

const estimateOccupancy = (request: CompactConversationRequest): number => {
  if (typeof request.occupancyRatio === "number") {
    return request.occupancyRatio;
  }

  if (
    typeof request.currentWindowTokens === "number" &&
    typeof request.maxWindowTokens === "number" &&
    request.maxWindowTokens > 0
  ) {
    return request.currentWindowTokens / request.maxWindowTokens;
  }

  const totalTokens = request.messages.reduce((sum, message) => sum + tokenize(message.content).length, 0);
  return Math.min(totalTokens / 6000, 1);
};

const scoreSentence = (sentence: string, patterns: RegExp[], tokenWeight = 0.015): number => {
  const tokens = tokenize(sentence);
  const entities = extractEntities(sentence);
  let score = Math.min(tokens.length * tokenWeight, 0.25) + Math.min(entities.length * 0.05, 0.2);
  for (const pattern of patterns) {
    if (pattern.test(sentence)) {
      score += 0.16;
    }
  }
  return Math.max(0, Math.min(score, 0.99));
};

const buildWorkingSummary = (messages: ConversationTurn[]): string => {
  const recent = messages.slice(-MAX_WORKING_MESSAGES);
  const stitched = recent.map((message) => `${message.role}: ${message.content}`).join(" ");
  return summarize(stitched);
};

const extractOpenLoops = (messages: ConversationTurn[]): string[] => {
  const loops: string[] = [];
  for (const message of messages) {
    for (const sentence of splitSentences(message.content)) {
      if (OPEN_LOOP_PATTERNS.some((pattern) => pattern.test(sentence))) {
        loops.push(sentence);
      }
    }
  }
  return dedupeStrings(loops).slice(0, 8);
};

const deriveEpisodicCandidate = (messages: ConversationTurn[]): CompactionCandidate | undefined => {
  const stitched = messages
    .filter((message) => message.role !== "system")
    .slice(-12)
    .map((message) => message.content)
    .join(" ");
  if (!stitched.trim()) {
    return undefined;
  }

  const score = Math.max(
    MIN_EPISODIC_SCORE,
    scoreSentence(stitched, [/incident/i, /decision/i, /attempt/i, /completed/i, /failed/i], 0.01),
  );
  return {
    moduleId: "episodic",
    content: `Conversation episode. ${summarize(stitched)}`,
    score,
    reason: "Compacted a high-pressure conversation window into a durable episode.",
    tags: dedupeStrings(extractEntities(stitched)).slice(0, 8),
  };
};

const deriveSemanticCandidates = (messages: ConversationTurn[]): CompactionCandidate[] => {
  const candidates: CompactionCandidate[] = [];
  for (const message of messages) {
    for (const sentence of splitSentences(message.content)) {
      const score = scoreSentence(sentence, FACT_PATTERNS);
      if (score < MIN_SEMANTIC_SCORE) {
        continue;
      }
      candidates.push({
        moduleId: "semantic",
        content: sentence,
        score,
        reason: "Derived a durable fact or stable constraint from compacted conversation context.",
        tags: dedupeStrings(extractEntities(sentence)).slice(0, 6),
      });
    }
  }
  return candidates.slice(0, 6);
};

const deriveProceduralCandidates = (messages: ConversationTurn[]): CompactionCandidate[] => {
  const candidates: CompactionCandidate[] = [];
  for (const message of messages) {
    const sentences = splitSentences(message.content);
    const joined = sentences.join(" ");
    const score = scoreSentence(joined, PROCEDURAL_PATTERNS, 0.012);
    if (score >= MIN_PROCEDURAL_SCORE) {
      candidates.push({
        moduleId: "procedural",
        content: summarize(joined),
        score,
        reason: "Detected procedural or repeatable workflow content during compaction.",
        tags: dedupeStrings(extractEntities(joined)).slice(0, 6),
      });
      continue;
    }

    const stepLike = sentences.filter((sentence) => PROCEDURAL_PATTERNS.some((pattern) => pattern.test(sentence)));
    if (stepLike.length >= 2) {
      candidates.push({
        moduleId: "procedural",
        content: stepLike.join(" "),
        score: MIN_PROCEDURAL_SCORE,
        reason: "Merged repeated step-like instructions into a compact procedural memory.",
        tags: dedupeStrings(extractEntities(stepLike.join(" "))).slice(0, 6),
      });
    }
  }
  return candidates.slice(0, 4);
};

export interface LifecyclePlan {
  triggered: boolean;
  reason: string;
  occupancyRatio: number;
  workingSummary: string;
  openLoops: string[];
  discardedMessageCount: number;
  candidates: CompactionCandidate[];
}

export const planConversationCompaction = (request: CompactConversationRequest): LifecyclePlan => {
  const occupancyRatio = Number(estimateOccupancy(request).toFixed(3));
  const thresholdRatio = request.thresholdRatio ?? SOFT_THRESHOLD;
  const triggered = request.force === true || occupancyRatio >= thresholdRatio;
  const workingSummary = buildWorkingSummary(request.messages);
  const openLoops = extractOpenLoops(request.messages);
  const discardedMessageCount = Math.max(0, request.messages.length - MAX_WORKING_MESSAGES);

  if (!triggered) {
    return {
      triggered: false,
      reason: `Context pressure is below threshold (${occupancyRatio} < ${thresholdRatio}).`,
      occupancyRatio,
      workingSummary,
      openLoops,
      discardedMessageCount,
      candidates: [],
    };
  }

  const candidates = [
    deriveEpisodicCandidate(request.messages),
    ...deriveSemanticCandidates(request.messages),
    ...deriveProceduralCandidates(request.messages),
  ].filter((candidate): candidate is CompactionCandidate => Boolean(candidate));

  return {
    triggered: true,
    reason:
      request.force === true
        ? "Compaction forced explicitly."
        : `Context pressure crossed threshold (${occupancyRatio} >= ${thresholdRatio}).`,
    occupancyRatio,
    workingSummary,
    openLoops,
    discardedMessageCount,
    candidates,
  };
};

export const buildPromotionRequest = (
  request: CompactConversationRequest,
  candidate: CompactionCandidate,
): IngestMemoryRequest => {
  const observedAt = request.messages.at(-1)?.createdAt;
  return {
    scope: request.scope,
    source: "adaptive-compaction",
    sourceId: createStableId(
      [request.conversationId ?? request.sessionId ?? "conversation", candidate.moduleId, candidate.content].join(
        "::",
      ),
    ),
    content: candidate.content,
    tags: dedupeStrings([
      "adaptive-compaction",
      candidate.moduleId,
      ...candidate.tags,
      ...extractOpenLoops(request.messages),
    ]).slice(0, 12),
    typeHint: candidate.moduleId === "semantic" ? "semantic" : candidate.moduleId,
    ...(observedAt ? { observedAt } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  };
};

export const toCompactionResponse = (
  plan: LifecyclePlan,
  promoted: CompactConversationResponse["promoted"],
): CompactConversationResponse => ({
  triggered: plan.triggered,
  reason: plan.reason,
  occupancyRatio: plan.occupancyRatio,
  workingSummary: plan.workingSummary,
  openLoops: plan.openLoops,
  discardedMessageCount: plan.discardedMessageCount,
  promoted,
  candidates: plan.candidates,
});
