/* Generated from packages/contracts/req_contracts/fixtures/report.schema.json by pnpm gen:types. Do not edit. */

export type SchemaVersion = string;
export type DocumentName = string;
export type DocumentSha256 = string;
export type RunAt = string;
export type Provider = string;
export type Model = string;
/**
 * git commit или тег агента
 */
export type AgentVersion = string;
export type Standards = string[];
export type Name = string;
export type DocumentFormat = "pdf" | "docx" | "md" | "txt";
export type Sha256 = string;
export type Text = string;
/**
 * Смещение начала каждой страницы в `text` (только для PDF)
 */
export type PageOffsets = number[] | null;
/**
 * Идентификатор в отчёте: R-001, R-002…; подтребования R-002.1
 */
export type Id = string;
/**
 * Идентификатор в документе (Ф-1), если был
 */
export type SourceId = string | null;
/**
 * Для атомарного подтребования — id составного
 */
export type ParentId = string | null;
export type RequirementKind =
  "functional" | "non_functional" | "data" | "integration" | "api" | "ui" | "acceptance" | "other";
/**
 * Краткая формулировка для таблицы нарезки
 */
export type Summary = string;
/**
 * Путь раздела, напр. «Часть A › Функциональные требования»
 */
export type Section = string;
/**
 * Дословная цитата из документа
 */
export type Quote = string;
/**
 * Смещение цитаты в ParsedDocument.text
 */
export type CharStart = number | null;
export type CharEnd = number | null;
/**
 * Номер страницы с 1 (для PDF)
 */
export type Page = number | null;
/**
 * Цитата найдена в тексте документа кодом (защита от галлюцинаций)
 */
export type Verified = boolean;
/**
 * Первая строка (абзац) документа, с 1
 */
export type LineStart = number | null;
/**
 * Последняя строка (абзац) документа
 */
export type LineEnd = number | null;
export type Requirements = Requirement[];
export type RequirementId = string;
export type Criterion =
  | "necessary"
  | "implementation_free"
  | "unambiguous"
  | "complete"
  | "singular"
  | "feasible"
  | "verifiable"
  | "correct"
  | "conforming"
  | "traceable"
  | "set_complete"
  | "set_consistent"
  | "set_feasible"
  | "set_comprehensible"
  | "set_validatable"
  | "set_ranked"
  | "set_modifiable"
  | "set_traceable";
export type CheckVerdict = "pass" | "fail" | "not_applicable";
export type Comment = string | null;
export type FindingIds = string[];
/**
 * Кто оценил критерий набора (рецензенты)
 */
export type AssessedBy = string[];
export type Checks = CriterionCheck[];
export type RequirementAssessments = RequirementAssessment[];
export type Checks1 = CriterionCheck[];
/**
 * D-001, D-002…
 */
export type Id1 = string;
export type FindingScope = "requirement" | "set";
export type RequirementIds = string[];
export type Severity = "critical" | "major" | "minor";
export type Title = string;
export type Explanation = string;
/**
 * @minItems 1
 */
export type Locations = [SourceLocation, ...SourceLocation[]];
/**
 * Предлагаемая исправленная формулировка
 */
export type Suggestion = string | null;
export type FindingSource = "llm" | "rule";
/**
 * Тип дефекта (методика bbc-agent). Первые три — «критичные» в терминах задания.
 */
export type DefectType =
  | "unverifiable"
  | "contradictory"
  | "incomplete"
  | "ambiguous"
  | "design"
  | "not_singular"
  | "infeasible"
  | "incorrect"
  | "nonconforming"
  | "untraceable"
  | "redundant"
  | "risk";
/**
 * Насколько цитата замечания совпала с документом (проверено кодом).
 */
export type Grounding = "exact" | "fuzzy" | "line";
/**
 * Агенты, нашедшие дефект (с учётом слитых дублей): inspector, reviewer:qa…
 */
export type FoundBy = string[];
/**
 * Обоснование решения верификатора
 */
export type VerifierNote = string | null;
/**
 * Вопрос Q-xx, ответ на который снимает дефект
 */
export type ResolvedBy = string | null;
export type Findings = Finding[];
export type Question = string;
export type ChecklistAnswer = "yes" | "no" | "partial" | "not_required";
export type Comment1 = string;
export type FindingIds1 = string[];
export type Checklist = ChecklistItem[];
/**
 * Q-01, Q-02…
 */
