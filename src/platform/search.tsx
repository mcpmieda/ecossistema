import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Kbd, Label, SearchField, Surface } from '@heroui/react';
import { Boxes, Search, Settings2, X } from 'lucide-react';
import type { PlatformSnapshotContract } from '../../shared/platform-contract';
import { buildSearchItems, filterSearchItems, type PlatformSearchItem } from './search-model';
import { routeIcons } from './routes';

function SearchResults({
  items,
  query,
  onNavigate,
}: Readonly<{
  items: PlatformSearchItem[];
  query: string;
  onNavigate: (href: string) => void;
}>) {
  if (!query.trim()) return null;

  if (items.length === 0) {
    return (
      <Surface variant="transparent" className="px-5 py-8 text-center">
        <p className="text-sm font-medium">Nenhum resultado encontrado</p>
        <p className="mt-1 text-xs text-muted">Tente outro termo de busca.</p>
      </Surface>
    );
  }

  return (
    <ul aria-label="Resultados da busca" className="platform-search-results">
      {items.map((item) => {
        const Icon =
          item.iconKind === 'system'
            ? Boxes
            : item.iconKind === 'configuration'
              ? Settings2
              : routeIcons[item.route ?? 'banco-de-notas'];
        return (
          <li key={item.id}>
            <Button
              variant="ghost"
              fullWidth
              className="platform-search-results__item h-auto justify-start text-left"
              data-search-href={item.href}
              onPress={() => onNavigate(item.href)}
            >
              <Surface
                variant="secondary"
                className="grid size-9 shrink-0 place-items-center rounded-xl"
              >
                <Icon className="size-4 text-muted" />
              </Surface>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{item.label}</span>
                  <Chip variant="soft" size="sm" className="shrink-0">
                    {item.category}
                  </Chip>
                </span>
                <span className="mt-0.5 block line-clamp-2 text-xs text-muted">
                  {item.description}
                </span>
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function InlineSearchField({
  inputRef,
  query,
  setQuery,
  isDisabled,
  onFocus,
  showShortcut = false,
}: Readonly<{
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (value: string) => void;
  isDisabled: boolean;
  onFocus: () => void;
  showShortcut?: boolean;
}>) {
  return (
    <SearchField
      name="platform-search"
      fullWidth
      value={query}
      onChange={setQuery}
      onClear={() => setQuery('')}
      isDisabled={isDisabled}
    >
      <Label className="sr-only">Buscar no Centro</Label>
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input ref={inputRef} placeholder="Buscar no Centro" onFocus={onFocus} />
        <SearchField.ClearButton />
        {showShortcut && (
          <Kbd variant="light" className="platform-search-shortcut shrink-0">
            <Kbd.Content>Ctrl K</Kbd.Content>
          </Kbd>
        )}
      </SearchField.Group>
    </SearchField>
  );
}

export function PlatformSearch({
  snapshot,
}: Readonly<{ snapshot: PlatformSnapshotContract | null }>) {
  const [query, setQuery] = useState('');
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchRootRef = useRef<HTMLDivElement>(null);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => (snapshot ? buildSearchItems(snapshot) : []), [snapshot]);
  const results = useMemo(() => filterSearchItems(items, query), [items, query]);
  const hasQuery = Boolean(query.trim());

  const closeSearch = (reset = true) => {
    if (reset) setQuery('');
    setDesktopOpen(false);
    setMobileOpen(false);
  };

  const navigateFromSearch = (href: string) => {
    closeSearch();
    if (window.location.hash !== href) window.location.hash = href;
  };

  useEffect(() => {
    if (!mobileOpen) return;
    const frame = window.requestAnimationFrame(() => mobileInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mobileOpen]);

  useEffect(() => {
    if (!desktopOpen && !mobileOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && searchRootRef.current?.contains(target)) return;

      setDesktopOpen(false);
      if (mobileOpen) {
        setQuery('');
        setMobileOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [desktopOpen, mobileOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!snapshot) return;
        if (window.matchMedia('(min-width: 768px)').matches) {
          setDesktopOpen(true);
          desktopInputRef.current?.focus();
        } else {
          setMobileOpen(true);
        }
      }
      if (event.key === 'Escape') closeSearch(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [snapshot]);

  return (
    <div ref={searchRootRef} className="contents">
      <div
        className="platform-search-desktop relative hidden w-full max-w-md md:block"
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setDesktopOpen(false);
        }}
      >
        <InlineSearchField
          inputRef={desktopInputRef}
          query={query}
          setQuery={setQuery}
          isDisabled={!snapshot}
          onFocus={() => setDesktopOpen(Boolean(snapshot))}
          showShortcut
        />
        {desktopOpen && snapshot && hasQuery && (
          <Surface
            variant="default"
            className="platform-search-popover absolute right-0 top-[calc(100%+.5rem)] z-50 w-full overflow-hidden rounded-2xl border border-border p-2 shadow-xl"
          >
            <SearchResults items={results} query={query} onNavigate={navigateFromSearch} />
          </Surface>
        )}
      </div>

      <Button
        variant="outline"
        size="md"
        isIconOnly
        className="md:hidden"
        aria-label={mobileOpen ? 'Fechar busca' : 'Buscar no Centro'}
        isDisabled={!snapshot}
        onPress={() => {
          if (mobileOpen) closeSearch();
          else setMobileOpen(true);
        }}
      >
        {mobileOpen ? <X /> : <Search />}
      </Button>

      {mobileOpen && snapshot && (
        <div className="platform-search-mobile-panel order-last basis-full md:hidden">
          <div className="flex items-center gap-2">
            <InlineSearchField
              inputRef={mobileInputRef}
              query={query}
              setQuery={setQuery}
              isDisabled={false}
              onFocus={() => setMobileOpen(true)}
            />
            <Button variant="ghost" size="sm" onPress={() => closeSearch()}>
              Cancelar
            </Button>
          </div>
          {hasQuery && (
            <Surface
              variant="default"
              className="mt-2 max-h-[min(60svh,28rem)] overflow-y-auto rounded-2xl border border-border p-2 shadow-xl"
            >
              <SearchResults items={results} query={query} onNavigate={navigateFromSearch} />
            </Surface>
          )}
        </div>
      )}
    </div>
  );
}
