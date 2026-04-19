export interface DocsMapDocEntry {
  path: string;
  anchor?: string;
}

export interface DocsMapMapping {
  code: string;
  docs: string | Array<string | DocsMapDocEntry>;
  anchor?: string;
}

export interface DocsMap {
  mappings: DocsMapMapping[];
  fallback?: { search_headings?: boolean };
  style_guide?: string;
}

export interface TargetDoc {
  docsPath: string;
  anchor?: string;
  matchedFiles: string[];
  source: 'mapped' | 'inferred';
  docExists?: boolean;
  rationale?: string;
}

export interface RepoDocFile {
  path: string;
  headings: string[];
  tokens: string[];
}

export interface PlanningResult {
  targets: TargetDoc[];
  usedDocsMap: boolean;
  docsRepoEmpty: boolean;
  styleGuidePath?: string;
  note?: string;
}

export interface SupplementalContextItem {
  path: string;
  label: string;
  content: string;
  excerpt: string;
}

export interface SupplementalContextSummary {
  items: SupplementalContextItem[];
  combinedSummary: string;
}

export interface AppContextFile {
  path: string;
  reason: string;
  excerpt: string;
}

export interface AppContextSummary {
  files: AppContextFile[];
  combinedSummary: string;
}

export interface DocPlanItem {
  docPath: string;
  matchedFiles: string[];
  source: 'mapped' | 'inferred';
  docExists: boolean;
  operation: 'update' | 'create' | 'delete';
  rationale?: string;
  anchor?: string;
}