export type Id2 = string;
export type Question1 = string;
/**
 * Что заблокировано без ответа
 */
export type Why = string;
/**
 * Кто отвечает: Business owner, Product owner, Аналитик…
 */
export type Addressee = string;
export type QuestionPriority = "blocker" | "important" | "minor";
export type FindingIds2 = string[];
/**
 * 2–4 варианта ответа, между которыми выбирает автор
 */
export type Options = string[];
export type RequirementIds1 = string[];
/**
 * Ответ автора (если прогон запущен с ответами)
 */
export type Answer = string | null;
export type RequirementId1 = string;
export type NewText = string;
export type Rewrites = RequirementRewrite[];
export type ClosesFindings = string[];
export type Note = string;
export type Questions = ClarifyingQuestion[];
export type RequirementsTotal = number;
export type FindingsTotal = number;
export type CriticalFindingIds = string[];
export type ReadyForDevelopment = boolean;
export type ReadyForTesting = boolean;
export type Rationale = string;
/**
 * Что исправить в первую очередь, по порядку; со ссылками на D-xxx
 */
export type TopFixes = string[];
/**
 * Итоговое решение по документу.
 */
export type Decision = "blocked" | "limited" | "ready";
/**
 * Что можно брать в разработку сейчас, что заблокировано
 */
export type Development = string;
/**
 * По каким требованиям можно писать тест-кейсы
 */
export type Testing = string;
export type Action = string;
export type Why1 = string;
export type FindingIds3 = string[];
/**
 * top_fixes с обоснованием и ссылками
 */
export type Fixes = FixItem[];
/**
 * Сильные стороны документа
 */
export type Strengths = string[];
/**
 * Решение ужесточено правилом (например, есть критичные дефекты)
 */
export type GuardNote = string;
export type LlmCalls = number;
export type PromptTokens = number;
export type CompletionTokens = number;
export type CostUsd = number | null;
export type DurationS = number | null;
/**
 * Название документа (из первого заголовка)
 */
export type DocumentTitle = string | null;
export type Reason = string;
export type Skipped = SkippedFragment[];
export type Candidates = number;
export type RejectedByCode = number;
export type RejectedByVerifier = number;
export type Merged = number;
export type Confirmed = number;
export type Unverified = number;
export type EvidenceExact = number;
export type EvidenceFuzzy = number;
export type EvidenceLine = number;
export type InlineQuotesUnverified = number;
export type RemovedRefs = number;
export type MatrixCellsTotal = number;
export type MatrixCellsFilled = number;
export type Rounds = number;
export type UncoveredRequirements = string[];
export type ReviewsFailed = string[];
export type ExtractedFirstPass = number;
export type ExtractedByCoverage = number;
export type ContextWindow = number | null;
export type ContextPeakPct = number | null;
export type DocParts = number;
export type Warnings = string[];

export interface Report {
  schema_version?: SchemaVersion;
  passport: RunPassport;
  document: ParsedDocument;
  requirements: Requirements;
  requirement_assessments: RequirementAssessments;
  set_assessment: SetAssessment;
  findings: Findings;
  checklist?: Checklist;
  questions?: Questions;
  summary: Summary1;
  conclusion: Conclusion;
  usage?: Usage;
  document_title?: DocumentTitle;
  skipped?: Skipped;
  quality?: QualityStats | null;
}
export interface RunPassport {
  document_name: DocumentName;
  document_sha256: DocumentSha256;
  run_at: RunAt;
  provider: Provider;
  model: Model;
  agent_version: AgentVersion;
  standards?: Standards;
}
/**
 * Нормализованный текст документа. Все смещения в отчёте считаются от `text`.
 */
export interface ParsedDocument {
  name: Name;
  format: DocumentFormat;
  sha256: Sha256;
  text: Text;
  page_offsets?: PageOffsets;
}
export interface Requirement {
  id: Id;
  source_id?: SourceId;
  parent_id?: ParentId;
  kind: RequirementKind;
  summary: Summary;
  location: SourceLocation;
}
/**
 * Ссылка на конкретное место документа. Каждое нарушение обязано иметь хотя бы одну.
 */
