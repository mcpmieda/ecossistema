import { useEffect, useRef, type KeyboardEvent } from 'react';
import { allowDraftNavigationV1 } from '../shared/forms/draft-navigation-v1';
import './section-links-v1.css';

/** Route links use the existing HeroUI tab styles, without claiming to own tab panels. */
export function SectionLinksV1({
  label,
  section,
  sections,
}: {
  readonly label: string;
  readonly section: string;
  readonly sections: readonly { id: string; label: string; href: string }[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  useEffect(() => {
    const container = scroller.current;
    const current = links.current.get(section);
    if (!container || !current) return;
    // Reveal only within the header scroller; do not scroll the workspace or move its focus.
    const viewport = container.getBoundingClientRect();
    const bounds = current.getBoundingClientRect();
    if (bounds.left < viewport.left) container.scrollLeft -= viewport.left - bounds.left;
    else if (bounds.right > viewport.right) container.scrollLeft += bounds.right - viewport.right;
  }, [label, section]);

  function moveFocus(event: KeyboardEvent<HTMLAnchorElement>, id: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = sections.findIndex((item) => item.id === id);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else if (event.key === 'ArrowRight') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + sections.length) % sections.length;
    else return;
    const target = sections[next];
    if (!target) return;
    event.preventDefault();
    links.current.get(target.id)?.focus();
  }

  return (
    <nav
      aria-label={label}
      className="tabs tabs--secondary shell-sections__tabs"
      data-orientation="horizontal"
    >
      <div ref={scroller} className="tabs__list-container overflow-x-auto">
        <div className="tabs__list" data-orientation="horizontal">
          {sections.map((item) => {
            const selected = item.id === section;
            return (
              <a
                key={item.id}
                ref={(element) => {
                  if (element) links.current.set(item.id, element);
                  else links.current.delete(item.id);
                }}
                href={item.href}
                aria-current={selected ? 'page' : undefined}
                data-selected={selected ? 'true' : undefined}
                className="tabs__tab no-underline"
                onClick={(event) => {
                  if (!allowDraftNavigationV1()) event.preventDefault();
                }}
                onKeyDown={(event) => moveFocus(event, item.id)}
              >
                {item.label}
                {selected && <span className="tabs__indicator" aria-hidden="true" />}
              </a>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
