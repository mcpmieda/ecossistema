import {
  GLOBAL_SEARCH_AUTHORIZATION_POLICY_V1,
  GLOBAL_SEARCH_CONTRACT_VERSION_V1,
  GLOBAL_SEARCH_ORDER_V1,
  GLOBAL_SEARCH_RESULT_KIND_ORDER_V1,
  compareGlobalSearchResultsV1,
  inspectGlobalSearchRequestV1,
  isGlobalSearchResultPresentableV1,
  type GlobalSearchCursorV1,
  type GlobalSearchNonDisclosureOutcomeV1,
  type GlobalSearchNonDisclosureV1,
  type GlobalSearchRequestV1,
  type GlobalSearchResponseV1,
  type GlobalSearchResultKindV1,
  type GlobalSearchResultV1,
  type GlobalSearchResultsPageV1,
} from '../../../../../shared/gradebook-contracts/search/global-search-contract-v1';
import type {
  AcademicEntityKindV1,
  AcademicEntityRecordV1,
  AcademicEntityRepositoryV1,
  AcademicPersistenceContextV1,
  VersionedRecordV1,
} from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

const DEFAULT_REPOSITORY_PAGE_SIZE = 100;
const MAXIMUM_REPOSITORY_PAGE_SIZE = 100;
const CURSOR_PREFIX = 'academic-global-search-v1.';

export type AcademicGlobalSearchReadModelErrorCodeV1 = 'invalid-repository-page-size';

const ERROR_MESSAGES: Record<AcademicGlobalSearchReadModelErrorCodeV1, string> = {
  'invalid-repository-page-size': 'A paginação interna da pesquisa acadêmica é inválida.',
};

export class AcademicGlobalSearchReadModelErrorV1 extends Error {
  readonly code: AcademicGlobalSearchReadModelErrorCodeV1;

  constructor(code: AcademicGlobalSearchReadModelErrorCodeV1) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AcademicGlobalSearchReadModelErrorV1';
    this.code = code;
  }
}

export interface AcademicGlobalSearchReadModelOptionsV1 {
  readonly repositoryPageSize?: number;
}

/**
 * The server must verify this contract's existing authorization policy before exposing this query.
 * This read model does not inspect roles, capabilities or client-provided authorization claims.
 */
export interface AcademicGlobalSearchReadModelV1 {
  readonly authorizationPolicy: typeof GLOBAL_SEARCH_AUTHORIZATION_POLICY_V1;
  search(request: GlobalSearchRequestV1): Promise<GlobalSearchResponseV1>;
}

interface DecodedCursorV1 {
  readonly kind: GlobalSearchResultKindV1;
  readonly id: string;
}

type SearchableEntityRecordV1 = Extract<
  AcademicEntityRecordV1,
  { readonly kind: GlobalSearchResultKindV1 }
>;

type SearchableVersionedRecordV1 = VersionedRecordV1<SearchableEntityRecordV1>;

function repositoryPageSize(options: AcademicGlobalSearchReadModelOptionsV1): number {
  const value = options.repositoryPageSize ?? DEFAULT_REPOSITORY_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAXIMUM_REPOSITORY_PAGE_SIZE) {
    throw new AcademicGlobalSearchReadModelErrorV1('invalid-repository-page-size');
  }
  return value;
}

function nonDisclosure(
  outcome: GlobalSearchNonDisclosureOutcomeV1,
): GlobalSearchNonDisclosureV1 {
  return {
    contractVersion: GLOBAL_SEARCH_CONTRACT_VERSION_V1,
    outcome,
    items: [],
    nextCursor: null,
  };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR');
}

function queryTerms(query: string): readonly string[] {
  return normalizeSearchText(query.trim()).split(/\s+/u).filter(Boolean);
}

function presentationValue(result: GlobalSearchResultV1): string {
  return result.kind === 'class-group' ? result.code : result.displayName;
}

function matchesQuery(result: GlobalSearchResultV1, terms: readonly string[]): boolean {
  const presentation = normalizeSearchText(presentationValue(result));
  return terms.every((term) => presentation.includes(term));
}

function canonicalScopeKinds(request: GlobalSearchRequestV1): readonly GlobalSearchResultKindV1[] {
  return GLOBAL_SEARCH_RESULT_KIND_ORDER_V1.filter((kind) => request.scope.kinds.includes(kind));
}

function asSearchResult(
  context: AcademicPersistenceContextV1,
  expectedKind: GlobalSearchResultKindV1,
  record: VersionedRecordV1<AcademicEntityRecordV1>,
): GlobalSearchResultV1 | null {
  if (record.value.kind !== expectedKind) return null;
  const searchableRecord = record as SearchableVersionedRecordV1;

  let result: GlobalSearchResultV1;
  switch (searchableRecord.value.kind) {
    case 'student':
      result = {
        kind: 'student',
        id: searchableRecord.value.value.id,
        displayName: searchableRecord.value.value.displayName,
      };
      break;
    case 'class-group':
      if (searchableRecord.value.value.academicYearId !== context.academicYearId) return null;
      result = {
        kind: 'class-group',
        id: searchableRecord.value.value.id,
        code: searchableRecord.value.value.code,
      };
      break;
    case 'teacher':
      result = {
        kind: 'teacher',
        id: searchableRecord.value.value.id,
        displayName: searchableRecord.value.value.displayName,
      };
      break;
    case 'subject':
      result = {
        kind: 'subject',
        id: searchableRecord.value.value.id,
        displayName: searchableRecord.value.value.displayName,
      };
      break;
  }

  return isGlobalSearchResultPresentableV1(result) ? result : null;
}