export interface SourceLocation {
  section: Section;
  quote: Quote;
  char_start?: CharStart;
  char_end?: CharEnd;
  page?: Page;
  verified?: Verified;
  line_start?: LineStart;
  line_end?: LineEnd;
}
export interface RequirementAssessment {
  requirement_id: RequirementId;
  checks: Checks;
}
export interface CriterionCheck {
  criterion: Criterion;
  verdict: CheckVerdict;
  comment?: Comment;
  finding_ids?: FindingIds;
  assessed_by?: AssessedBy;
}
export interface SetAssessment {
  checks: Checks1;
}
export interface Finding {
  id: Id1;
  scope: FindingScope;
  requirement_ids?: RequirementIds;
  criterion: Criterion;
  severity: Severity;
  title: Title;
  explanation: Explanation;
  locations: Locations;
  suggestion?: Suggestion;
  source?: FindingSource;
  defect_type?: DefectType | null;
  /**
   * Лучшая привязка цитат замечания к тексту
   */
  grounding?: Grounding | null;
  found_by?: FoundBy;
  verifier_note?: VerifierNote;
  resolved_by?: ResolvedBy;
}
/**
 * Ответ агента на пункт чек-листа «Ревью требований» из шаблона документа (если он есть).
 */
export interface ChecklistItem {
  question: Question;
  answer: ChecklistAnswer;
  comment: Comment1;
  finding_ids?: FindingIds1;
}
/**
 * Уточняющий вопрос автору документа: закрытый, с вариантами ответа и ссылками на дефекты.
 */
export interface ClarifyingQuestion {
  id: Id2;
  question: Question1;
  why: Why;
  addressee?: Addressee;
  priority?: QuestionPriority;
  finding_ids?: FindingIds2;
  options?: Options;
  requirement_ids?: RequirementIds1;
  answer?: Answer;
  resolution?: QuestionResolution | null;
}
/**
 * Что меняет ответ автора: новые редакции требований и снятые дефекты.
 */
export interface QuestionResolution {
  rewrites?: Rewrites;
  closes_findings?: ClosesFindings;
  note?: Note;
}
export interface RequirementRewrite {
  requirement_id: RequirementId1;
  new_text: NewText;
}
export interface Summary1 {
  requirements_total: RequirementsTotal;
  findings_total: FindingsTotal;
  by_severity: BySeverity;
  critical_finding_ids: CriticalFindingIds;
}
export interface BySeverity {
  [k: string]: number;
}
export interface Conclusion {
  ready_for_development: ReadyForDevelopment;
  ready_for_testing: ReadyForTesting;
  rationale: Rationale;
  top_fixes: TopFixes;
  /**
   * Нельзя / можно с ограничениями / можно
   */
  decision?: Decision | null;
  development?: Development;
  testing?: Testing;
  fixes?: Fixes;
  strengths?: Strengths;
  guard_note?: GuardNote;
}
export interface FixItem {
  action: Action;
  why?: Why1;
  finding_ids?: FindingIds3;
}
export interface Usage {
  llm_calls?: LlmCalls;
  prompt_tokens?: PromptTokens;
  completion_tokens?: CompletionTokens;
  cost_usd?: CostUsd;
  duration_s?: DurationS;
}
/**
 * Текст документа, который нарезчик не счёл требованием (контроль покрытия нарезки).
 */
export interface SkippedFragment {
  location: SourceLocation;
  reason: Reason;
}
/**
 * Контроль достоверности и покрытия прогона.
 */
export interface QualityStats {
  candidates?: Candidates;
  rejected_by_code?: RejectedByCode;
  rejected_by_verifier?: RejectedByVerifier;
  merged?: Merged;
  confirmed?: Confirmed;
  unverified?: Unverified;
  evidence_exact?: EvidenceExact;
  evidence_fuzzy?: EvidenceFuzzy;
  evidence_line?: EvidenceLine;
  inline_quotes_unverified?: InlineQuotesUnverified;
  removed_refs?: RemovedRefs;
  matrix_cells_total?: MatrixCellsTotal;
  matrix_cells_filled?: MatrixCellsFilled;
  rounds?: Rounds;
  uncovered_requirements?: UncoveredRequirements;
  reviews_failed?: ReviewsFailed;
  extracted_first_pass?: ExtractedFirstPass;
  extracted_by_coverage?: ExtractedByCoverage;
  context_window?: ContextWindow;
  context_peak_pct?: ContextPeakPct;
  doc_parts?: DocParts;
  prompt_versions?: PromptVersions;
  warnings?: Warnings;
}
export interface PromptVersions {
  [k: string]: string;
}
