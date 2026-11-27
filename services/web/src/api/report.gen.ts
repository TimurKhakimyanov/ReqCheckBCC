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
export type Findings = Finding[];
export type Question = string;
export type ChecklistAnswer = "yes" | "no" | "not_required";
export type Comment1 = string;
export type FindingIds1 = string[];
export type Checklist = ChecklistItem[];
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
export type LlmCalls = number;
export type PromptTokens = number;
export type CompletionTokens = number;
export type CostUsd = number | null;
export type DurationS = number | null;

export interface Report {
  schema_version?: SchemaVersion;
  passport: RunPassport;
  document: ParsedDocument;
  requirements: Requirements;
  requirement_assessments: RequirementAssessments;
  set_assessment: SetAssessment;
  findings: Findings;
  checklist?: Checklist;
  summary: Summary1;
  conclusion: Conclusion;
  usage?: Usage;
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
}
export interface Usage {
  llm_calls?: LlmCalls;
  prompt_tokens?: PromptTokens;
  completion_tokens?: CompletionTokens;
  cost_usd?: CostUsd;
  duration_s?: DurationS;
}