async function listSearchableKind(
  repository: AcademicEntityRepositoryV1,
  context: AcademicPersistenceContextV1,
  kind: GlobalSearchResultKindV1,
  limit: number,
): Promise<readonly GlobalSearchResultV1[] | null> {
  const results: GlobalSearchResultV1[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  try {
    do {
      const page = await repository.list(context, kind as AcademicEntityKindV1, { limit, cursor });
      if (!Array.isArray(page.items)) return null;

      for (const record of page.items) {
        const result = asSearchResult(context, kind, record);
        if (result === null || seenIds.has(result.id)) return null;
        seenIds.add(result.id);
        results.push(result);
      }

      const nextCursor = page.nextCursor;
      if (
        nextCursor !== null &&
        (typeof nextCursor !== 'string' || nextCursor.length === 0 || seenCursors.has(nextCursor))
      ) {
        return null;
      }
      cursor = nextCursor;
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
  } catch {
    return null;
  }

  return results;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');

  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResultKind(value: unknown): value is GlobalSearchResultKindV1 {
  return (
    typeof value === 'string' &&
    (GLOBAL_SEARCH_RESULT_KIND_ORDER_V1 as readonly string[]).includes(value)
  );
}

function encodeCursor(result: GlobalSearchResultV1): GlobalSearchCursorV1 {
  return `${CURSOR_PREFIX}${encodeBase64Url(
    JSON.stringify({ version: 1, kind: result.kind, id: result.id }),
  )}` as GlobalSearchCursorV1;
}

function decodeCursor(cursor: GlobalSearchCursorV1): DecodedCursorV1 | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const decoded = decodeBase64Url(cursor.slice(CURSOR_PREFIX.length));
  if (decoded === null) return null;

  try {
    const value: unknown = JSON.parse(decoded);
    if (!isRecord(value)) return null;
    if (
      value.version !== 1 ||
      !isResultKind(value.kind) ||
      typeof value.id !== 'string' ||
      value.id.trim().length === 0 ||
      Object.keys(value).sort((left, right) => left.localeCompare(right)).join(',') !== 'id,kind,version'
    ) {
      return null;
    }
    return { kind: value.kind, id: value.id };
  } catch {
    return null;
  }
}

function nonEmptyPageItems(
  values: readonly GlobalSearchResultV1[],
): readonly [GlobalSearchResultV1, ...GlobalSearchResultV1[]] | null {
  const first = values[0];
  if (first === undefined) return null;
  return [first, ...values.slice(1)];
}

/**
 * Creates the provider-independent local search. The caller remains responsible for enforcing the
 * server authorization policy before exposing or invoking the returned read model.
 */
export function createAcademicGlobalSearchReadModelV1(
  repository: AcademicEntityRepositoryV1,
  options: AcademicGlobalSearchReadModelOptionsV1 = {},
): AcademicGlobalSearchReadModelV1 {
  const internalPageSize = repositoryPageSize(options);

  return {
    authorizationPolicy: GLOBAL_SEARCH_AUTHORIZATION_POLICY_V1,
    async search(request) {
      const readiness = inspectGlobalSearchRequestV1(request);
      if (readiness !== 'ready') return nonDisclosure(readiness);

      const decodedCursor = request.page.cursor === null ? null : decodeCursor(request.page.cursor);
      if (request.page.cursor !== null && decodedCursor === null) {
        return nonDisclosure('invalid-request');
      }

      const academicYearId = request.academicYearId;
      const requestedLimit = request.page.limit;
      const terms = queryTerms(request.query);
      if (terms.length === 0) return nonDisclosure('empty-query');

      const context: AcademicPersistenceContextV1 = { academicYearId };
      const kinds = canonicalScopeKinds(request);
      const pages = await Promise.all(
        kinds.map((kind) => listSearchableKind(repository, context, kind, internalPageSize)),
      );
      if (pages.includes(null)) return nonDisclosure('insufficient-data');

      const results = pages
        .flatMap((page) => page ?? [])
        .filter((result) => matchesQuery(result, terms))
        .sort(compareGlobalSearchResultsV1);
      if (results.length === 0) return nonDisclosure('no-results');

      let startIndex = 0;
      if (decodedCursor !== null) {
        const cursorIndex = results.findIndex(
          (result) => result.kind === decodedCursor.kind && result.id === decodedCursor.id,
        );
        if (cursorIndex < 0) return nonDisclosure('invalid-request');
        startIndex = cursorIndex + 1;
      }

      const items = nonEmptyPageItems(
        results.slice(startIndex, startIndex + requestedLimit),
      );
      if (items === null) return nonDisclosure('no-results');

      const lastItem = items.at(-1);
      const page: GlobalSearchResultsPageV1 = {
        contractVersion: GLOBAL_SEARCH_CONTRACT_VERSION_V1,
        outcome: 'results',
        academicYearId,
        order: GLOBAL_SEARCH_ORDER_V1,
        limit: requestedLimit,
        items,
        nextCursor:
          startIndex + items.length < results.length && lastItem !== undefined
            ? encodeCursor(lastItem)
            : null,
      };
      return page;
    },
  };
}
