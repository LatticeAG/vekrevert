export type {
  JsonValue,
  JsonPrimitive,
  Tier,
  EffectStatus,
  CompensationState,
  CaptureFidelity,
  HttpMethod,
  SqlKind,
  SqlDialect,
  FsOp,
  ActionRef,
  BindingExtractor,
  PreimageRef,
  CompensatorCandidate,
  ClassificationSource,
  ClassificationRecord,
  EffectReceipt,
  RefSource,
  Ref,
  ArgValue,
  SignatureMatcher,
  Predicate,
  DeclarativeCompensator,
  ProgrammaticCompensatorRef,
  ActionSignature,
  CompensationPlan,
  CompensationStep,
  Postcondition,
  VerificationRecord,
  Saga,
  UndoReport,
  Actor,
  VRCode,
  PlanRejection,
  ExecuteResult,
  MatchResult,
  RegisterResult,
  SagaStatus,
  ReceiptsReport,
  Escalation,
  UndoOptions,
  VekRevertConfig,
  EscalationReasonCode,
  TierEvidence,
} from "./types.ts";

export {
  VekRevertError,
  VR_MESSAGES,
  SDK_VERSION,
  WEBHOOK_MAX_TIMESTAMP_SKEW_MS,
  DEFAULT_LIMITS,
  DEFAULT_LEASE,
  DEFAULT_LEDGER_OPTS,
} from "./types.ts";

export { canonicalize, sha256Hex, sha256Prefixed, hashJcs, crockford32, crockford32OfSha256, selfTest } from "./jcs.ts";
export {
  NS,
  genesisHash,
  deriveEffectId,
  deriveIntentKey,
  derivePlanHash,
  deriveIdempotencyKey,
  sealHash,
  chainEvent,
  verifyChain,
  merkleRoot,
  eventBodyForHash,
} from "./chain.ts";
export type { ChainableEvent, ChainVerifyResult } from "./chain.ts";
export { classifySql } from "./sqlkind.ts";
export type { SqlClassification } from "./sqlkind.ts";
export { stripVolatile } from "./intent.ts";
export {
  TIER_ORDER,
  maxTier,
  minTier,
  classifyLocality,
  classifyStructural,
  joinTier,
  detectScopeViolation,
  classifyAction,
} from "./taxonomy.ts";
export type { ClassifyContext } from "./taxonomy.ts";
export { templateMigration, loadInitSql } from "./migrate.ts";
export { resourceKeys, normalizeHttpUrl, actionName } from "./resource.ts";
export { matchCompensator, specificityScore } from "./match.ts";
export type { MatchableCompensator, MatchCompensatorResult } from "./match.ts";
export {
  compilePlan,
  assertProvenance,
  resolveRef,
  assertScope,
  assertCredentialPositions,
  planHash,
  isRef,
  isPlanRejection,
} from "./plan.ts";
export type { CompilePlanOpts } from "./plan.ts";
export { evalJsonPath } from "./jsonpath.ts";
export { whatUndoDoesNotFix, worldRestored, worldRestoredFromReport } from "./report.ts";
